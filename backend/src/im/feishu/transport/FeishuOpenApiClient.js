import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_MAX_REPLY_CHARS = 3_000;
const DEFAULT_UPLOAD_MIME_TYPE = "application/octet-stream";
const FEISHU_AUDIO_PREPEND_SILENCE_MS = 350;

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

function normalizeAudioInput(audio = {}) {
  const normalized = audio && typeof audio === "object" && !Array.isArray(audio) ? audio : {};
  const filePath = String(normalized.filePath ?? "").trim();
  const fileName = String(normalized.fileName ?? "").trim();
  const mimeType = String(normalized.mimeType ?? "").trim() || "audio/ogg";
  const durationMs = Math.max(0, toInteger(normalized.durationMs, 0));
  const buffer =
    normalized.buffer instanceof Uint8Array
      ? Buffer.from(normalized.buffer)
      : Buffer.isBuffer(normalized.buffer)
        ? normalized.buffer
        : null;
  return {
    filePath,
    fileName,
    mimeType,
    durationMs,
    buffer
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

function isLikelyAudioFile(file = {}) {
  const mimeType = String(file?.mimeType ?? "").trim().toLowerCase();
  if (mimeType.startsWith("audio/")) {
    return true;
  }

  const fileName = String(file?.fileName ?? "").trim();
  const filePath = String(file?.filePath ?? "").trim();
  const extension = path.extname(fileName || filePath).toLowerCase();
  return [".opus", ".ogg", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".webm"].includes(extension);
}

function replaceExt(fileName, nextExt) {
  const normalized = String(fileName ?? "").trim();
  const ext = String(nextExt ?? "").trim();
  if (!normalized) {
    return `audio_${Date.now()}${ext}`;
  }
  const base = normalized.replace(/\.[^/.]+$/, "");
  return `${base}${ext}`;
}

async function convertAudioBufferToOpusOgg(inputBuffer) {
  const source = Buffer.isBuffer(inputBuffer)
    ? inputBuffer
    : inputBuffer instanceof Uint8Array
      ? Buffer.from(inputBuffer)
      : null;

  if (!source || source.length <= 0) {
    throw new Error("audio source buffer is empty");
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      `adelay=${FEISHU_AUDIO_PREPEND_SILENCE_MS}`,
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1"
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`ffmpeg unavailable: ${String(error?.message ?? error)}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(detail || `ffmpeg exited with code ${code}`));
        return;
      }

      const output = Buffer.concat(stdoutChunks);
      if (output.length <= 0) {
        reject(new Error("ffmpeg returned empty opus audio"));
        return;
      }

      resolve(output);
    });

    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(source);
  });
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

  async sendAudioToChat({ chatId, fileKey }) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedFileKey = String(fileKey ?? "").trim();
    if (!normalizedChatId) {
      throw buildApiError("chatId is required for sendAudioToChat");
    }
    if (!normalizedFileKey) {
      throw buildApiError("fileKey is required for sendAudioToChat");
    }

    await this.requestJson("/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      body: {
        receive_id: normalizedChatId,
        msg_type: "audio",
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

  async uploadAudio({ filePath, fileName, mimeType, durationMs = 0, buffer = null }) {
    const normalizedPath = String(filePath ?? "").trim();
    const inlineBuffer =
      Buffer.isBuffer(buffer) ? buffer : buffer instanceof Uint8Array ? Buffer.from(buffer) : null;
    let payloadBuffer = inlineBuffer;
    let resolvedPath = "";

    if (!payloadBuffer) {
      if (!normalizedPath) {
        throw buildApiError("filePath or buffer is required for uploadAudio");
      }
      resolvedPath = path.resolve(normalizedPath);
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        throw buildApiError("uploadAudio requires a valid file path");
      }
      payloadBuffer = await fs.readFile(resolvedPath);
    }

    if (!payloadBuffer || payloadBuffer.length <= 0) {
      throw buildApiError("uploadAudio source is empty");
    }

    const originalFileName =
      String(fileName ?? "").trim() || (resolvedPath ? path.basename(resolvedPath) : `audio_${Date.now()}.mp3`);
    const normalizedMimeType = String(mimeType ?? "").trim() || "audio/mpeg";
    const normalizedDurationMs = Math.max(0, toInteger(durationMs, 0));

    const opusPayloadBuffer = await convertAudioBufferToOpusOgg(payloadBuffer);
    const normalizedFileName = replaceExt(originalFileName, ".opus");
    const uploadMimeType = "audio/ogg";

    const form = new FormData();
    form.append("file_type", "opus");
    form.append("file_name", normalizedFileName);
    if (normalizedDurationMs > 0) {
      form.append("duration", String(normalizedDurationMs));
    }
    form.append("file", new Blob([opusPayloadBuffer], { type: uploadMimeType }), normalizedFileName);

    const payload = await this.requestJson("/im/v1/files", {
      method: "POST",
      body: form
    });

    const fileKey = String(payload?.data?.file_key ?? "").trim();
    if (!fileKey) {
      throw buildApiError("飞书音频上传成功但未返回 file_key");
    }

    return {
      fileKey,
      fileName: normalizedFileName,
      size: Number(opusPayloadBuffer.length),
      mimeType: uploadMimeType,
      durationMs: normalizedDurationMs
    };
  }

  async replyAudio({ messageId, fileKey }) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedFileKey = String(fileKey ?? "").trim();
    if (!normalizedMessageId) {
      throw buildApiError("messageId is required for replyAudio");
    }
    if (!normalizedFileKey) {
      throw buildApiError("fileKey is required for replyAudio");
    }

    await this.requestJson(`/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reply`, {
      method: "POST",
      body: {
        msg_type: "audio",
        content: JSON.stringify({ file_key: normalizedFileKey })
      }
    });
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

  async sendAudio({ target, audio, caption = "" }) {
    const normalizedTarget = normalizeFileSendTarget(target);
    if (!normalizedTarget.messageId && !normalizedTarget.chatId && !normalizedTarget.userId) {
      throw buildApiError("sendAudio requires target.messageId/chatId/userId");
    }
    if (normalizedTarget.userId && !normalizedTarget.chatId && !normalizedTarget.messageId) {
      throw buildApiError("当前飞书 sendAudio 仅支持 messageId 或 chatId 目标");
    }

    const normalizedAudio = normalizeAudioInput(audio);
    if (!normalizedAudio.filePath && !normalizedAudio.buffer) {
      throw buildApiError("sendAudio requires audio.filePath or audio.buffer");
    }
    if (!normalizedAudio.buffer && !isLikelyAudioFile(normalizedAudio)) {
      throw buildApiError("sendAudio requires an audio file");
    }

    const uploadResult = await this.uploadAudio(normalizedAudio);
    if (normalizedTarget.messageId) {
      await this.replyAudio({
        messageId: normalizedTarget.messageId,
        fileKey: uploadResult.fileKey
      });
    } else if (normalizedTarget.chatId) {
      await this.sendAudioToChat({
        chatId: normalizedTarget.chatId,
        fileKey: uploadResult.fileKey
      });
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
      msgType: "audio",
      file: {
        fileName: uploadResult.fileName,
        mimeType: uploadResult.mimeType,
        size: uploadResult.size,
        fileKey: uploadResult.fileKey,
        durationMs: uploadResult.durationMs
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

  async sendMessage({ target, file, audio, text }) {
    const normalizedText = normalizeTextInput(text);
    const hasFile =
      file && typeof file === "object" && !Array.isArray(file) && String(file.filePath ?? "").trim();
    const hasAudio =
      Boolean(
        audio &&
          typeof audio === "object" &&
          !Array.isArray(audio) &&
          (
            String(audio.filePath ?? "").trim() ||
            (Buffer.isBuffer(audio.buffer)
              ? audio.buffer.length > 0
              : audio.buffer instanceof Uint8Array
                ? audio.buffer.length > 0
                : false)
          )
      );

    if (hasAudio) {
      return this.sendAudio({
        target,
        audio,
        caption: normalizedText
      });
    }

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
