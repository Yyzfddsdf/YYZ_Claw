import fs from "node:fs/promises";
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

function preserveRemoteFileName(value, fallback) {
  const normalized = String(value ?? "").trim();
  const fallbackName = String(fallback ?? "").trim() || "remote_file";
  if (!normalized) {
    return fallbackName;
  }

  const baseName = path.basename(normalized);
  return baseName || fallbackName;
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

export function buildRemoteUploadedFileNotice(uploadedFile = {}) {
  const fileName = String(uploadedFile.name ?? "").trim() || "未命名文件";
  const savedPath = String(uploadedFile.savedPath ?? "").trim();
  if (!savedPath) {
    return `远程文件 ${fileName} 已上传到本地 upload 文件夹。`;
  }

  return `远程文件 ${fileName} 已上传到本地 upload 文件夹：${savedPath}`;
}

export function resolveRemoteWorkspaceUploadDir(workplacePath = "") {
  const normalized = String(workplacePath ?? "").trim();
  if (!normalized) {
    return "";
  }

  return path.join(path.resolve(normalized), "upload");
}

export class RemoteAttachmentResolver {
  constructor(options = {}) {
    this.resourceClient = options.resourceClient ?? null;
    this.attachmentParserService = options.attachmentParserService ?? null;
    this.uploadRootDir = String(options.uploadRootDir ?? "").trim();
    this.targetConversationResolver =
      typeof options.targetConversationResolver === "function"
        ? options.targetConversationResolver
        : null;
    this.maxImageBytes = Math.max(64 * 1024, Number(options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES));
    this.maxFileBytes = Math.max(128 * 1024, Number(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  }

  async resolveDefaultUploadRootDir() {
    if (this.uploadRootDir) {
      return this.uploadRootDir;
    }
    if (!this.targetConversationResolver) {
      return "";
    }

    const conversation = await this.targetConversationResolver().catch(() => null);
    return resolveRemoteWorkspaceUploadDir(conversation?.workplacePath);
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

  async resolveFileUpload({
    messageId,
    resourceKey,
    resourceType = "file",
    fileNameHint = "",
    missingKeyNote = "文件消息缺少资源 key，无法下载。",
    noClientNote = "文件消息未启用资源下载能力。",
    uploadRootDir = this.uploadRootDir
  }) {
    const normalizedKey = String(resourceKey ?? "").trim();
    const normalizedHint = sanitizeFileName(fileNameHint, `file_${Date.now()}`);
    const normalizedUploadRoot =
      String(uploadRootDir ?? "").trim() || String(await this.resolveDefaultUploadRootDir()).trim();

    if (!normalizedKey) {
      return {
        uploadedFile: null,
        note: missingKeyNote
      };
    }

    if (!this.resourceClient || typeof this.resourceClient.downloadMessageResource !== "function") {
      return {
        uploadedFile: null,
        note: noClientNote
      };
    }

    try {
      const resource = await this.resourceClient.downloadMessageResource({
        messageId,
        fileKey: normalizedKey,
        type: resourceType
      });
      const fileSize = Number(resource.size ?? resource.buffer?.length ?? 0);
      const resolvedName = preserveRemoteFileName(resource.filename, normalizedHint);
      if (fileSize > this.maxFileBytes) {
        return {
          uploadedFile: null,
          note: `文件超过限制(${this.maxFileBytes} bytes)，已跳过下载。`
        };
      }

      if (!normalizedUploadRoot) {
        return {
          uploadedFile: null,
          note: "未配置本地 upload 目录，无法保存远程文件。"
        };
      }

      await fs.mkdir(normalizedUploadRoot, { recursive: true });
      const savedPath = path.join(normalizedUploadRoot, resolvedName);
      await fs.writeFile(savedPath, resource.buffer);

      return {
        uploadedFile: {
          id: normalizedKey,
          name: resolvedName,
          savedPath,
          size: fileSize
        },
        note: ""
      };
    } catch (error) {
      return {
        uploadedFile: null,
        note: `文件下载失败: ${String(error?.message ?? "unknown error")}`
      };
    }
  }
}
