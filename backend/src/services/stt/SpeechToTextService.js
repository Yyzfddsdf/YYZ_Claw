import path from "node:path";
import { Worker } from "node:worker_threads";

const DEFAULT_MODEL = "Xenova/whisper-tiny";
const DEFAULT_REMOTE_MODEL = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_TIMEOUT_MS = 240000;

function normalizeTimeoutMs(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }

  const normalized = Math.trunc(value);
  if (normalized < 5000) {
    return 5000;
  }

  return Math.min(normalized, 1800000);
}

function normalizeProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "cloudflare" ? "cloudflare" : "local";
}

export class SpeechToTextService {
  constructor(options = {}) {
    const resolvedCacheDir = String(options.cacheDir ?? "").trim();
    this.cacheDir = resolvedCacheDir
      ? path.resolve(resolvedCacheDir)
      : path.resolve(process.cwd(), "models", "onnx");
    this.worker = null;
    this.pendingRequests = new Map();
  }

  async transcribeRemoteCloudflare({
    audioBuffer,
    language = "zh",
    task = "transcribe",
    timeoutMs,
    cloudflareApiToken,
    cloudflareAccountId,
    cloudflareModel
  } = {}) {
    const token = String(cloudflareApiToken ?? "").trim();
    const accountId = String(cloudflareAccountId ?? "").trim();
    const model = String(cloudflareModel ?? "").trim() || DEFAULT_REMOTE_MODEL;
    const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs);

    if (!token) {
      throw new Error("sttCloudflareApiToken is required when sttProvider=cloudflare");
    }
    if (!accountId) {
      throw new Error("sttCloudflareAccountId is required when sttProvider=cloudflare");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
    const startedAt = Date.now();

    try {
      const payload = {
        audio: audioBuffer.toString("base64"),
        language: String(language ?? "zh").trim() || "zh",
        task: task === "translate" ? "translate" : "transcribe"
      };

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      const raw = await response.text();
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }

      if (!response.ok || parsed?.success === false) {
        const apiErrorMessage = Array.isArray(parsed?.errors)
          ? String(parsed.errors?.[0]?.message ?? "").trim()
          : "";
        throw new Error(apiErrorMessage || `cloudflare stt failed with ${response.status}`);
      }

      const text = String(parsed?.result?.text ?? "").trim();
      return {
        text,
        durationMs: Date.now() - startedAt,
        provider: "cloudflare",
        model
      };
    } finally {
      clearTimeout(timer);
    }
  }

  ensureWorker() {
    if (this.worker) {
      return this.worker;
    }

    const workerPath = new URL("./SpeechToText.worker.js", import.meta.url);
    this.worker = new Worker(workerPath);

    this.worker.on("message", (message = {}) => {
      if (String(message?.type ?? "") !== "result") {
        return;
      }

      const requestId = String(message?.requestId ?? "").trim();
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);

      if (message?.ok === false) {
        pending.reject(new Error(String(message?.error ?? "stt worker failed")));
        return;
      }

      pending.resolve({
        provider: "local",
        model: DEFAULT_MODEL,
        ...(message?.result ?? { text: "", durationMs: 0 })
      });
    });

    this.worker.on("error", (error) => {
      const pendingItems = Array.from(this.pendingRequests.values());
      this.pendingRequests.clear();
      for (const pending of pendingItems) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.worker = null;
    });

    this.worker.on("exit", (code) => {
      if (code === 0) {
        this.worker = null;
        return;
      }

      const pendingItems = Array.from(this.pendingRequests.values());
      this.pendingRequests.clear();
      for (const pending of pendingItems) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`stt worker exited unexpectedly with code ${code}`));
      }
      this.worker = null;
    });

    return this.worker;
  }

  async transcribe({
    audioBuffer,
    language = "zh",
    task = "transcribe",
    timeoutMs,
    provider = "local",
    remoteConfig = {}
  } = {}) {
    if (!(audioBuffer instanceof Buffer) || audioBuffer.length === 0) {
      throw new Error("audioBuffer is required");
    }

    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === "cloudflare") {
      return this.transcribeRemoteCloudflare({
        audioBuffer,
        language,
        task,
        timeoutMs,
        cloudflareApiToken: remoteConfig?.cloudflareApiToken,
        cloudflareAccountId: remoteConfig?.cloudflareAccountId,
        cloudflareModel: remoteConfig?.cloudflareModel
      });
    }

    const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs);
    const worker = this.ensureWorker();
    const requestId = `stt_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`stt timed out after ${resolvedTimeoutMs}ms`));
      }, resolvedTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timer
      });

      worker.postMessage({
        type: "transcribe",
        requestId,
        payload: {
          audioBuffer: new Uint8Array(audioBuffer),
          model: DEFAULT_MODEL,
          language: String(language ?? "zh").trim(),
          task: task === "translate" ? "translate" : "transcribe",
          cacheDir: this.cacheDir
        }
      });
    });
  }
}
