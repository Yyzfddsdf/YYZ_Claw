import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import {
  appendToolResultHooksToContent,
  normalizeToolResultHooks
} from "../tools/toolResultHooks.js";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 12;
const DEFAULT_HEAD_MESSAGE_COUNT = 4;
const DEFAULT_TAIL_MESSAGE_COUNT = 8;
const MANUAL_COMPRESSION_THRESHOLD = 0.2;
const AUTO_COMPRESSION_THRESHOLD = 0.9;
const DEFAULT_COMPRESSION_MAX_OUTPUT_TOKENS = 8000;
const SUMMARY_PREFIX = "[CONTEXT COMPACTION]";
const IMAGE_ATTACHMENT_ESTIMATE_TOKENS = 1024;
const EXTREME_FILE_CONTEXT_CHARS = 500_000;
const EXTREME_PARSED_FILES_PROMPT_CHARS = 2_000_000;
const EXTREME_SUMMARY_SERIALIZE_CHARS = 160_000;

function createCompressionId() {
  return `compression_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeToolCalls(toolCalls) {
  return Array.isArray(toolCalls)
    ? toolCalls
        .map((toolCall) => {
          const id = String(toolCall?.id ?? "").trim();
          const functionName = String(toolCall?.function?.name ?? "").trim();
          if (!id || !functionName) {
            return null;
          }

          return {
            id,
            type: "function",
            function: {
              name: functionName,
              arguments: String(toolCall?.function?.arguments ?? "{}")
            }
          };
        })
        .filter(Boolean)
    : [];
}

function normalizeMeta(meta) {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

function normalizeImageAttachments(meta) {
  const attachments = Array.isArray(meta?.attachments) ? meta.attachments : [];
  return attachments
    .map((attachment, index) => {
      const dataUrl = String(attachment?.dataUrl ?? attachment?.url ?? "").trim();
      const mimeType = String(attachment?.mimeType ?? "").trim();
      if (!dataUrl || !mimeType) {
        return null;
      }

      return {
        id: String(attachment?.id ?? `image_${index}`).trim() || `image_${index}`,
        type: "image",
        name: String(attachment?.name ?? "").trim(),
        mimeType,
        dataUrl,
        size: Number(attachment?.size ?? 0)
      };
    })
    .filter(Boolean);
}

function normalizeParsedFiles(meta) {
  const files = Array.isArray(meta?.parsedFiles) ? meta.parsedFiles : [];

  return files
    .map((file, index) => {
      const name = String(file?.name ?? `file_${index + 1}`).trim();
      const mimeType = String(file?.mimeType ?? "").trim();
      const extension = String(file?.extension ?? "").trim();
      const extractedText = String(file?.extractedText ?? "").trim();
      const parseStatus = String(file?.parseStatus ?? "unsupported").trim();
      const note = String(file?.note ?? "").trim();

      if (!name) {
        return null;
      }

      return {
        name,
        mimeType,
        extension,
        extractedText,
        parseStatus,
        note
      };
    })
    .filter(Boolean);
}

function clipTextForPrompt(text, maxChars = EXTREME_FILE_CONTEXT_CHARS) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const clipped = normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd();
  return `${clipped}\n...[truncated]`;
}

function buildParsedFilesPrompt(meta) {
  const parsedFiles = normalizeParsedFiles(meta);
  if (parsedFiles.length > 0) {
    const lines = [
      "[用户上传文件解析]",
      "以下内容由系统自动解析并注入本轮上下文："
    ];

    for (const [index, file] of parsedFiles.entries()) {
      lines.push("");
      lines.push(
        `--- 文件 ${index + 1}: ${file.name} (${file.mimeType || file.extension || "unknown"})`
      );

      if (file.parseStatus === "parsed" || file.parseStatus === "truncated") {
        if (file.extractedText) {
          lines.push(clipTextForPrompt(file.extractedText, EXTREME_FILE_CONTEXT_CHARS));
          continue;
        }
      }

      lines.push(`[未提取文本] ${file.note || "该文件类型暂不支持提取文本。"}`);
    }

    const truncatedCount = Number(meta?.parsedFilesTruncatedCount ?? 0);
    if (truncatedCount > 0) {
      lines.push("");
      lines.push(`[提示] 另有 ${truncatedCount} 个文件因数量上限未注入。`);
    }

    return clipTextForPrompt(lines.join("\n"), EXTREME_PARSED_FILES_PROMPT_CHARS);
  }

  const explicitPrompt = String(meta?.parsedFilesPrompt ?? "").trim();
  if (explicitPrompt) {
    return clipTextForPrompt(explicitPrompt, EXTREME_PARSED_FILES_PROMPT_CHARS);
  }

  return "";
}

function normalizeMessage(message, fallbackId = "") {
  return {
    id: String(message?.id ?? fallbackId ?? "").trim(),
    role: String(message?.role ?? "user").trim(),
    content: String(message?.content ?? ""),
    timestamp: Number(message?.timestamp ?? Date.now()),
    toolCallId: String(message?.toolCallId ?? "").trim(),
    toolName: String(message?.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message?.toolCalls),
    meta: normalizeMeta(message?.meta)
  };
}

function isCompressionSummary(message) {
  return String(message?.meta?.kind ?? "").trim() === "compression_summary";
}

function isToolEventMeta(message) {
  return String(message?.meta?.kind ?? "").trim() === "tool_event";
}

function messageTokensRough(message) {
  let total = MESSAGE_OVERHEAD_TOKENS;
  total += Math.ceil(String(message?.content ?? "").length / CHARS_PER_TOKEN);

  for (const toolCall of normalizeToolCalls(message?.toolCalls)) {
    total += Math.ceil(String(toolCall.function.arguments ?? "").length / CHARS_PER_TOKEN);
    total += Math.ceil(String(toolCall.function.name ?? "").length / CHARS_PER_TOKEN);
  }

  if (message?.meta && typeof message.meta === "object") {
    const imageAttachments = normalizeImageAttachments(message.meta);
    if (imageAttachments.length > 0) {
      total += imageAttachments.length * IMAGE_ATTACHMENT_ESTIMATE_TOKENS;
    }

    const metaWithoutAttachments = { ...message.meta };
    if (Object.prototype.hasOwnProperty.call(metaWithoutAttachments, "attachments")) {
      delete metaWithoutAttachments.attachments;
    }

    if (Object.keys(metaWithoutAttachments).length > 0) {
      total += Math.ceil(JSON.stringify(metaWithoutAttachments).length / CHARS_PER_TOKEN);
    }
  }

  return total;
}

function serializeSummaryMessage(message) {
  const role = String(message?.role ?? "user").trim() || "user";
  const content = String(message?.content ?? "");
  const lines = [`[${role.toUpperCase()}]`];

  if (content) {
    lines.push(content);
  }

  const imageAttachments = normalizeImageAttachments(message?.meta);
  if (imageAttachments.length > 0) {
    lines.push("[IMAGES]");
    for (const attachment of imageAttachments) {
      lines.push(`- ${attachment.name || attachment.id} (${attachment.mimeType})`);
    }
  }

  const parsedFilesPrompt = buildParsedFilesPrompt(message?.meta);
  if (parsedFilesPrompt) {
    lines.push("[UPLOADED_FILES]");
    lines.push(clipForPrompt(parsedFilesPrompt, EXTREME_SUMMARY_SERIALIZE_CHARS));
  }

  const toolCalls = normalizeToolCalls(message?.toolCalls);
  if (toolCalls.length > 0) {
    lines.push("[TOOL_CALLS]");
    for (const toolCall of toolCalls) {
      lines.push(`- ${toolCall.function.name}(${toolCall.function.arguments})`);
    }
  }

  if (isToolEventMeta(message)) {
    const meta = normalizeMeta(message.meta);
    const toolName = String(message.toolName || meta.toolName || "").trim() || "unknown_tool";
    const toolCallId = String(message.toolCallId || meta.toolCallId || "").trim();
    const hooks = normalizeToolResultHooks(meta.hooks);
    const resultText =
      typeof meta.result === "string" && meta.result.length > 0
        ? meta.result
        : String(message.content ?? "");
    const argsText =
      meta.arguments && typeof meta.arguments === "object"
        ? JSON.stringify(meta.arguments)
        : "";
    lines.push(`[TOOL_RESULT ${toolCallId || toolName}]`);
    lines.push(`name=${toolName}`);
    if (argsText) {
      lines.push(`args=${argsText}`);
    }
    if (resultText) {
      lines.push(appendToolResultHooksToContent(resultText, hooks));
    }
  } else if (message.role === "tool") {
    const toolName = String(message.toolName ?? "").trim() || "unknown_tool";
    const toolCallId = String(message.toolCallId ?? "").trim();
    lines.push(`[TOOL_RESULT ${toolCallId || toolName}]`);
    lines.push(String(message.content ?? ""));
  }

  return lines.join("\n");
}

function clipForPrompt(text, maxChars = EXTREME_SUMMARY_SERIALIZE_CHARS) {
  const source = String(text ?? "");
  if (source.length <= maxChars) {
    return source;
  }

  const headChars = Math.max(2000, Math.floor(maxChars * 0.72));
  const tailChars = Math.max(800, Math.floor(maxChars * 0.22));
  const head = source.slice(0, headChars);
  const tail = source.slice(-tailChars);
  return `${head}\n...[truncated]...\n${tail}`;
}

function findLatestCompressionSummary(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompressionSummary(messages[index])) {
      return {
        message: messages[index],
        index
      };
    }
  }

  return null;
}

function getLatestCompressionTimestamp(messages) {
  const latestSummary = findLatestCompressionSummary(messages);
  const summaryTimestamp = Number(latestSummary?.message?.timestamp ?? 0);
  const summaryCreatedAt = Number(latestSummary?.message?.meta?.createdAt ?? 0);
  return Math.max(summaryTimestamp, summaryCreatedAt);
}

function resolveFreshUsageTokens(messages, latestTokenUsage) {
  const usageTokens = Number(latestTokenUsage?.totalTokens ?? 0);
  if (!Number.isFinite(usageTokens) || usageTokens <= 0) {
    return 0;
  }

  const latestUsageAt = Number(latestTokenUsage?.lastUsedAt ?? 0);
  const latestCompressionAt = getLatestCompressionTimestamp(messages);

  // Once compression happens after the latest model usage record, that old high-water mark
  // must stop influencing the next auto-compression decision.
  if (latestCompressionAt > 0 && latestCompressionAt > latestUsageAt) {
    return 0;
  }

  return usageTokens;
}

function resolveSummaryWindowCounts(summaryMessage, defaults = {}) {
  const defaultHead = Number(defaults.headMessageCount ?? DEFAULT_HEAD_MESSAGE_COUNT);
  const defaultTail = Number(defaults.tailMessageCount ?? DEFAULT_TAIL_MESSAGE_COUNT);
  const headMessageCount = Math.max(
    0,
    Number(summaryMessage?.meta?.headMessageCount ?? defaultHead)
  );
  const tailMessageCount = Math.max(
    0,
    Number(summaryMessage?.meta?.tailMessageCount ?? defaultTail)
  );

  return {
    headMessageCount,
    tailMessageCount
  };
}

function findMessageIndexById(messages, targetId) {
  if (!targetId) {
    return -1;
  }

  return messages.findIndex((message) => String(message?.id ?? "").trim() === String(targetId).trim());
}

function alignHeadBoundary(messages, boundaryIndex) {
  let index = Math.max(0, boundaryIndex);
  while (index < messages.length && messages[index]?.role === "tool") {
    index += 1;
  }
  return index;
}

function alignTailBoundary(messages, boundaryIndex) {
  let index = Math.max(0, boundaryIndex);
  while (index > 0 && messages[index]?.role === "tool") {
    index -= 1;
  }

  if (index > 0) {
    const previous = messages[index - 1];
    if (previous?.role === "assistant" && normalizeToolCalls(previous.toolCalls).length > 0) {
      return index - 1;
    }
  }

  return index;
}

function sanitizeToolPairs(messages) {
  const normalizedMessages = messages.map((message, index) =>
    normalizeMessage(message, `sanitized_${index}`)
  );
  const survivingToolCallIds = new Set();
  const existingToolResultIds = new Set();

  for (const message of normalizedMessages) {
    if (message.role === "assistant") {
      for (const toolCall of normalizeToolCalls(message.toolCalls)) {
        survivingToolCallIds.add(toolCall.id);
      }
    }

    if (message.role === "tool" && message.toolCallId) {
      existingToolResultIds.add(message.toolCallId);
    }
  }

  const filtered = normalizedMessages.filter((message) => {
    if (message.role !== "tool" || !message.toolCallId) {
      return true;
    }
    return survivingToolCallIds.has(message.toolCallId);
  });

  const patched = [];
  for (const message of filtered) {
    patched.push(message);
    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of normalizeToolCalls(message.toolCalls)) {
      if (existingToolResultIds.has(toolCall.id)) {
        continue;
      }

      patched.push({
        id: `${message.id}_tool_stub_${toolCall.id}`,
        role: "tool",
        content: "[Result from earlier conversation. Refer to the compression summary.]",
        timestamp: Number(message.timestamp ?? Date.now()),
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        toolCalls: [],
        meta: {
          kind: "tool_event",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: {},
          result: "[Result from earlier conversation. Refer to the compression summary.]",
          isError: false,
          approvalStatus: "approved",
          pendingApprovalId: ""
        }
      });
    }
  }

  return patched;
}

function selectEffectiveConversationMessages(
  messages,
  { headMessageCount = DEFAULT_HEAD_MESSAGE_COUNT, tailMessageCount = DEFAULT_TAIL_MESSAGE_COUNT } = {}
) {
  const normalizedMessages = Array.isArray(messages)
    ? messages.map((message, index) => normalizeMessage(message, `effective_${index}`))
    : [];
  const latestSummary = findLatestCompressionSummary(normalizedMessages);

  if (!latestSummary) {
    return sanitizeToolPairs(normalizedMessages.filter((message) => !isCompressionSummary(message)));
  }

  const rawMessages = normalizedMessages.filter((message) => !isCompressionSummary(message));
  const resolvedWindowCounts = resolveSummaryWindowCounts(latestSummary.message, {
    headMessageCount,
    tailMessageCount
  });
  const head = rawMessages.slice(0, resolvedWindowCounts.headMessageCount);
  const tailStartMessageId = String(latestSummary.message?.meta?.tailStartMessageId ?? "").trim();
  let tailStartIndex = findMessageIndexById(rawMessages, tailStartMessageId);

  if (tailStartIndex < 0) {
    tailStartIndex = Math.max(head.length, rawMessages.length - resolvedWindowCounts.tailMessageCount);
  }

  const tail = rawMessages.slice(tailStartIndex);
  const selected = [];
  const seenIds = new Set();

  for (const message of [...head, latestSummary.message, ...tail]) {
    if (!message?.id || seenIds.has(message.id)) {
      continue;
    }
    seenIds.add(message.id);
    selected.push(message);
  }

  return sanitizeToolPairs(selected);
}

function buildSummaryPrompt({ previousSummary = "", messages = [], targetTokens = 1800 }) {
  const serializedMessages = messages
    .map((message) => clipForPrompt(serializeSummaryMessage(message)))
    .join("\n\n");

  if (previousSummary) {
    return [
      "You are updating a structured conversation handoff summary.",
      "",
      "PREVIOUS SUMMARY:",
      previousSummary,
      "",
      "NEW MESSAGES TO INCORPORATE:",
      serializedMessages,
      "",
      "Update the summary using this exact structure. Preserve existing still-relevant facts. Add new progress. Remove only clearly obsolete details.",
      "",
      "## Goal",
      "## Constraints",
      "## Progress",
      "### Done",
      "### In Progress",
      "### Blocked",
      "## Key Decisions",
      "## Relevant Files",
      "## Next Steps",
      "## Critical Context",
      "## Tools & Patterns",
      "",
      `Target about ${targetTokens} tokens. Be concrete. Include commands, files, values, and errors when relevant.`,
      "Write only the summary body."
    ].join("\n");
  }

  return [
    "Create a structured conversation handoff summary for later continuation.",
    "",
    "MESSAGES TO SUMMARIZE:",
    serializedMessages,
    "",
    "Use this exact structure:",
    "",
    "## Goal",
    "## Constraints",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Relevant Files",
    "## Next Steps",
    "## Critical Context",
    "## Tools & Patterns",
    "",
    `Target about ${targetTokens} tokens. Be concrete. Include commands, files, values, and errors when relevant.`,
    "Write only the summary body."
  ].join("\n");
}

function createFallbackSummary({ previousSummary = "", newMessages = [] }) {
  const fallbackLines = [];
  if (previousSummary) {
    fallbackLines.push(previousSummary);
  }

  fallbackLines.push("## Goal");
  fallbackLines.push("- Conversation compaction summary generation fell back to a static placeholder.");
  fallbackLines.push("## Constraints");
  fallbackLines.push("- Continue from current workspace state instead of repeating earlier work.");
  fallbackLines.push("## Progress");
  fallbackLines.push("### Done");
  fallbackLines.push(`- ${newMessages.length} message(s) were compacted without model-generated detail.`);
  fallbackLines.push("### In Progress");
  fallbackLines.push("- Review the preserved recent tail for the latest active thread.");
  fallbackLines.push("### Blocked");
  fallbackLines.push("- Earlier detailed context was not available from the summarizer.");
  fallbackLines.push("## Key Decisions");
  fallbackLines.push("- Compression was triggered to reduce context pressure.");
  fallbackLines.push("## Relevant Files");
  fallbackLines.push("- Refer to preserved tail messages for the latest file touches.");
  fallbackLines.push("## Next Steps");
  fallbackLines.push("- Continue from the preserved tail messages and current workspace state.");
  fallbackLines.push("## Critical Context");
  fallbackLines.push("- Some earlier message detail may have been compacted.");
  fallbackLines.push("## Tools & Patterns");
  fallbackLines.push("- Check the preserved tool tail for the latest command and output.");
  return fallbackLines.join("\n");
}

function resolveCompressionRuntimeConfig(runtimeConfig = {}) {
  const model = String(runtimeConfig?.compressionModel ?? "").trim() || String(runtimeConfig?.model ?? "").trim();
  const baseURL =
    String(runtimeConfig?.compressionBaseURL ?? "").trim() || String(runtimeConfig?.baseURL ?? "").trim();
  const apiKey =
    String(runtimeConfig?.compressionApiKey ?? "").trim() || String(runtimeConfig?.apiKey ?? "").trim();
  const compressionMaxOutputTokens = Number(
    runtimeConfig?.compressionMaxOutputTokens ?? DEFAULT_COMPRESSION_MAX_OUTPUT_TOKENS
  );

  return {
    model,
    baseURL,
    apiKey,
    compressionMaxOutputTokens:
      Number.isFinite(compressionMaxOutputTokens) && compressionMaxOutputTokens > 0
        ? Math.floor(compressionMaxOutputTokens)
        : DEFAULT_COMPRESSION_MAX_OUTPUT_TOKENS
  };
}

export class ConversationCompressionService {
  constructor(options = {}) {
    this.headMessageCount = Number(options.headMessageCount ?? DEFAULT_HEAD_MESSAGE_COUNT);
    this.tailMessageCount = Number(options.tailMessageCount ?? DEFAULT_TAIL_MESSAGE_COUNT);
    this.manualThreshold = Number(options.manualThreshold ?? MANUAL_COMPRESSION_THRESHOLD);
    this.autoThreshold = Number(options.autoThreshold ?? AUTO_COMPRESSION_THRESHOLD);
  }

  estimateMessagesTokens(messages = []) {
    return messages.reduce((total, message) => total + messageTokensRough(normalizeMessage(message)), 0);
  }

  estimateEffectiveConversationTokens(messages = []) {
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((message, index) => normalizeMessage(message, `estimate_${index}`))
      : [];
    const latestSummary = findLatestCompressionSummary(normalizedMessages);
    const latestSummaryEstimate = Number(latestSummary?.message?.meta?.estimatedTokensAfter ?? 0);
    const hasMessagesAfterLatestSummary =
      latestSummary && latestSummary.index < normalizedMessages.length - 1;

    if (latestSummaryEstimate > 0 && !hasMessagesAfterLatestSummary) {
      return latestSummaryEstimate;
    }

    const effectiveMessages = selectEffectiveConversationMessages(normalizedMessages, {
      headMessageCount: this.headMessageCount,
      tailMessageCount: this.tailMessageCount
    });
    return this.estimateMessagesTokens(effectiveMessages);
  }

  getUsageRatio({ messages = [], maxContextWindow = 0, latestTokenUsage = null }) {
    const numericWindow = Number(maxContextWindow ?? 0);
    if (!Number.isFinite(numericWindow) || numericWindow <= 0) {
      return 0;
    }

    const normalizedMessages = Array.isArray(messages)
      ? messages.map((message, index) => normalizeMessage(message, `usage_${index}`))
      : [];
    const usageTokens = resolveFreshUsageTokens(normalizedMessages, latestTokenUsage);
    if (usageTokens > 0) {
      return usageTokens / numericWindow;
    }

    const estimatedTokens = this.estimateEffectiveConversationTokens(normalizedMessages);
    return estimatedTokens > 0 ? estimatedTokens / numericWindow : 0;
  }

  canManualCompress({ messages = [], maxContextWindow = 0, latestTokenUsage = null }) {
    return this.getUsageRatio({ messages, maxContextWindow, latestTokenUsage }) >= this.manualThreshold;
  }

  shouldAutoCompress({ messages = [], maxContextWindow = 0, latestTokenUsage = null }) {
    return this.getUsageRatio({ messages, maxContextWindow, latestTokenUsage }) >= this.autoThreshold;
  }

  buildRuntimeScope({ systemMessages = [], messages = [] } = {}) {
    const normalizedSystemMessages = Array.isArray(systemMessages)
      ? systemMessages
          .map((message, index) => normalizeMessage(message, `runtime_system_${index}`))
          .filter((message) => message.role === "system")
      : [];
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((message, index) => normalizeMessage(message, `runtime_scope_${index}`))
      : [];
    const latestSummary = findLatestCompressionSummary(normalizedMessages);
    const scopedMessages = latestSummary
      ? normalizedMessages
          .slice(latestSummary.index + 1)
          .filter((message) => !isCompressionSummary(message))
      : normalizedMessages.filter((message) => !isCompressionSummary(message));

    return {
      systemMessages: normalizedSystemMessages,
      scopedMessages,
      latestSummary: latestSummary
        ? {
            id: String(latestSummary.message?.id ?? "").trim(),
            index: latestSummary.index,
            timestamp: Number(latestSummary.message?.timestamp ?? 0),
            tailStartMessageId: String(latestSummary.message?.meta?.tailStartMessageId ?? "").trim()
          }
        : null
    };
  }

  buildRuntimeHookScope(options = {}) {
    return this.buildRuntimeScope(options);
  }

  buildModelMessages(messages = []) {
    const effectiveMessages = selectEffectiveConversationMessages(messages, {
      headMessageCount: this.headMessageCount,
      tailMessageCount: this.tailMessageCount
    });

    return effectiveMessages
      .map((message) => this.toModelMessage(message))
      .filter(Boolean);
  }

  buildEffectiveConversationSummaryText(
    messages = [],
    { maxCharsPerMessage = 8000, maxTotalChars = 24000 } = {}
  ) {
    const effectiveMessages = selectEffectiveConversationMessages(messages, {
      headMessageCount: this.headMessageCount,
      tailMessageCount: this.tailMessageCount
    });
    const serializedMessages = effectiveMessages
      .map((message) => clipForPrompt(serializeSummaryMessage(message), maxCharsPerMessage))
      .filter(Boolean)
      .join("\n\n");

    return clipForPrompt(serializedMessages, maxTotalChars);
  }

  toModelMessage(message) {
    const normalized = normalizeMessage(message);
    const imageAttachments = normalizeImageAttachments(normalized.meta);
    const parsedFilesPrompt = buildParsedFilesPrompt(normalized.meta);

    if (isCompressionSummary(normalized)) {
      return {
        role: "assistant",
        content: normalized.content
      };
    }

    if (normalized.role === "assistant") {
      const nextMessage = {
        role: "assistant",
        content: normalized.content
      };
      if (normalized.toolCalls.length > 0) {
        nextMessage.tool_calls = normalized.toolCalls;
      }
      return nextMessage;
    }

    if (normalized.role === "tool") {
      const toolMeta = normalizeMeta(normalized.meta);
      const hooks = normalizeToolResultHooks(toolMeta.hooks);
      const toolResult =
        typeof toolMeta.result === "string" && toolMeta.result.length > 0
          ? toolMeta.result
          : normalized.content;
      return {
        role: "tool",
        tool_call_id: normalized.toolCallId || String(toolMeta.toolCallId ?? "").trim(),
        content: appendToolResultHooksToContent(toolResult, hooks)
      };
    }

    if (normalized.role === "system" || normalized.role === "user") {
      if (imageAttachments.length > 0) {
        const contentParts = [];
        if (normalized.content) {
          contentParts.push({
            type: "text",
            text: normalized.content
          });
        }

        if (parsedFilesPrompt) {
          contentParts.push({
            type: "text",
            text: parsedFilesPrompt
          });
        }

        for (const attachment of imageAttachments) {
          contentParts.push({
            type: "image_url",
            image_url: {
              url: attachment.dataUrl
            }
          });
        }

        return {
          role: normalized.role,
          content: contentParts
        };
      }

      const textContent = [normalized.content, parsedFilesPrompt].filter(Boolean).join("\n\n");

      return {
        role: normalized.role,
        content: textContent
      };
    }

    return null;
  }

  async summarizeMessages({ runtimeConfig, previousSummary = "", messages = [] }) {
    const compressionRuntimeConfig = resolveCompressionRuntimeConfig(runtimeConfig);
    const targetTokens = Math.max(
      900,
      Math.min(
        compressionRuntimeConfig.compressionMaxOutputTokens,
        Math.max(3200, Math.ceil(this.estimateMessagesTokens(messages) * 0.28))
      )
    );
    const prompt = buildSummaryPrompt({ previousSummary, messages, targetTokens });
    const client = createOpenAIClient(compressionRuntimeConfig);
    const completion = await client.chat.completions.create({
      model: compressionRuntimeConfig.model,
      temperature: 0.2,
      max_tokens: compressionRuntimeConfig.compressionMaxOutputTokens,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const summary = String(completion?.choices?.[0]?.message?.content ?? "").trim();
    return summary || createFallbackSummary({ previousSummary, newMessages: messages });
  }

  async compressConversation({
    messages = [],
    runtimeConfig,
    latestTokenUsage = null,
    trigger = "manual"
  }) {
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((message, index) => normalizeMessage(message, `msg_${index}`))
      : [];
    const maxContextWindow = Number(runtimeConfig?.maxContextWindow ?? 0);
    const estimatedTokensBefore = this.estimateEffectiveConversationTokens(normalizedMessages);
    const usageRatio = this.getUsageRatio({
      messages: normalizedMessages,
      maxContextWindow,
      latestTokenUsage
    });

    if (trigger === "manual" && usageRatio < this.manualThreshold) {
      return {
        compressed: false,
        reason: "manual_threshold_not_reached",
        usageRatio,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        messages: normalizedMessages
      };
    }

    if (trigger === "auto" && usageRatio < this.autoThreshold) {
      return {
        compressed: false,
        reason: "auto_threshold_not_reached",
        usageRatio,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        messages: normalizedMessages
      };
    }

    const latestSummary = findLatestCompressionSummary(normalizedMessages);
    const rawMessages = normalizedMessages.filter((message) => !isCompressionSummary(message));
    const head = rawMessages.slice(0, this.headMessageCount);
    const previousSummaryText = latestSummary?.message?.content ?? "";

    let unsummarizedStartIndex = head.length;
    if (latestSummary) {
      const previousTailStartId = String(latestSummary.message?.meta?.tailStartMessageId ?? "").trim();
      const previousTailStartIndex = findMessageIndexById(rawMessages, previousTailStartId);
      if (previousTailStartIndex >= 0) {
        unsummarizedStartIndex = previousTailStartIndex;
      }
    }

    let tailStartIndex = Math.max(unsummarizedStartIndex, rawMessages.length - this.tailMessageCount);
    tailStartIndex = alignTailBoundary(rawMessages, tailStartIndex);
    unsummarizedStartIndex = alignHeadBoundary(rawMessages, unsummarizedStartIndex);

    if (tailStartIndex <= unsummarizedStartIndex) {
      return {
        compressed: false,
        reason: "nothing_to_compact",
        usageRatio,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        messages: normalizedMessages
      };
    }

    const messagesToSummarize = rawMessages.slice(unsummarizedStartIndex, tailStartIndex);
    if (messagesToSummarize.length === 0) {
      return {
        compressed: false,
        reason: "empty_summary_window",
        usageRatio,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        messages: normalizedMessages
      };
    }

    let summaryBody = "";
    try {
      summaryBody = await this.summarizeMessages({
        runtimeConfig,
        previousSummary: previousSummaryText,
        messages: messagesToSummarize
      });
    } catch {
      summaryBody = createFallbackSummary({
        previousSummary: previousSummaryText,
        newMessages: messagesToSummarize
      });
    }

    const compressionId = createCompressionId();
    const tailStartMessage = rawMessages[tailStartIndex];
    const summaryMessage = {
      id: compressionId,
      role: "assistant",
      content: `${SUMMARY_PREFIX}\n${summaryBody}`.trim(),
      timestamp: Date.now(),
      toolCallId: "",
      toolName: "",
      toolCalls: [],
      meta: {
        kind: "compression_summary",
        compressionId,
        trigger,
        previousSummaryId: String(latestSummary?.message?.id ?? "").trim(),
        headMessageCount: this.headMessageCount,
        tailMessageCount: this.tailMessageCount,
        tailStartMessageId: String(tailStartMessage?.id ?? "").trim(),
        summarizedMessageIds: messagesToSummarize.map((message) => message.id),
        summarizedMessageCount: messagesToSummarize.length,
        createdAt: Date.now(),
        usageRatio
      }
    };

    const nextMessages = [...normalizedMessages, summaryMessage];
    const estimatedTokensAfter = this.estimateEffectiveConversationTokens(nextMessages);
    summaryMessage.meta.estimatedTokensAfter = estimatedTokensAfter;

    return {
      compressed: true,
      usageRatio,
      summaryMessage,
      estimatedTokensBefore,
      estimatedTokensAfter,
      messages: nextMessages
    };
  }
}
