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

export class SpeechToTextService {
  async transcribe({
    audioBuffer,
    language = "zh",
    task = "transcribe",
    timeoutMs,
    remoteConfig = {}
  } = {}) {
    if (!(audioBuffer instanceof Buffer) || audioBuffer.length === 0) {
      throw new Error("audioBuffer is required");
    }

    const token = String(remoteConfig?.cloudflareApiToken ?? "").trim();
    const accountId = String(remoteConfig?.cloudflareAccountId ?? "").trim();
    const model = String(remoteConfig?.cloudflareModel ?? "").trim() || DEFAULT_REMOTE_MODEL;
    const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs);

    if (!token) {
      throw new Error("sttCloudflareApiToken is required for cloud STT");
    }
    if (!accountId) {
      throw new Error("sttCloudflareAccountId is required for cloud STT");
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

      return {
        text: String(parsed?.result?.text ?? "").trim(),
        durationMs: Date.now() - startedAt,
        provider: "cloudflare",
        model
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
