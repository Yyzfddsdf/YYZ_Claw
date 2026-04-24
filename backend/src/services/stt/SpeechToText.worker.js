import { spawn } from "node:child_process";
import { parentPort } from "node:worker_threads";

import { pipeline, env } from "@huggingface/transformers";
import { decode } from "wav-decoder";

function normalizeTextOutput(output) {
  if (typeof output === "string") {
    return output;
  }

  if (output && typeof output === "object") {
    return String(output.text ?? "").trim();
  }

  return "";
}

function toSerializableError(error) {
  return String(error?.stack ?? error?.message ?? error ?? "stt worker failed");
}

function convertToMono16kWavBuffer(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "wav",
      "-ac",
      "1",
      "-ar",
      "16000",
      "pipe:1"
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.on("error", (error) => {
      if (String(error?.code ?? "").trim().toUpperCase() === "ENOENT") {
        reject(new Error("ffmpeg is not installed or not available in PATH"));
        return;
      }

      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderrText || `ffmpeg failed with exit code ${code}`));
        return;
      }

      resolve(Buffer.concat(stdoutChunks));
    });

    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(inputBuffer);
  });
}

let transcriberPromise = null;
let currentModel = "";
let currentCacheDir = "";
let processingChain = Promise.resolve();

function createInferenceOptions(language, task) {
  const options = {
    task: task === "translate" ? "translate" : "transcribe",
    return_timestamps: false
  };

  if (typeof language === "string" && language.trim()) {
    options.language = language.trim();
  }

  return options;
}

async function getTranscriber({ model, cacheDir }) {
  const nextModel = typeof model === "string" && model.trim() ? model.trim() : "Xenova/whisper-tiny";
  const nextCacheDir = typeof cacheDir === "string" && cacheDir.trim() ? cacheDir.trim() : "";

  if (!transcriberPromise || nextModel !== currentModel || nextCacheDir !== currentCacheDir) {
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    if (nextCacheDir) {
      env.cacheDir = nextCacheDir;
    }

    currentModel = nextModel;
    currentCacheDir = nextCacheDir;
    transcriberPromise = pipeline("automatic-speech-recognition", nextModel);
  }

  return transcriberPromise;
}

async function transcribeRequest(payload = {}) {
  const startedAt = Date.now();
  const {
    audioBuffer,
    model,
    language,
    task,
    cacheDir
  } = payload;

  if (!(audioBuffer instanceof Uint8Array) || audioBuffer.byteLength <= 0) {
    throw new Error("audio buffer is required");
  }

  const inputBuffer = Buffer.from(audioBuffer);
  const wavBuffer = await convertToMono16kWavBuffer(inputBuffer);
  const decoded = await decode(wavBuffer);
  const monoAudio = decoded?.channelData?.[0];
  if (!(monoAudio instanceof Float32Array) || monoAudio.length === 0) {
    throw new Error("failed to decode converted wav audio");
  }

  const transcriber = await getTranscriber({ model, cacheDir });
  const rawOutput = await transcriber(monoAudio, createInferenceOptions(language, task));
  const text = normalizeTextOutput(rawOutput);

  return {
    text,
    durationMs: Date.now() - startedAt
  };
}

if (parentPort) {
  parentPort.on("message", (message = {}) => {
    const requestId = String(message?.requestId ?? "").trim();
    if (!requestId || String(message?.type ?? "") !== "transcribe") {
      return;
    }

    processingChain = processingChain
      .then(async () => {
        try {
          const result = await transcribeRequest(message?.payload ?? {});
          parentPort.postMessage({
            type: "result",
            requestId,
            ok: true,
            result
          });
        } catch (error) {
          parentPort.postMessage({
            type: "result",
            requestId,
            ok: false,
            error: toSerializableError(error)
          });
        }
      })
      .catch(() => {});
  });
}
