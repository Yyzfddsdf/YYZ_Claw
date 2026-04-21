const DEFAULT_FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_MAX_REPLY_CHARS = 3_000;

function trimTrailingSlash(input) {
  return String(input ?? "").trim().replace(/\/+$/, "");
}

function normalizeBaseUrl(input) {
  const candidate = trimTrailingSlash(input);
  return candidate || DEFAULT_FEISHU_OPEN_API_BASE_URL;
}

function buildApiError(message, details = {}) {
  const error = new Error(String(message ?? "feishu api request failed"));
  if (details && typeof details === "object" && !Array.isArray(details)) {
    Object.assign(error, details);
  }
  return error;
}

function parseJsonText(text) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function splitTextForFeishu(input, maxChars) {
  const normalized = String(input ?? "").trim();
  if (!normalized) {
    return [];
  }

  const limit = Math.max(1, toInteger(maxChars, DEFAULT_MAX_REPLY_CHARS));
  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks = [];
  let offset = 0;
  while (offset < normalized.length) {
    const hardEnd = Math.min(normalized.length, offset + limit);
    let end = hardEnd;

    if (hardEnd < normalized.length) {
      const window = normalized.slice(offset, hardEnd);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
      if (breakAt > Math.floor(limit * 0.4)) {
        end = offset + breakAt;
      }
    }

    const chunk = normalized.slice(offset, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    offset = Math.max(offset + 1, end);
  }

  return chunks.length > 0 ? chunks : [normalized];
}

function parseFilenameFromContentDisposition(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim();
    } catch {
      return utf8Match[1].trim();
    }
  }

  const quotedMatch = text.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const plainMatch = text.match(/filename=([^;]+)/i);
  return plainMatch?.[1] ? plainMatch[1].trim() : "";
}

export class FeishuOpenApiClient {
  constructor(options = {}) {
    this.configStore = options.configStore ?? null;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.requestTimeoutMs = Math.max(1000, toInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
    this.tokenRefreshSkewMs = Math.max(
      1_000,
      toInteger(options.tokenRefreshSkewMs, DEFAULT_TOKEN_REFRESH_SKEW_MS)
    );
    this.maxReplyChars = Math.max(500, toInteger(options.maxReplyChars, DEFAULT_MAX_REPLY_CHARS));

    this.tokenCache = {
      value: "",
      expiresAt: 0
    };
    this.tokenRefreshPromise = null;
  }

  clearTokenCache() {
    this.tokenCache = {
      value: "",
      expiresAt: 0
    };
  }

  async getTenantAccessToken(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const now = Date.now();
    if (!forceRefresh && this.tokenCache.value && now + this.tokenRefreshSkewMs < this.tokenCache.expiresAt) {
      return this.tokenCache.value;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = this.fetchTenantAccessToken().finally(() => {
      this.tokenRefreshPromise = null;
    });
    return this.tokenRefreshPromise;
  }

  async fetchTenantAccessToken() {
    if (!this.configStore || typeof this.configStore.read !== "function") {
      throw buildApiError("feishu config store is unavailable");
    }

    const config = await this.configStore.read();
    const appId = String(config?.appId ?? "").trim();
    const appSecret = String(config?.appSecret ?? "").trim();
    if (!appId || !appSecret) {
      throw buildApiError("飞书配置缺少 appId 或 appSecret");
    }

    const payload = await this.requestJson("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: {
        app_id: appId,
        app_secret: appSecret
      },
      skipAuth: true
    });

    const token = String(payload?.tenant_access_token ?? "").trim();
    if (!token) {
      throw buildApiError("飞书 tenant_access_token 返回为空");
    }

    const expiresInSec = Math.max(60, toInteger(payload?.expire, 7_200));
    this.tokenCache = {
      value: token,
      expiresAt: Date.now() + expiresInSec * 1000
    };
    return token;
  }

  async replyText({ messageId, text }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedText = String(text ?? "").trim();
    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for replyText");
    }
    if (!normalizedText) {
      return;
    }

    await this.requestJson(`/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reply`, {
      method: "POST",
      body: {
        msg_type: "text",
        content: JSON.stringify({ text: normalizedText })
      }
    });
  }

  async replyTextInChunks({ messageId, text }) {
    const chunks = splitTextForFeishu(text, this.maxReplyChars);
    for (const chunk of chunks) {
      await this.replyText({
        messageId,
        text: chunk
      });
    }
  }

  async downloadMessageResource({ messageId, fileKey, type }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedFileKey = String(fileKey ?? "").trim();
    const normalizedType = String(type ?? "").trim() || "file";

    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for downloadMessageResource");
    }
    if (!normalizedFileKey) {
      throw buildApiError("fileKey is required for downloadMessageResource");
    }

    const accessToken = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/im/v1/messages/${encodeURIComponent(
      normalizedMessageId
    )}/resources/${encodeURIComponent(normalizedFileKey)}?type=${encodeURIComponent(normalizedType)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        const payload = parseJsonText(text);
        throw buildApiError("飞书资源下载失败", {
          statusCode: response.status,
          feishuCode: Number(payload?.code ?? -1),
          feishuMsg: String(payload?.msg ?? text ?? "").trim()
        });
      }

      const contentTypeHeader = String(response.headers.get("content-type") ?? "").trim();
      if (contentTypeHeader.toLowerCase().includes("application/json")) {
        const payload = parseJsonText(await response.text());
        throw buildApiError("飞书资源下载返回 JSON，未获取到二进制资源", {
          statusCode: response.status,
          feishuCode: Number(payload?.code ?? -1),
          feishuMsg: String(payload?.msg ?? "").trim()
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const filename = parseFilenameFromContentDisposition(response.headers.get("content-disposition"));
      const mimeType = contentTypeHeader.split(";")[0].trim();

      return {
        buffer,
        size: buffer.length,
        mimeType: mimeType || "application/octet-stream",
        filename
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw buildApiError("飞书资源下载超时");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async requestJson(pathname, options = {}) {
    const normalizedPath = `/${String(pathname ?? "").trim().replace(/^\/+/, "")}`;
    const method = String(options.method ?? "GET").trim().toUpperCase() || "GET";
    const skipAuth = Boolean(options.skipAuth);

    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
        ? options.headers
        : {})
    };

    if (!skipAuth) {
      const token = await this.getTenantAccessToken();
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${normalizedPath}`, {
        method,
        headers,
        body:
          options.body === undefined
            ? undefined
            : typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        signal: controller.signal
      });

      const text = await response.text();
      const payload = parseJsonText(text);
      if (!response.ok) {
        throw buildApiError("飞书接口请求失败", {
          statusCode: response.status,
          feishuCode: Number(payload?.code ?? -1),
          feishuMsg: String(payload?.msg ?? text ?? "").trim()
        });
      }

      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const code = Number(payload.code ?? 0);
        if (Number.isFinite(code) && code !== 0) {
          throw buildApiError("飞书接口返回业务错误", {
            statusCode: response.status,
            feishuCode: code,
            feishuMsg: String(payload.msg ?? "").trim()
          });
        }
        return payload;
      }

      return {};
    } catch (error) {
      if (error?.name === "AbortError") {
        throw buildApiError("飞书接口请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
