import path from "node:path";

const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 40 * 1024 * 1024;

function sanitizeFileName(value, fallback) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return fallback;
  }

  const sanitized = normalized.replace(/[\\/:*?"<>|]/g, "_").trim();
  return sanitized || fallback;
}

function toDataUrl(buffer, mimeType) {
  const normalizedMimeType = String(mimeType ?? "").trim() || "application/octet-stream";
  return `data:${normalizedMimeType};base64,${buffer.toString("base64")}`;
}

function normalizeParseFailedResult({ id, name, extension = "", note }) {
  return {
    id,
    name,
    mimeType: "",
    extension,
    size: 0,
    parseStatus: "failed",
    note: String(note ?? "").trim(),
    extractedText: ""
  };
}

export class RemoteAttachmentResolver {
  constructor(options = {}) {
    this.resourceClient = options.resourceClient ?? null;
    this.attachmentParserService = options.attachmentParserService ?? null;
    this.maxImageBytes = Math.max(64 * 1024, Number(options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES));
    this.maxFileBytes = Math.max(128 * 1024, Number(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  }

  async resolveImageAttachment({ messageId, resourceKey, resourceType = "image", nameHint = "" }) {
    const normalizedKey = String(resourceKey ?? "").trim();
    if (!normalizedKey) {
      return {
        attachment: null,
        note: "图片消息缺少资源 key，已跳过图片下载。"
      };
    }

    if (!this.resourceClient || typeof this.resourceClient.downloadMessageResource !== "function") {
      return {
        attachment: null,
        note: "图片消息未启用资源下载能力。"
      };
    }

    try {
      const resource = await this.resourceClient.downloadMessageResource({
        messageId,
        fileKey: normalizedKey,
        type: resourceType
      });
      if (resource.size > this.maxImageBytes) {
        return {
          attachment: null,
          note: `图片超过限制(${this.maxImageBytes} bytes)，已跳过。`
        };
      }

      const mimeType = String(resource.mimeType ?? "").trim() || "image/png";
      const fallbackName = String(nameHint ?? "").trim() || `image_${normalizedKey}`;
      return {
        attachment: {
          id: normalizedKey,
          name: sanitizeFileName(resource.filename, fallbackName),
          mimeType,
          dataUrl: toDataUrl(resource.buffer, mimeType),
          size: Number(resource.size ?? resource.buffer?.length ?? 0)
        },
        note: ""
      };
    } catch (error) {
      return {
        attachment: null,
        note: `图片下载失败: ${String(error?.message ?? "unknown error")}`
      };
    }
  }

  async resolveFileParsedContent({
    messageId,
    resourceKey,
    resourceType = "file",
    fileNameHint = "",
    missingKeyNote = "文件消息缺少资源 key，无法下载。",
    noClientNote = "文件消息未启用资源下载能力。"
  }) {
    const normalizedKey = String(resourceKey ?? "").trim();
    const normalizedHint = sanitizeFileName(fileNameHint, `file_${Date.now()}`);

    if (!normalizedKey) {
      return [
        normalizeParseFailedResult({
          id: `file_missing_key_${Date.now()}`,
          name: normalizedHint,
          extension: path.extname(normalizedHint).toLowerCase(),
          note: missingKeyNote
        })
      ];
    }

    if (!this.resourceClient || typeof this.resourceClient.downloadMessageResource !== "function") {
      return [
        normalizeParseFailedResult({
          id: `file_no_client_${Date.now()}`,
          name: normalizedHint,
          extension: path.extname(normalizedHint).toLowerCase(),
          note: noClientNote
        })
      ];
    }

    try {
      const resource = await this.resourceClient.downloadMessageResource({
        messageId,
        fileKey: normalizedKey,
        type: resourceType
      });
      const fileSize = Number(resource.size ?? resource.buffer?.length ?? 0);
      const resolvedName = sanitizeFileName(resource.filename, normalizedHint);
      const extension = path.extname(resolvedName).toLowerCase();
      const mimeType = String(resource.mimeType ?? "").trim();

      if (fileSize > this.maxFileBytes) {
        return [
          {
            id: `file_oversized_${Date.now()}`,
            name: resolvedName,
            mimeType,
            extension,
            size: fileSize,
            parseStatus: "truncated",
            note: `文件超过限制(${this.maxFileBytes} bytes)，已跳过内容提取。`,
            extractedText: ""
          }
        ];
      }

      if (!this.attachmentParserService || typeof this.attachmentParserService.parseFiles !== "function") {
        return [
          {
            id: `file_plain_${Date.now()}`,
            name: resolvedName,
            mimeType,
            extension,
            size: fileSize,
            parseStatus: "unsupported",
            note: "文件已下载，但未启用内容解析服务。",
            extractedText: ""
          }
        ];
      }

      const parseResult = await this.attachmentParserService.parseFiles([
        {
          originalname: resolvedName,
          mimetype: mimeType,
          size: fileSize,
          buffer: resource.buffer
        }
      ]);
      return Array.isArray(parseResult?.files) ? parseResult.files : [];
    } catch (error) {
      return [
        normalizeParseFailedResult({
          id: `file_download_failed_${Date.now()}`,
          name: normalizedHint,
          extension: path.extname(normalizedHint).toLowerCase(),
          note: `文件下载失败: ${String(error?.message ?? "unknown error")}`
        })
      ];
    }
  }
}
