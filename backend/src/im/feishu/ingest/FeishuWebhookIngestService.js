import { RemoteAttachmentResolver } from "../../../integrations/remote-control/ingest/RemoteAttachmentResolver.js";
import { RemoteWebhookIngestService } from "../../../integrations/remote-control/ingest/RemoteWebhookIngestService.js";
import { safeJsonParse } from "../../../utils/safeJsonParse.js";

function normalizeTimestampMs(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }

  if (numeric < 1_000_000_000_000) {
    return Math.trunc(numeric * 1000);
  }
  return Math.trunc(numeric);
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeMessageType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeInlinePostItem(item) {
  const payload = normalizeObject(item);
  const tag = String(payload.tag ?? "").trim().toLowerCase();
  if (!tag) {
    return "";
  }

  if (tag === "text") {
    return String(payload.text ?? "").trim();
  }
  if (tag === "a") {
    const text = String(payload.text ?? "").trim();
    const href = String(payload.href ?? "").trim();
    if (text && href) {
      return `${text} (${href})`;
    }
    return text || href;
  }
  if (tag === "at") {
    const name = String(payload.user_name ?? payload.name ?? "").trim();
    return name ? `@${name}` : "@成员";
  }
  if (tag === "img") {
    return "[图片]";
  }
  return "";
}

function extractPostText(contentPayload) {
  const payload = normalizeObject(contentPayload);
  const zhCnPayload = normalizeObject(payload.zh_cn);
  const hasZhCnContent =
    String(zhCnPayload.title ?? "").trim().length > 0 || Array.isArray(zhCnPayload.content);
  const localePayload = hasZhCnContent
    ? zhCnPayload
    : normalizeObject(
        Object.values(payload).find(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (String(item.title ?? "").trim() || Array.isArray(item.content))
        )
      );

  const lines = [];
  const title = String(localePayload.title ?? "").trim();
  if (title) {
    lines.push(title);
  }

  const paragraphs = Array.isArray(localePayload.content) ? localePayload.content : [];
  for (const paragraph of paragraphs) {
    const row = Array.isArray(paragraph) ? paragraph : [];
    const line = row
      .map((item) => normalizeInlinePostItem(item))
      .filter(Boolean)
      .join("")
      .trim();
    if (line) {
      lines.push(line);
    }
  }

  return lines.join("\n").trim();
}

function buildSessionKey(message, sender) {
  const chatId = String(message?.chat_id ?? "").trim();
  const senderId =
    String(sender?.sender_id?.open_id ?? "").trim() ||
    String(sender?.sender_id?.user_id ?? "").trim() ||
    String(sender?.sender_id?.union_id ?? "").trim();
  if (chatId && senderId) {
    return `${chatId}:${senderId}`;
  }
  if (chatId) {
    return `chat:${chatId}`;
  }
  if (senderId) {
    return `sender:${senderId}`;
  }
  return "feishu_default";
}

function buildMessageText(messageType, rawContent, contentPayload) {
  if (messageType === "text") {
    const text = String(contentPayload?.text ?? "").trim();
    if (text) {
      return text;
    }
  }

  if (messageType === "post") {
    const postText = extractPostText(contentPayload);
    if (postText) {
      return postText;
    }
  }

  const fallback = String(rawContent ?? "").trim();
  if (!fallback) {
    return "";
  }

  const fallbackPayload = safeJsonParse(fallback, null);
  if (fallbackPayload && typeof fallbackPayload === "object" && !Array.isArray(fallbackPayload)) {
    return "";
  }

  return fallback;
}

export class FeishuWebhookIngestService {
  constructor(options = {}) {
    this.runtimeService = options.runtimeService ?? null;
    this.openApiClient = options.openApiClient ?? null;
    this.attachmentParserService = options.attachmentParserService ?? null;
    this.attachmentResolver =
      options.attachmentResolver ??
      new RemoteAttachmentResolver({
        resourceClient: this.openApiClient,
        attachmentParserService: this.attachmentParserService,
        maxImageBytes: options.maxImageBytes,
        maxFileBytes: options.maxFileBytes
      });
    this.remoteIngest = new RemoteWebhookIngestService({
      runtimeService: this.runtimeService,
      normalizePayload: (payload) => this.normalizeFeishuPayload(payload)
    });
  }

  async handleCallback(payload = {}) {
    return this.remoteIngest.handleCallback(payload);
  }

  async normalizeFeishuPayload(payload = {}) {
    const body = normalizeObject(payload);

    if (String(body.type ?? "").trim() === "url_verification") {
      return {
        kind: "challenge",
        challenge: String(body.challenge ?? "").trim()
      };
    }

    const envelope = this.extractEventEnvelope(body);
    if (!envelope) {
      return {
        kind: "ignored",
        reason: "unsupported_event_envelope"
      };
    }

    if (envelope.eventType !== "im.message.receive_v1") {
      return {
        kind: "ignored",
        reason: "event_type_not_supported",
        eventType: envelope.eventType
      };
    }

    const normalizedMessage = await this.buildInboundMessage(envelope);
    if (!normalizedMessage) {
      return {
        kind: "ignored",
        reason: "empty_or_unsupported_message"
      };
    }
    return {
      kind: "messages",
      eventId: envelope.eventId,
      messages: [normalizedMessage]
    };
  }

  extractEventEnvelope(body) {
    const payload = normalizeObject(body);

    const schema = String(payload.schema ?? "").trim();
    if (schema === "2.0") {
      const header = normalizeObject(payload.header);
      const eventType = String(header.event_type ?? "").trim();
      const event = normalizeObject(payload.event);
      if (!eventType || Object.keys(event).length === 0) {
        return null;
      }

      return {
        eventId: String(header.event_id ?? "").trim(),
        eventType,
        event
      };
    }

    if (String(payload.type ?? "").trim() === "event_callback") {
      const event = normalizeObject(payload.event);
      const eventType = String(payload?.header?.event_type ?? event?.type ?? "").trim();
      if (!eventType || Object.keys(event).length === 0) {
        return null;
      }

      return {
        eventId: String(payload.uuid ?? "").trim(),
        eventType,
        event
      };
    }

    return null;
  }

  async buildInboundMessage(envelope) {
    const event = normalizeObject(envelope?.event);
    const message = normalizeObject(event.message);
    const sender = normalizeObject(event.sender);

    const originMessageId = String(message.message_id ?? "").trim();
    if (!originMessageId) {
      return null;
    }

    const rawContent = String(message.content ?? "").trim();
    const contentPayload = safeJsonParse(rawContent, {});
    const messageType = normalizeMessageType(message.message_type ?? message.msg_type);
    const content = buildMessageText(messageType, rawContent, contentPayload);

    const attachments = [];
    const parsedFiles = [];
    const notes = [];

    if (messageType === "image") {
      const imageAttachment = await this.resolveImageAttachment({
        messageId: originMessageId,
        contentPayload
      });
      if (imageAttachment?.attachment) {
        attachments.push(imageAttachment.attachment);
      }
      if (imageAttachment?.note) {
        notes.push(imageAttachment.note);
      }
    }

    if (messageType === "file") {
      const fileItems = await this.resolveParsedFiles({
        messageId: originMessageId,
        contentPayload
      });
      if (fileItems.length > 0) {
        parsedFiles.push(...fileItems);
      }
    }

    const mergedContent = [content, ...notes]
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    const finalContent =
      mergedContent ||
      (messageType ? `[飞书消息类型:${messageType}]` : "") ||
      "[收到一条飞书消息]";

    return {
      messageId: originMessageId,
      originMessageId,
      content: finalContent,
      timestamp: normalizeTimestampMs(message.create_time),
      attachments,
      parsedFiles,
      sessionKey: buildSessionKey(message, sender),
      messageType,
      replyTarget: {
        messageId: originMessageId,
        chatId: String(message.chat_id ?? "").trim()
      }
    };
  }

  async resolveImageAttachment({ messageId, contentPayload }) {
    const imageKey = String(contentPayload?.image_key ?? contentPayload?.imageKey ?? "").trim();
    return this.attachmentResolver.resolveImageAttachment({
      messageId,
      resourceKey: imageKey,
      resourceType: "image",
      nameHint: imageKey ? `image_${imageKey}` : ""
    });
  }

  async resolveParsedFiles({ messageId, contentPayload }) {
    const fileKey = String(contentPayload?.file_key ?? contentPayload?.fileKey ?? "").trim();
    return this.attachmentResolver.resolveFileParsedContent({
      messageId,
      resourceKey: fileKey,
      resourceType: "file",
      fileNameHint: String(contentPayload?.file_name ?? contentPayload?.fileName ?? "").trim(),
      missingKeyNote: "文件消息缺少 file_key，无法下载。",
      noClientNote: "文件消息未启用飞书资源下载能力。"
    });
  }
}
