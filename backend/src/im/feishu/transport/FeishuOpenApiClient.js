import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_MAX_REPLY_CHARS = 3_000;
const DEFAULT_UPLOAD_MIME_TYPE = "application/octet-stream";

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

function normalizeFileSendTarget(target = {}) {
  const normalized = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  const messageId = String(normalized.messageId ?? normalized.message_id ?? "").trim();
  const chatId = String(normalized.chatId ?? normalized.chat_id ?? "").trim();
  const userId = String(normalized.userId ?? normalized.user_id ?? "").trim();
  return {
    messageId,
    chatId,
    userId
  };
}

function normalizeFileInput(file = {}) {
  const normalized = file && typeof file === "object" && !Array.isArray(file) ? file : {};
  const filePath = String(normalized.filePath ?? "").trim();
  const fileName = String(normalized.fileName ?? "").trim();
  const mimeType = String(normalized.mimeType ?? "").trim() || DEFAULT_UPLOAD_MIME_TYPE;
  return {
    filePath,
    fileName,
    mimeType
  };
}

function normalizeTextInput(value) {
  return String(value ?? "").trim();
}

function buildInteractiveContentFromText(text) {
  const normalizedText = normalizeTextInput(text);
  return {
    config: {
      wide_screen_mode: true
    },
    elements: [
      {
        tag: "markdown",
        content: normalizedText || " "
      }
    ]
  };
}

function isLikelyImageFile(file = {}) {
  const mimeType = String(file?.mimeType ?? "").trim().toLowerCase();
  if (mimeType.startsWith("image/")) {
    return true;
  }

  const fileName = String(file?.fileName ?? "").trim();
  const filePath = String(file?.filePath ?? "").trim();
  const extension = path.extname(fileName || filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".heic", ".heif"].includes(extension);
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
    await this.replyInteractive({
      messageId: normalizedMessageId,
      text: normalizedText
    });
  }

  async replyTextInChunks({ messageId, text }) {
    const chunks = splitTextForFeishu(text, this.maxReplyChars);
    for (const chunk of chunks) {
      await this.replyInteractive({
        messageId,
        text: chunk
      });
    }
  }

  async replyFile({ messageId, fileKey }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedFileKey = String(fileKey ?? "").trim();
    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for replyFile");
    }
    if (!normalizedFileKey) {
      throw buildApiError("fileKey is required for replyFile");
    }

    await this.requestJson(`/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reply`, {
      method: "POST",
      body: {
        msg_type: "file",
        content: JSON.stringify({ file_key: normalizedFileKey })
      }
    });
  }

  async replyImage({ messageId, imageKey }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedImageKey = String(imageKey ?? "").trim();
    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for replyImage");
    }
    if (!normalizedImageKey) {
      throw buildApiError("imageKey is required for replyImage");
    }

    await this.requestJson(`/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reply`, {
      method: "POST",
      body: {
        msg_type: "image",
        content: JSON.stringify({ image_key: normalizedImageKey })
      }
    });
  }

  async replyInteractive({ messageId, text }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedText = normalizeTextInput(text);
    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for replyInteractive");
    }
    if (!normalizedText) {
      return;
    }

    await this.requestJson(`/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reply`, {
      method: "POST",
      body: {
        msg_type: "interactive",
        content: JSON.stringify(buildInteractiveContentFromText(normalizedText))
      }
    });
  }

  async sendFileToChat({ chatId, fileKey }) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedFileKey = String(fileKey ?? "").trim();
    if (!normalizedChatId) {
      throw buildApiError("chatId is required for sendFileToChat");
    }
    if (!normalizedFileKey) {
      throw buildApiError("fileKey is required for sendFileToChat");
    }

    await this.requestJson("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      body: {
        receive_id: normalizedChatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: normalizedFileKey })
      }
    });
  }

  async sendImageToChat({ chatId, imageKey }) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedImageKey = String(imageKey ?? "").trim();
    if (!normalizedChatId) {
      throw buildApiError("chatId is required for sendImageToChat");
    }
    if (!normalizedImageKey) {
      throw buildApiError("imageKey is required for sendImageToChat");
    }

    await this.requestJson("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      body: {
        receive_id: normalizedChatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: normalizedImageKey })
      }
    });
  }

  async sendTextToChat({ chatId, text }) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedText = normalizeTextInput(text);
    if (!normalizedChatId) {
      throw buildApiError("chatId is required for sendTextToChat");
    }
    if (!normalizedText) {
      return;
    }

    await this.requestJson("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      body: {
        receive_id: normalizedChatId,
        msg_type: "text",
        content: JSON.stringify({ text: normalizedText })
      }
    });
  }

  async sendInteractiveToChat({ chatId, text }) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedText = normalizeTextInput(text);
    if (!normalizedChatId) {
      throw buildApiError("chatId is required for sendInteractiveToChat");
    }
    if (!normalizedText) {
      return;
    }

    await this.requestJson("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      body: {
        receive_id: normalizedChatId,
        msg_type: "interactive",
        content: JSON.stringify(buildInteractiveContentFromText(normalizedText))
      }
    });
  }

  async uploadFile({ filePath, fileName, mimeType }) {
    const normalizedPath = String(filePath ?? "").trim();
    if (!normalizedPath) {
      throw buildApiError("filePath is required for uploadFile");
    }

    const resolvedPath = path.resolve(normalizedPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw buildApiError("uploadFile requires a valid file path");
    }

    const payloadBuffer = await fs.readFile(resolvedPath);
    if (!payloadBuffer || payloadBuffer.length <= 0) {
      throw buildApiError("uploadFile source is empty");
    }

    const normalizedFileName = String(fileName ?? "").trim() || path.basename(resolvedPath);
    const normalizedMimeType = String(mimeType ?? "").trim() || DEFAULT_UPLOAD_MIME_TYPE;
    const form = new FormData();
    form.append("file_type", "stream");
    form.append("file_name", normalizedFileName);
    form.append("file", new Blob([payloadBuffer], { type: normalizedMimeType }), normalizedFileName);

    const payload = await this.requestJson("/im/v1/files", {
      method: "POST",
      body: form
    });

    const fileKey = String(payload?.data?.file_key ?? "").trim();
    if (!fileKey) {
      throw buildApiError("飞书文件上传成功但未返回 file_key");
    }

    return {
      fileKey,
      fileName: normalizedFileName,
      size: Number(payloadBuffer.length),
      mimeType: normalizedMimeType
    };
  }

  async uploadImage({ filePath, fileName, mimeType }) {
    const normalizedPath = String(filePath ?? "").trim();
    if (!normalizedPath) {
      throw buildApiError("filePath is required for uploadImage");
    }

    const resolvedPath = path.resolve(normalizedPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw buildApiError("uploadImage requires a valid file path");
    }

    const payloadBuffer = await fs.readFile(resolvedPath);
    if (!payloadBuffer || payloadBuffer.length <= 0) {
      throw buildApiError("uploadImage source is empty");
    }

    const normalizedFileName = String(fileName ?? "").trim() || path.basename(resolvedPath);
    const normalizedMimeType = String(mimeType ?? "").trim() || "image/png";
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([payloadBuffer], { type: normalizedMimeType }), normalizedFileName);

    const payload = await this.requestJson("/im/v1/images", {
      method: "POST",
      body: form
    });

    const imageKey = String(payload?.data?.image_key ?? "").trim();
    if (!imageKey) {
      throw buildApiError("飞书图片上传成功但未返回 image_key");
    }

    return {
      imageKey,
      fileName: normalizedFileName,
      size: Number(payloadBuffer.length),
      mimeType: normalizedMimeType
    };
  }

  async sendFile({ target, file, caption = "" }) {
    const normalizedTarget = normalizeFileSendTarget(target);
    if (!normalizedTarget.messageId && !normalizedTarget.chatId && !normalizedTarget.userId) {
      throw buildApiError("sendFile requires target.messageId/chatId/userId");
    }

    if (normalizedTarget.userId && !normalizedTarget.chatId && !normalizedTarget.messageId) {
      throw buildApiError("当前飞书 sendFile 仅支持 messageId 或 chatId 目标");
    }

    const normalizedFile = normalizeFileInput(file);
    if (!normalizedFile.filePath) {
      throw buildApiError("sendFile requires file.filePath");
    }

    const sendAsImage = isLikelyImageFile(normalizedFile);
    let uploadResult = null;
    if (sendAsImage) {
      uploadResult = await this.uploadImage(normalizedFile);
      if (normalizedTarget.messageId) {
        await this.replyImage({
          messageId: normalizedTarget.messageId,
          imageKey: uploadResult.imageKey
        });
      } else if (normalizedTarget.chatId) {
        await this.sendImageToChat({
          chatId: normalizedTarget.chatId,
          imageKey: uploadResult.imageKey
        });
      }
    } else {
      uploadResult = await this.uploadFile(normalizedFile);
      if (normalizedTarget.messageId) {
        await this.replyFile({
          messageId: normalizedTarget.messageId,
          fileKey: uploadResult.fileKey
        });
      } else if (normalizedTarget.chatId) {
        await this.sendFileToChat({
          chatId: normalizedTarget.chatId,
          fileKey: uploadResult.fileKey
        });
      }
    }

    const normalizedCaption = String(caption ?? "").trim();
    if (normalizedCaption) {
      await this.sendText({
        target: normalizedTarget,
        text: normalizedCaption
      });
    }

    return {
      ok: true,
      target: normalizedTarget,
      msgType: sendAsImage ? "image" : "file",
      file: sendAsImage
        ? {
            fileName: uploadResult.fileName,
            mimeType: uploadResult.mimeType,
            size: uploadResult.size,
            imageKey: uploadResult.imageKey
          }
        : {
            fileName: uploadResult.fileName,
            mimeType: uploadResult.mimeType,
            size: uploadResult.size,
            fileKey: uploadResult.fileKey
          }
    };
  }

  async sendText({ target, text }) {
    const normalizedTarget = normalizeFileSendTarget(target);
    const normalizedText = normalizeTextInput(text);
    if (!normalizedTarget.messageId && !normalizedTarget.chatId && !normalizedTarget.userId) {
      throw buildApiError("sendText requires target.messageId/chatId/userId");
    }
    if (!normalizedText) {
      return {
        ok: true,
        target: normalizedTarget
      };
    }

    if (normalizedTarget.userId && !normalizedTarget.chatId && !normalizedTarget.messageId) {
      throw buildApiError("当前飞书 sendText 仅支持 messageId 或 chatId 目标");
    }

    if (normalizedTarget.messageId) {
      await this.replyInteractive({
        messageId: normalizedTarget.messageId,
        text: normalizedText
      });
    } else if (normalizedTarget.chatId) {
      await this.sendInteractiveToChat({
        chatId: normalizedTarget.chatId,
        text: normalizedText
      });
    }

    return {
      ok: true,
      target: normalizedTarget,
      msgType: "interactive"
    };
  }

  async sendMessage({ target, file, text }) {
    const normalizedText = normalizeTextInput(text);
    const hasFile =
      file && typeof file === "object" && !Array.isArray(file) && String(file.filePath ?? "").trim();

    if (hasFile) {
      return this.sendFile({
        target,
        file,
        caption: normalizedText
      });
    }

    return this.sendText({
      target,
      text: normalizedText
    });
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
      ...(options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
        ? options.headers
        : {})
    };

    const isFormBody =
      typeof FormData !== "undefined" && options.body instanceof FormData;
    if (!isFormBody) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

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
            : isFormBody
              ? options.body
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
