import { z } from "zod";

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const key = skillName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(skillName);
  }

  return normalized;
}

export const remoteControlConfigUpdateSchema = z
  .object({
    activeProviderKey: z.string().trim().optional(),
    workspacePath: z.string().max(4096).optional(),
    personaId: z.string().trim().max(120).optional(),
    activeSkillNames: z.array(z.string().trim().min(1).max(200)).max(120).optional(),
    providerConfig: z.record(z.unknown()).optional()
  })
  .transform((payload) => ({
    activeProviderKey: normalizeProviderKey(payload.activeProviderKey),
    workspacePath:
      payload.workspacePath === undefined ? undefined : String(payload.workspacePath ?? "").trim(),
    personaId:
      payload.personaId === undefined ? undefined : String(payload.personaId ?? "").trim(),
    activeSkillNames:
      payload.activeSkillNames === undefined
        ? undefined
        : normalizeSkillNames(payload.activeSkillNames),
    providerConfig:
      payload.providerConfig && typeof payload.providerConfig === "object" && !Array.isArray(payload.providerConfig)
        ? payload.providerConfig
        : undefined
  }));

export const remoteControlRecordsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    cursor: z.coerce.number().int().positive().optional()
  })
  .transform((payload) => ({
    limit: Number(payload.limit ?? 20),
    cursor:
      Number.isInteger(payload.cursor) && Number(payload.cursor) > 0
        ? Number(payload.cursor)
        : null
  }));

export const remoteControlClearRecordsQuerySchema = z
  .object({
    providerKey: z.string().trim().optional().default("")
  })
  .transform((payload) => ({
    providerKey: normalizeProviderKey(payload.providerKey)
  }));

const remoteAttachmentSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  mimeType: z.string().trim().optional(),
  dataUrl: z.string().trim().optional(),
  url: z.string().trim().optional(),
  size: z.coerce.number().int().nonnegative().optional()
});

const remoteParsedFileSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  mimeType: z.string().trim().optional(),
  extension: z.string().trim().optional(),
  size: z.coerce.number().int().nonnegative().optional(),
  parseStatus: z.string().trim().optional(),
  note: z.string().optional(),
  extractedText: z.string().optional()
});

const remoteInboundMessageSchema = z.object({
  messageId: z.string().trim().optional(),
  originMessageId: z.string().trim().optional(),
  sessionKey: z.string().trim().optional(),
  messageType: z.string().trim().optional(),
  timestamp: z.coerce.number().int().positive().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  attachments: z.array(remoteAttachmentSchema).optional().default([]),
  parsedFiles: z.array(remoteParsedFileSchema).optional().default([]),
  replyTarget: z
    .object({
      messageId: z.string().trim().optional(),
      chatId: z.string().trim().optional()
    })
    .optional()
});

export const remoteControlInboundPayloadSchema = z
  .object({
    messages: z.array(remoteInboundMessageSchema).min(1).max(20).optional(),
    message: remoteInboundMessageSchema.optional()
  })
  .transform((payload) => {
    const list = Array.isArray(payload.messages)
      ? payload.messages
      : payload.message
        ? [payload.message]
        : [];

    return {
      messages: list
    };
  });

export const activeProviderSchema = z.object({
  activeProviderKey: z.string().trim().optional().default("")
});
