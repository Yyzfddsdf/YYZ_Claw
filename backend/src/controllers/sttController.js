import { sttTranscribeRequestSchema } from "../schemas/sttSchema.js";

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeSttProvider(config) {
  const provider = String(config?.sttProvider ?? "").trim().toLowerCase();
  return provider === "cloudflare" ? "cloudflare" : "local";
}

export function createSttController({ speechToTextService, configStore }) {
  function parseOptions(payload) {
    const parseResult = sttTranscribeRequestSchema.safeParse(payload ?? {});
    if (!parseResult.success) {
      const detail = parseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      throw createValidationError(detail || "invalid stt request");
    }

    return parseResult.data;
  }

  async function runTranscribe(res, options, audioBuffer, fileMeta = null) {
    const runtimeConfig = configStore && typeof configStore.read === "function"
      ? await configStore.read()
      : {};
    const provider = normalizeSttProvider(runtimeConfig);
    const result = await speechToTextService.transcribe({
      audioBuffer,
      language: options.language,
      task: options.task,
      timeoutMs: options.timeoutMs,
      provider,
      remoteConfig: {
        cloudflareApiToken: String(runtimeConfig?.sttCloudflareApiToken ?? "").trim(),
        cloudflareAccountId: String(runtimeConfig?.sttCloudflareAccountId ?? "").trim(),
        cloudflareModel: String(runtimeConfig?.sttCloudflareModel ?? "").trim()
      }
    });

    res.json({
      text: String(result?.text ?? "").trim(),
      durationMs: Number(result?.durationMs ?? 0),
      provider: String(result?.provider ?? provider).trim() || "local",
      model: String(result?.model ?? "").trim(),
      language: options.language,
      task: options.task,
      ...(fileMeta ? { file: fileMeta } : {})
    });
  }

  return {
    transcribe: async (req, res) => {
      if (!speechToTextService || typeof speechToTextService.transcribe !== "function") {
        throw createValidationError("speechToTextService is not available");
      }

      const file = req.file;
      if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw createValidationError("audio file is required (multipart field: file)");
      }

      const options = parseOptions(req.body ?? {});
      await runTranscribe(res, options, file.buffer, {
        name: String(file.originalname ?? "").trim(),
        mimeType: String(file.mimetype ?? "").trim(),
        size: Number(file.size ?? 0)
      });
    },

    transcribeRaw: async (req, res) => {
      if (!speechToTextService || typeof speechToTextService.transcribe !== "function") {
        throw createValidationError("speechToTextService is not available");
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw createValidationError("raw audio bytes are required in request body");
      }

      const options = parseOptions(req.query ?? {});
      await runTranscribe(res, options, req.body, {
        name: "raw-audio",
        mimeType: String(req.headers["content-type"] ?? "").trim(),
        size: Number(req.body.length ?? 0)
      });
    }
  };
}
