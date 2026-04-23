import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearHistoryById,
  compressHistoryById,
  deleteHistoryById,
  deleteHistoryMessageById,
  fetchHistories,
  fetchHistoryById,
  forkHistoryById,
  fetchSkills,
  confirmToolApprovalById,
  rejectToolApprovalById,
  selectWorkplaceBySystemDialog,
  stopConversationRunById,
  subscribeChatEvents,
  updateHistoryApprovalModeById,
  updateHistoryWorkplaceById,
  updateHistorySkillsById,
  upsertHistoryById,
  streamChat
} from "../../api/chatApi";
import {
  applyToolResultToPayload,
  applyToolPendingApprovalToPayload,
  createToolMessagePayloadFromCall,
  createToolMessagePayloadFromResult,
  parseToolMessagePayload,
  serializeToolMessagePayload
} from "./toolMessageCodec";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createConversationId() {
  return createId("conv");
}

function clipText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

const LOCAL_QUEUE_STATE_KEY = "localQueueState";
const LEGACY_RETRY_NOTICE_PATTERN = /^请求重试：第\s*\d+\s*次，等待\s*\d+\s*ms$/;
const EMPTY_COMPRESSION_STATE = Object.freeze({
  inProgress: false,
  trigger: "",
  conversationId: ""
});

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

function normalizeImageAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments
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
        .filter(Boolean)
    : [];
}

function normalizeParsedFileAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments
        .map((attachment, index) => {
          const name = String(attachment?.name ?? `文件_${index + 1}`).trim();
          if (!name) {
            return null;
          }

          return {
            id: String(attachment?.id ?? `parsed_file_${index}`).trim() || `parsed_file_${index}`,
            name,
            mimeType: String(attachment?.mimeType ?? "").trim(),
            extension: String(attachment?.extension ?? "").trim(),
            size: Number(attachment?.size ?? 0),
            parseStatus: String(attachment?.parseStatus ?? "unsupported").trim() || "unsupported",
            note: String(attachment?.note ?? "").trim(),
            extractedText: String(attachment?.extractedText ?? "")
          };
        })
        .filter(Boolean)
    : [];
}

function normalizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  const nextMeta = { ...meta };
  const attachments = normalizeImageAttachments(meta.attachments);
  if (attachments.length > 0) {
    nextMeta.attachments = attachments;
  }

  return nextMeta;
}

function isRetryNoticeMessage(message) {
  const role = String(message?.role ?? "").trim();
  const content = String(message?.content ?? "").trim();
  const kind = String(message?.meta?.kind ?? "").trim();

  if (kind === "retry_notice") {
    return true;
  }

  return role === "system" && LEGACY_RETRY_NOTICE_PATTERN.test(content);
}

function getLocalQueueState(message) {
  return String(message?.meta?.[LOCAL_QUEUE_STATE_KEY] ?? "").trim();
}

function clearLocalQueueStateFromMeta(meta) {
  const nextMeta = normalizeMessageMeta(meta);
  if (Object.prototype.hasOwnProperty.call(nextMeta, LOCAL_QUEUE_STATE_KEY)) {
    delete nextMeta[LOCAL_QUEUE_STATE_KEY];
  }
  return nextMeta;
}

function resolveTimestampFromMessageId(messageId) {
  const normalizedMessageId = String(messageId ?? "").trim();
  if (!normalizedMessageId) {
    return 0;
  }

  const fragments = normalizedMessageId.split("_");
  if (fragments.length < 3) {
    return 0;
  }

  const candidateTimestamp = Number(fragments[1] ?? 0);
  return Number.isFinite(candidateTimestamp) && candidateTimestamp > 0
    ? Math.trunc(candidateTimestamp)
    : 0;
}

function normalizeMessageTimestamp(timestamp, messageId) {
  const numericTimestamp = Number(timestamp ?? 0);
  if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) {
    return Math.trunc(numericTimestamp);
  }

  return resolveTimestampFromMessageId(messageId);
}

function normalizeChatMessage(message) {
  const normalizedMessageId = String(message?.id ?? "");
  const base = {
    id: normalizedMessageId,
    role: String(message?.role ?? "user"),
    content: String(message?.content ?? ""),
    reasoningContent: String(message?.reasoningContent ?? ""),
    reasoningStartedAt: Number(message?.reasoningStartedAt ?? 0),
    reasoningFinishedAt: Number(message?.reasoningFinishedAt ?? 0),
    timestamp: normalizeMessageTimestamp(message?.timestamp, normalizedMessageId),
    toolCallId: String(message?.toolCallId ?? "").trim(),
    toolName: String(message?.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message?.toolCalls),
    meta: normalizeMessageMeta(message?.meta),
    tokenUsage: message?.tokenUsage ?? null
  };

  if (base.role === "tool" && String(base.meta.kind ?? "").trim() !== "tool_event") {
    const legacyPayload = parseToolMessagePayload(base.content);
    if (legacyPayload) {
      base.toolCallId = base.toolCallId || String(legacyPayload.toolCallId ?? "").trim();
      base.toolName = base.toolName || String(legacyPayload.toolName ?? "").trim();
      base.meta = {
        kind: "tool_event",
        ...legacyPayload
      };
    }
  }

  return base;
}

function buildPreviewFromMessages(messages) {
  const last = [...messages]
    .reverse()
    .find((item) => {
      const normalized = normalizeChatMessage(item);
      return (
        normalized.content.trim().length > 0 ||
        normalizeImageAttachments(normalized.meta?.attachments).length > 0
      );
    });

  if (!last) {
    return "";
  }

  const normalized = normalizeChatMessage(last);
  const kind = String(normalized.meta?.kind ?? "").trim();
  const imageCount = normalizeImageAttachments(normalized.meta?.attachments).length;

  if (kind === "tool_image_input") {
    const toolName = String(normalized.meta?.toolName ?? "").trim();
    const label = toolName ? `工具看图(${toolName})` : "工具看图";
    return imageCount > 0 ? `${label} [图片 ${imageCount}]` : label;
  }

  if (!normalized.content.trim()) {
    return imageCount > 0 ? `[图片 ${imageCount}]` : "";
  }

  return clipText((normalized.content ?? "").trim(), 80);
}

function toSummary(history) {
  const safeMessages = Array.isArray(history?.messages) ? history.messages : [];
  const tokenUsage = normalizeTokenUsage(history?.tokenUsage ?? {});
  const subagents = Array.isArray(history?.subagents)
    ? history.subagents
        .map((item) => ({
          agentId: String(item?.agentId ?? "").trim(),
          agentType: String(item?.agentType ?? "").trim(),
          agentDisplayName: String(item?.agentDisplayName ?? "").trim(),
          agentStatus: String(item?.agentStatus ?? "idle").trim() || "idle",
          agentBusy: Boolean(item?.agentBusy),
          conversationId: String(item?.conversationId ?? "").trim(),
          lastActiveAt: Number(item?.lastActiveAt ?? 0)
        }))
        .filter((item) => item.agentId.length > 0 || item.conversationId.length > 0)
    : [];

  return {
    id: String(history?.id ?? ""),
    title: String(history?.title ?? "新会话"),
    workplacePath: String(history?.workplacePath ?? ""),
    parentConversationId: String(history?.parentConversationId ?? "").trim(),
    source: String(history?.source ?? "chat").trim() || "chat",
    model: String(history?.model ?? "").trim(),
    workplaceLocked: Boolean(history?.workplaceLocked),
    approvalMode: String(history?.approvalMode ?? "confirm"),
    developerPrompt: String(history?.developerPrompt ?? ""),
    skills: Array.isArray(history?.skills)
      ? history.skills.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
    preview: String(history?.preview ?? buildPreviewFromMessages(safeMessages)),
    createdAt: Number(history?.createdAt ?? 0),
    updatedAt: Number(history?.updatedAt ?? Date.now()),
    messageCount: Number(history?.messageCount ?? safeMessages.length),
    tokenUsage,
    agentId: String(history?.agentId ?? "").trim(),
    agentType: String(history?.agentType ?? "").trim(),
    agentDisplayName: String(history?.agentDisplayName ?? "").trim(),
    agentStatus: String(history?.agentStatus ?? "idle").trim() || "idle",
    agentBusy: Boolean(history?.agentBusy),
    subagentCount: Number(history?.subagentCount ?? subagents.length ?? 0),
    subagents
  };
}

function normalizeSummaryList(histories) {
  return histories.map((item) => ({
    id: String(item.id),
    title: String(item.title ?? "新会话"),
    workplacePath: String(item.workplacePath ?? ""),
    parentConversationId: String(item?.parentConversationId ?? "").trim(),
    source: String(item?.source ?? "chat").trim() || "chat",
    model: String(item?.model ?? "").trim(),
    workplaceLocked: Boolean(item.workplaceLocked),
    approvalMode: String(item.approvalMode ?? "confirm"),
    developerPrompt: String(item.developerPrompt ?? ""),
    skills: Array.isArray(item.skills)
      ? item.skills.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [],
    preview: String(item.preview ?? ""),
    createdAt: Number(item.createdAt ?? 0),
    updatedAt: Number(item.updatedAt ?? Date.now()),
    messageCount: Number(item.messageCount ?? 0),
    tokenUsage: normalizeTokenUsage(item?.tokenUsage ?? {}),
    agentId: String(item?.agentId ?? "").trim(),
    agentType: String(item?.agentType ?? "").trim(),
    agentDisplayName: String(item?.agentDisplayName ?? "").trim(),
    agentStatus: String(item?.agentStatus ?? "idle").trim() || "idle",
    agentBusy: Boolean(item?.agentBusy),
    subagentCount: Number(item?.subagentCount ?? 0),
    subagents: Array.isArray(item?.subagents)
      ? item.subagents
          .map((subagent) => ({
            agentId: String(subagent?.agentId ?? "").trim(),
            agentType: String(subagent?.agentType ?? "").trim(),
            agentDisplayName: String(subagent?.agentDisplayName ?? "").trim(),
            agentStatus: String(subagent?.agentStatus ?? "idle").trim() || "idle",
            agentBusy: Boolean(subagent?.agentBusy),
            conversationId: String(subagent?.conversationId ?? "").trim(),
            lastActiveAt: Number(subagent?.lastActiveAt ?? 0)
          }))
          .filter((subagent) => subagent.agentId.length > 0 || subagent.conversationId.length > 0)
      : []
  }));
}

function compareConversationSummary(left, right) {
  const leftUpdatedAt = Number(left?.updatedAt ?? 0);
  const rightUpdatedAt = Number(right?.updatedAt ?? 0);
  if (rightUpdatedAt !== leftUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  const leftCreatedAt = Number(left?.createdAt ?? 0);
  const rightCreatedAt = Number(right?.createdAt ?? 0);
  if (rightCreatedAt !== leftCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }

  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function collectSubagentDescendantConversationIds(conversationList, rootConversationId) {
  const normalizedRootConversationId = String(rootConversationId ?? "").trim();
  if (
    !normalizedRootConversationId ||
    !Array.isArray(conversationList) ||
    conversationList.length === 0
  ) {
    return [];
  }

  const childrenByParentConversationId = new Map();
  for (const summary of conversationList) {
    const conversationId = String(summary?.id ?? "").trim();
    const parentConversationId = String(summary?.parentConversationId ?? "").trim();
    if (!conversationId || !parentConversationId) {
      continue;
    }

    const children = childrenByParentConversationId.get(parentConversationId);
    if (children) {
      children.push(summary);
    } else {
      childrenByParentConversationId.set(parentConversationId, [summary]);
    }
  }

  const visitedConversationIds = new Set([normalizedRootConversationId]);
  const pendingConversationIds = [normalizedRootConversationId];
  const descendantSubagentConversationIds = new Set();

  while (pendingConversationIds.length > 0) {
    const currentConversationId = String(pendingConversationIds.pop() ?? "").trim();
    if (!currentConversationId) {
      continue;
    }

    const childConversations = childrenByParentConversationId.get(currentConversationId) ?? [];
    for (const childConversation of childConversations) {
      const childConversationId = String(childConversation?.id ?? "").trim();
      if (!childConversationId || visitedConversationIds.has(childConversationId)) {
        continue;
      }

      visitedConversationIds.add(childConversationId);
      pendingConversationIds.push(childConversationId);

      if (String(childConversation?.source ?? "").trim().toLowerCase() === "subagent") {
        descendantSubagentConversationIds.add(childConversationId);
      }
    }
  }

  return Array.from(descendantSubagentConversationIds);
}

function normalizeSkillCatalog(skills) {
  return skills
    .map((item) => ({
      scope: String(item?.scope ?? ""),
      skillKey: String(item?.skillKey ?? ""),
      name: String(item?.name ?? ""),
      displayName: String(item?.displayName ?? item?.name ?? ""),
      shortDescription: String(item?.shortDescription ?? item?.description ?? ""),
      defaultPrompt: String(item?.defaultPrompt ?? ""),
      description: String(item?.description ?? ""),
      version: String(item?.version ?? "1.0.0"),
      author: String(item?.author ?? ""),
      license: String(item?.license ?? ""),
      platforms: Array.isArray(item?.platforms)
        ? item.platforms.map((value) => String(value ?? "")).filter(Boolean)
        : [],
      prerequisites: Array.isArray(item?.prerequisites)
        ? item.prerequisites.map((value) => String(value ?? "")).filter(Boolean)
        : [],
      requiredEnvironmentVariables: Array.isArray(item?.requiredEnvironmentVariables)
        ? item.requiredEnvironmentVariables.map((value) => String(value ?? "")).filter(Boolean)
        : [],
      category: String(item?.category ?? ""),
      relativePath: String(item?.relativePath ?? ""),
      isSystem: Boolean(item?.isSystem),
      selected: Boolean(item?.selected),
      enabled: Boolean(item?.enabled),
      hidden: Boolean(item?.hidden)
    }))
    .filter((item) => item.name.length > 0);
}

function skillCatalogEntrySignature(item) {
  return [
    item.scope,
    item.skillKey,
    item.name,
    item.displayName,
    item.shortDescription,
    item.category,
    item.relativePath,
    item.isSystem ? "1" : "0",
    item.enabled ? "1" : "0",
    item.hidden ? "1" : "0"
  ].join("|");
}

function isSameSkillCatalog(previous, next) {
  if (previous === next) {
    return true;
  }

  if (!Array.isArray(previous) || !Array.isArray(next)) {
    return false;
  }

  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (skillCatalogEntrySignature(previous[index]) !== skillCatalogEntrySignature(next[index])) {
      return false;
    }
  }

  return true;
}

function normalizeDeveloperPrompt(value) {
  return String(value ?? "").trim();
}

function normalizeTokenUsage(value) {
  return {
    promptTokens: Number(value?.promptTokens ?? 0),
    completionTokens: Number(value?.completionTokens ?? 0),
    totalTokens: Number(value?.totalTokens ?? 0),
    usageCount: Number(value?.usageCount ?? 0),
    lastUsedAt: Number(value?.lastUsedAt ?? 0),
    promptTokensDetails: value?.promptTokensDetails ?? null,
    completionTokensDetails: value?.completionTokensDetails ?? null
  };
}

function hasUsableTokenUsage(value) {
  return Number(value?.totalTokens ?? 0) > 0;
}

function normalizeTokenUsageRecord(value) {
  return {
    id: String(value?.id ?? ""),
    conversationId: String(value?.conversationId ?? ""),
    model: String(value?.model ?? ""),
    promptTokens: Number(value?.promptTokens ?? 0),
    completionTokens: Number(value?.completionTokens ?? 0),
    totalTokens: Number(value?.totalTokens ?? 0),
    promptTokensDetails: value?.promptTokensDetails ?? null,
    completionTokensDetails: value?.completionTokensDetails ?? null,
    createdAt: Number(value?.createdAt ?? Date.now())
  };
}

function normalizeLoadedMessages(messages) {
  return Array.isArray(messages)
    ? messages
        .map((item) => normalizeChatMessage(item))
        .filter((item) => !isRetryNoticeMessage(item))
    : [];
}

function mergePersistedAndReplayMessages(persistedMessages, replayMessages) {
  const normalizedPersistedMessages = normalizeLoadedMessages(persistedMessages);
  const normalizedReplayMessages = normalizeLoadedMessages(replayMessages);

  if (normalizedReplayMessages.length === 0) {
    return normalizedPersistedMessages;
  }

  if (normalizedPersistedMessages.length === 0) {
    return normalizedReplayMessages;
  }

  const mergedMessages = normalizedPersistedMessages.slice();
  const indexByMessageId = new Map();

  for (let index = 0; index < mergedMessages.length; index += 1) {
    const messageId = String(mergedMessages[index]?.id ?? "").trim();
    if (!messageId || indexByMessageId.has(messageId)) {
      continue;
    }
    indexByMessageId.set(messageId, index);
  }

  for (const replayMessage of normalizedReplayMessages) {
    const replayMessageId = String(replayMessage?.id ?? "").trim();
    if (!replayMessageId) {
      mergedMessages.push(replayMessage);
      continue;
    }

    const existingIndex = indexByMessageId.get(replayMessageId);
    if (typeof existingIndex === "number") {
      mergedMessages[existingIndex] = replayMessage;
      continue;
    }

    indexByMessageId.set(replayMessageId, mergedMessages.length);
    mergedMessages.push(replayMessage);
  }

  return mergedMessages;
}

function getCompressionResultMessage(compression, trigger = "manual") {
  const reason = String(compression?.reason ?? "").trim();
  const normalizedTrigger = String(trigger ?? "").trim() === "auto" ? "auto" : "manual";

  if (reason === "manual_threshold_not_reached") {
    return "当前上下文占用不足 20%，暂不允许手动压缩";
  }

  if (reason === "nothing_to_compact" || reason === "empty_summary_window") {
    return "当前会话轮次太少或保留窗口已覆盖全部消息，暂无可压缩内容";
  }

  if (!compression?.compressed && normalizedTrigger === "manual") {
    return "手动压缩未生成新的上下文摘要";
  }

  return "";
}

function normalizeConversationRuntimeReplyError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const message = String(value.message ?? "").trim();
  if (!message) {
    return null;
  }

  return {
    messageId: String(value.messageId ?? "").trim(),
    message,
    createdAt: Number(value.createdAt ?? Date.now())
  };
}

function buildConversationUpsertPayload({
  title = "新会话",
  workplacePath = "",
  approvalMode = "confirm",
  developerPrompt = "",
  skills = [],
  messages = []
} = {}) {
  const payload = {
    title: String(title ?? "").trim() || "新会话",
    approvalMode: String(approvalMode ?? "").trim() === "auto" ? "auto" : "confirm",
    developerPrompt: normalizeDeveloperPrompt(developerPrompt),
    skills: Array.isArray(skills)
      ? Array.from(
          new Set(
            skills.map((item) => String(item ?? "").trim()).filter(Boolean)
          )
        )
      : [],
    messages: toPersistableMessages(messages)
  };

  const normalizedWorkplacePath = String(workplacePath ?? "").trim();
  if (normalizedWorkplacePath) {
    payload.workplacePath = normalizedWorkplacePath;
  }

  return payload;
}

function buildPersistenceSignature({
  title = "新会话",
  messages = [],
  skills = [],
  workplacePath = "",
  approvalMode = "confirm",
  developerPrompt = ""
} = {}) {
  return JSON.stringify({
    title: String(title ?? "").trim() || "新会话",
    messages: toPersistableMessages(messages),
    skills: Array.isArray(skills) ? skills : [],
    workplacePath: String(workplacePath ?? "").trim(),
    approvalMode: String(approvalMode ?? "").trim() === "auto" ? "auto" : "confirm",
    developerPrompt: normalizeDeveloperPrompt(developerPrompt)
  });
}

function isSameSummary(left, right) {
  const leftTokenUsage = left?.tokenUsage ?? {};
  const rightTokenUsage = right?.tokenUsage ?? {};

  return (
    left?.id === right?.id &&
    left?.title === right?.title &&
    left?.workplacePath === right?.workplacePath &&
    left?.parentConversationId === right?.parentConversationId &&
    left?.source === right?.source &&
    left?.model === right?.model &&
    left?.workplaceLocked === right?.workplaceLocked &&
    left?.approvalMode === right?.approvalMode &&
    left?.developerPrompt === right?.developerPrompt &&
    JSON.stringify(left?.skills ?? []) === JSON.stringify(right?.skills ?? []) &&
    left?.preview === right?.preview &&
    left?.createdAt === right?.createdAt &&
    left?.updatedAt === right?.updatedAt &&
    left?.messageCount === right?.messageCount &&
    left?.agentId === right?.agentId &&
    left?.agentType === right?.agentType &&
    left?.agentDisplayName === right?.agentDisplayName &&
    left?.agentStatus === right?.agentStatus &&
    left?.agentBusy === right?.agentBusy &&
    left?.subagentCount === right?.subagentCount &&
    JSON.stringify(left?.subagents ?? []) === JSON.stringify(right?.subagents ?? []) &&
    leftTokenUsage.promptTokens === rightTokenUsage.promptTokens &&
    leftTokenUsage.completionTokens === rightTokenUsage.completionTokens &&
    leftTokenUsage.totalTokens === rightTokenUsage.totalTokens &&
    leftTokenUsage.usageCount === rightTokenUsage.usageCount &&
    leftTokenUsage.lastUsedAt === rightTokenUsage.lastUsedAt
  );
}

function upsertSummary(summaries, nextSummary) {
  const next = [nextSummary, ...summaries.filter((item) => item.id !== nextSummary.id)];
  const sorted = next.sort(compareConversationSummary);

  if (
    sorted.length === summaries.length &&
    sorted.every((item, index) => isSameSummary(item, summaries[index]))
  ) {
    return summaries;
  }

  return sorted;
}

function replaceSummaryById(summaries, nextSummary) {
  const index = summaries.findIndex((item) => item.id === nextSummary.id);

  if (index < 0) {
    return upsertSummary(summaries, nextSummary);
  }

  const next = summaries.slice();
  next[index] = nextSummary;

  if (
    next.length === summaries.length &&
    next.every((item, currentIndex) => isSameSummary(item, summaries[currentIndex]))
  ) {
    return summaries;
  }

  return next;
}

function mergeSummaryList(current, incoming) {
  const incomingIds = new Set(incoming.map((item) => item.id));
  let merged = current;

  for (const item of incoming) {
    merged = upsertSummary(merged, item);
  }

  const filtered = merged.filter((item) => incomingIds.has(item.id));

  if (
    filtered.length === current.length &&
    filtered.every((item, index) => isSameSummary(item, current[index]))
  ) {
    return current;
  }

  return filtered;
}

function findConversationSummaryById(summaries, conversationId) {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return null;
  }

  return (Array.isArray(summaries) ? summaries : []).find(
    (item) => String(item?.id ?? "").trim() === normalizedConversationId
  ) ?? null;
}

function resolveSkillOwnerConversationId(conversationId, summaries, draftConversation = null) {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return "";
  }

  if (draftConversation?.id === normalizedConversationId) {
    return normalizedConversationId;
  }

  const current = findConversationSummaryById(summaries, normalizedConversationId);
  const source = String(current?.source ?? "").trim().toLowerCase();
  if (source === "subagent") {
    const parentConversationId = String(current?.parentConversationId ?? "").trim();
    if (parentConversationId) {
      return parentConversationId;
    }
  }

  return normalizedConversationId;
}

function resolveConversationSkills(conversationId, summaries, draftConversation = null) {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return [];
  }

  const ownerConversationId = resolveSkillOwnerConversationId(
    normalizedConversationId,
    summaries,
    draftConversation
  );

  if (draftConversation?.id === ownerConversationId) {
    return Array.isArray(draftConversation.skills) ? draftConversation.skills : [];
  }

  const ownerSummary =
    findConversationSummaryById(summaries, ownerConversationId) ??
    findConversationSummaryById(summaries, normalizedConversationId);

  return Array.isArray(ownerSummary?.skills) ? ownerSummary.skills : [];
}

function toPersistableMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((item) => {
    const normalized = normalizeChatMessage(item);
    if (getLocalQueueState(normalized) === "queued" || isRetryNoticeMessage(normalized)) {
      return null;
    }

    const persistedTimestamp =
      normalizeMessageTimestamp(normalized.timestamp, normalized.id) || Date.now();

    const payload = {
      id: normalized.id,
      role: normalized.role,
      content: normalized.content,
      timestamp: persistedTimestamp
    };

    if (normalized.reasoningContent) {
      payload.reasoningContent = normalized.reasoningContent;
    }

    if (normalized.toolCallId) {
      payload.toolCallId = normalized.toolCallId;
    }

    if (normalized.toolName) {
      payload.toolName = normalized.toolName;
    }

    if (normalized.toolCalls.length > 0) {
      payload.toolCalls = normalized.toolCalls;
    }

    if (normalized.meta && Object.keys(normalized.meta).length > 0) {
      const persistedMeta = clearLocalQueueStateFromMeta(normalized.meta);
      if (Object.keys(persistedMeta).length > 0) {
        payload.meta = persistedMeta;
      }
    }

    if (hasUsableTokenUsage(normalized.tokenUsage)) {
      payload.tokenUsage = normalized.tokenUsage;
    }

    return payload;
  }).filter(Boolean);
}

function normalizeForApi(messages) {
  return toPersistableMessages(messages);
}

function findToolMessageIndex(messages, event) {
  const toolCallId =
    typeof event?.toolCallId === "string" ? event.toolCallId.trim() : "";
  const toolName =
    typeof event?.toolName === "string" ? event.toolName.trim() : "";

  if (toolCallId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item.role !== "tool") {
        continue;
      }

      const payload = parseToolMessagePayload(item.content);
      if (payload && payload.toolCallId === toolCallId) {
        return index;
      }
    }
  }

  if (toolName) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item.role !== "tool") {
        continue;
      }

      const payload = parseToolMessagePayload(item.content);
      if (payload && payload.toolName === toolName && !payload.result) {
        return index;
      }
    }
  }

  return -1;
}

export function useChatSession(maxContextWindow = 0) {
  const [messages, setMessages] = useState([]);
  const [queuedUserMessages, setQueuedUserMessages] = useState([]);
  const [conversationList, setConversationList] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [draftConversation, setDraftConversation] = useState(null);
  const [workplaceSelecting, setWorkplaceSelecting] = useState(false);
  const [pendingApprovalsByConversation, setPendingApprovalsByConversation] = useState({});
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [retryNotice, setRetryNotice] = useState("");
  const [conversationRuntimeReplyErrors, setConversationRuntimeReplyErrors] = useState({});
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const [skillsDrawerOpen, setSkillsDrawerOpen] = useState(false);
  const [skillCatalog, setSkillCatalog] = useState([]);
  const [skillCatalogLoaded, setSkillCatalogLoaded] = useState(false);
  const [tokenUsageRecords, setTokenUsageRecords] = useState([]);
  const [compressionState, setCompressionState] = useState(EMPTY_COMPRESSION_STATE);
  const compressionStateRef = useRef(EMPTY_COMPRESSION_STATE);

  const abortRef = useRef(null);
  const hydratedRef = useRef(false);
  const lastPersistedSignatureRef = useRef("");
  const selectedSkillsRef = useRef([]);
  const messagesRef = useRef([]);
  const activeConversationIdRef = useRef("");
  const queuedUserMessagesRef = useRef([]);
  const pendingApprovalsByConversationRef = useRef({});
  const streamLoopActiveRef = useRef(false);
  const conversationListRef = useRef([]);
  const draftConversationRef = useRef(null);
  const conversationMessageCacheRef = useRef(new Map());
  const conversationRuntimeReplyErrorsRef = useRef({});
  const streamingConversationIdRef = useRef("");
  const externalStreamStatesRef = useRef(new Map());
  const externalAgentEventHandlerRef = useRef(null);
  const activeAgentRunConversationIdsRef = useRef(new Set());
  const processedRunEventSeqByRunIdRef = useRef(new Map());

  const isStreaming = status === "streaming";
  const isCompressing =
    compressionState.inProgress &&
    String(compressionState.conversationId ?? "").trim() === String(activeConversationId ?? "").trim();
  const isDraftConversationActive = draftConversation?.id === activeConversationId;

  const activeConversationTitle = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return "新会话";
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    if (current?.title) {
      return current.title;
    }

    return "新会话";
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationWorkplace = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return String(draftConversation.workplacePath ?? "");
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    return String(current?.workplacePath ?? "");
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationWorkplaceLocked = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return false;
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    return Boolean(current?.workplaceLocked);
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationApprovalMode = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return String(draftConversation.approvalMode ?? "confirm");
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    return String(current?.approvalMode ?? "confirm");
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationDeveloperPrompt = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return normalizeDeveloperPrompt(draftConversation.developerPrompt ?? "");
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    return normalizeDeveloperPrompt(current?.developerPrompt ?? "");
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationSkillOwnerId = useMemo(
    () => resolveSkillOwnerConversationId(activeConversationId, conversationList, draftConversation),
    [conversationList, activeConversationId, draftConversation]
  );

  const activeConversationSkills = useMemo(() => {
    return resolveConversationSkills(activeConversationId, conversationList, draftConversation);
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationSource = useMemo(() => {
    if (draftConversation?.id === activeConversationId) {
      return "chat";
    }

    const current = conversationList.find((item) => item.id === activeConversationId);
    return String(current?.source ?? "chat").trim() || "chat";
  }, [conversationList, activeConversationId, draftConversation]);

  const activeConversationAgentDisplayName = useMemo(() => {
    const current = conversationList.find((item) => item.id === activeConversationId);
    return String(current?.agentDisplayName ?? "").trim();
  }, [conversationList, activeConversationId]);

  const activeConversationSubagents = useMemo(() => {
    const current = conversationList.find((item) => item.id === activeConversationId);
    return Array.isArray(current?.subagents) ? current.subagents : [];
  }, [conversationList, activeConversationId]);
  const activeConversationRuntimeReplyError = useMemo(() => {
    const normalizedConversationId = String(activeConversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    return normalizeConversationRuntimeReplyError(
      conversationRuntimeReplyErrors[normalizedConversationId]
    );
  }, [activeConversationId, conversationRuntimeReplyErrors]);

  const activeQueuedUserMessages = useMemo(
    () =>
      queuedUserMessages.filter(
        (item) => String(item?.conversationId ?? "").trim() === String(activeConversationId ?? "").trim()
      ),
    [queuedUserMessages, activeConversationId]
  );
  const pendingApproval = useMemo(() => {
    const normalizedConversationId = String(activeConversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    const approval = pendingApprovalsByConversation[normalizedConversationId];
    return approval && typeof approval === "object" ? approval : null;
  }, [pendingApprovalsByConversation, activeConversationId]);

  const activeConversationTokenUsage = useMemo(() => {
    const current = conversationList.find((item) => item.id === activeConversationId);

    if (!current?.tokenUsage) {
      return normalizeTokenUsage({});
    }

    return normalizeTokenUsage(current.tokenUsage);
  }, [conversationList, activeConversationId]);

  const activeConversationContextTokens = useMemo(() => {
    const latestRecordedTotal = Number(activeConversationTokenUsage?.totalTokens ?? 0);
    if (latestRecordedTotal > 0) {
      return latestRecordedTotal;
    }

    return 0;
  }, [activeConversationTokenUsage]);

  const activeConversationContextUsageRatio = useMemo(() => {
    const maxWindow = Number(maxContextWindow ?? 0);
    if (!Number.isFinite(maxWindow) || maxWindow <= 0) {
      return 0;
    }

    return activeConversationContextTokens / maxWindow;
  }, [activeConversationContextTokens, maxContextWindow]);

  const activeConversationAgentBusy = useMemo(() => {
    const normalizedConversationId = String(activeConversationId ?? "").trim();
    if (!normalizedConversationId) {
      return false;
    }

    if (activeAgentRunConversationIdsRef.current.has(normalizedConversationId)) {
      return true;
    }
    return false;
  }, [activeConversationId, conversationList]);

  const activeConversationHasForegroundStream = useMemo(() => {
    const normalizedConversationId = String(activeConversationId ?? "").trim();
    if (!normalizedConversationId || !isStreaming) {
      return false;
    }

    return String(streamingConversationIdRef.current ?? "").trim() === normalizedConversationId;
  }, [activeConversationId, isStreaming]);

  const activeConversationIsRunning =
    activeConversationHasForegroundStream || activeConversationAgentBusy;
  const activeConversationCanStop = activeConversationIsRunning;
  const activeCompressionTrigger = isCompressing ? String(compressionState.trigger ?? "") : "";

  const canManualCompress = useMemo(() => {
    if (!Number.isFinite(Number(maxContextWindow ?? 0)) || Number(maxContextWindow ?? 0) <= 0) {
      return false;
    }

    return activeConversationContextUsageRatio >= 0.2;
  }, [activeConversationContextUsageRatio, maxContextWindow]);

  useEffect(() => {
    let mounted = true;

    async function hydrateHistory() {
      setStatus("loading");

      try {
        const listResponse = await fetchHistories();
        if (!mounted) {
          return;
        }

        const histories = normalizeSummaryList(
          Array.isArray(listResponse?.histories) ? listResponse.histories : []
        );

        if (histories.length === 0) {
          const draftConversationId = createConversationId();
          if (!mounted) {
            return;
          }

          selectedSkillsRef.current = [];
          updateCompressionState(EMPTY_COMPRESSION_STATE);
          setConversationList([]);
          setActiveConversationId(draftConversationId);
          lastPersistedSignatureRef.current = "";
          setDraftConversation({
            id: draftConversationId,
            workplacePath: "",
            approvalMode: "confirm",
            developerPrompt: "",
            skills: []
          });
          setMessages([]);
          setTokenUsageRecords([]);
          setPendingApprovalValue(null, { clearAll: true });
          return;
        }

        const initialConversationId = histories[0].id;
        const detailResponse = await fetchHistoryById(initialConversationId);

        if (!mounted) {
          return;
        }

        const loadedHistory = detailResponse?.history;
        const loadedMessages = Array.isArray(loadedHistory?.messages)
          ? loadedHistory.messages
          : [];
        const normalizedLoadedMessages = normalizeLoadedMessages(loadedMessages);
        const replayedCachedMessages = readConversationMessages(initialConversationId);
        const initialMessagesForView = mergePersistedAndReplayMessages(
          normalizedLoadedMessages,
          replayedCachedMessages
        );

        const loadedSummary = toSummary(loadedHistory);
        const nextConversationList = upsertSummary(histories, loadedSummary);
        selectedSkillsRef.current = [
          ...resolveConversationSkills(initialConversationId, nextConversationList, null)
        ];
        setConversationList(nextConversationList);
        setDraftConversation(null);
        setActiveConversationId(initialConversationId);
        updateCompressionState((prev) => {
          const normalizedConversationId = String(prev?.conversationId ?? "").trim();
          if (!prev?.inProgress || !normalizedConversationId) {
            return EMPTY_COMPRESSION_STATE;
          }

          const hasConversation = nextConversationList.some(
            (item) => String(item?.id ?? "").trim() === normalizedConversationId
          );
          return hasConversation
            ? {
                inProgress: true,
                trigger: String(prev?.trigger ?? "auto").trim() || "auto",
                conversationId: normalizedConversationId
              }
            : EMPTY_COMPRESSION_STATE;
        });
        lastPersistedSignatureRef.current = "";
        const loadedTokenUsageRecords = Array.isArray(loadedHistory?.tokenUsageRecords)
          ? loadedHistory.tokenUsageRecords.map(normalizeTokenUsageRecord)
          : [];

        writeConversationMessages(initialConversationId, initialMessagesForView);
        setMessages(initialMessagesForView);
        setTokenUsageRecords(loadedTokenUsageRecords);
        setPendingApprovalValue(null, { clearAll: true });
      } catch (historyError) {
        if (mounted) {
          setError(historyError?.message || "加载历史失败");
        }
      } finally {
        if (mounted) {
          hydratedRef.current = true;
          setHistoryLoaded(true);
          setStatus("idle");
        }
      }
    }

    hydrateHistory();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    externalAgentEventHandlerRef.current = (event) => {
      const normalizedConversationId = String(event?.conversationId ?? "").trim();
      if (!normalizedConversationId) {
        return;
      }

      const nextEvent =
        event && typeof event === "object" && !Array.isArray(event)
          ? { ...event }
          : {};
      delete nextEvent.conversationId;

      const streamStateMap = externalStreamStatesRef.current;
      const streamState = streamStateMap.get(normalizedConversationId) ?? {
        activeAssistantMessageId: null
      };
      streamStateMap.set(normalizedConversationId, streamState);

      const handled = applyAgentEvent(nextEvent, streamState, normalizedConversationId, {
        source: "external"
      });
      if (handled && String(nextEvent?.type ?? "").trim() === "session_end") {
        streamStateMap.delete(normalizedConversationId);
      }
    };
  });

  useEffect(() => {
    const unsubscribe = subscribeChatEvents({
      onAgentEvent: (event) => {
        externalAgentEventHandlerRef.current?.(event);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  async function refreshSkillCatalog(workspacePath = activeConversationWorkplace) {
    try {
      const response = await fetchSkills({
        workspacePath,
        includeGlobal: true,
        includeProject: true,
        includeSystem: true
      });

      const nextSkillCatalog = normalizeSkillCatalog(
        Array.isArray(response?.skills) ? response.skills : []
      );

      setSkillCatalog((previous) =>
        isSameSkillCatalog(previous, nextSkillCatalog) ? previous : nextSkillCatalog
      );
    } catch {
      setSkillCatalog([]);
    } finally {
      setSkillCatalogLoaded(true);
    }
  }

  useEffect(() => {
    let mounted = true;
    let timerId = null;

    async function loadSkillCatalog() {
      await refreshSkillCatalog(activeConversationWorkplace);
      if (!mounted) {
        return;
      }
    }

    loadSkillCatalog();
    timerId = setInterval(loadSkillCatalog, 8000);

    return () => {
      mounted = false;
      if (timerId) {
        clearInterval(timerId);
      }
    };
  }, [activeConversationWorkplace]);

  useEffect(() => {
    lastPersistedSignatureRef.current = "";
  }, [activeConversationId]);

  useEffect(() => {
    messagesRef.current = Array.isArray(messages) ? messages.map(normalizeChatMessage) : [];
    const normalizedConversationId = String(activeConversationId ?? "").trim();
    if (normalizedConversationId) {
      conversationMessageCacheRef.current.set(normalizedConversationId, messagesRef.current);
    }
  }, [messages, activeConversationId]);

  useEffect(() => {
    activeConversationIdRef.current = String(activeConversationId ?? "").trim();
  }, [activeConversationId]);

  useEffect(() => {
    conversationListRef.current = Array.isArray(conversationList)
      ? conversationList.map((item) => ({ ...item }))
      : [];
  }, [conversationList]);

  useEffect(() => {
    draftConversationRef.current = draftConversation ? { ...draftConversation } : null;
  }, [draftConversation]);

  useEffect(() => {
    setRetryNotice("");
  }, [activeConversationId]);

  useEffect(() => {
    selectedSkillsRef.current = Array.isArray(activeConversationSkills)
      ? [...activeConversationSkills]
      : [];
  }, [activeConversationId, activeConversationSkills]);

  useEffect(() => {
    queuedUserMessagesRef.current = Array.isArray(queuedUserMessages)
      ? queuedUserMessages.map((item) => ({ ...item }))
      : [];
  }, [queuedUserMessages]);

  function updateConversationRuntimeReplyErrors(updater) {
    const currentValue =
      conversationRuntimeReplyErrorsRef.current &&
      typeof conversationRuntimeReplyErrorsRef.current === "object" &&
      !Array.isArray(conversationRuntimeReplyErrorsRef.current)
        ? conversationRuntimeReplyErrorsRef.current
        : {};
    const nextValue =
      typeof updater === "function"
        ? updater(currentValue)
        : updater && typeof updater === "object" && !Array.isArray(updater)
          ? updater
          : {};

    conversationRuntimeReplyErrorsRef.current = nextValue;
    setConversationRuntimeReplyErrors(nextValue);
    return nextValue;
  }

  function readConversationRuntimeReplyError(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    return normalizeConversationRuntimeReplyError(
      conversationRuntimeReplyErrorsRef.current?.[normalizedConversationId]
    );
  }

  function writeConversationRuntimeReplyError(conversationId, value) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    const normalizedValue = normalizeConversationRuntimeReplyError(value);
    updateConversationRuntimeReplyErrors((prev) => {
      const next = { ...prev };
      if (normalizedValue) {
        next[normalizedConversationId] = normalizedValue;
      } else {
        delete next[normalizedConversationId];
      }
      return next;
    });

    return normalizedValue;
  }

  function clearConversationRuntimeReplyError(conversationId) {
    return writeConversationRuntimeReplyError(conversationId, null);
  }

  function attachConversationRuntimeReplyError(conversationId, streamState, message) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    const normalizedMessage = String(message ?? "").trim() || "流式会话发生错误";
    if (!normalizedConversationId) {
      return null;
    }

    return writeConversationRuntimeReplyError(normalizedConversationId, {
      messageId: String(streamState?.activeAssistantMessageId ?? "").trim(),
      message: normalizedMessage,
      createdAt: Date.now()
    });
  }

  function readConversationMessages(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return [];
    }

    const cached = conversationMessageCacheRef.current.get(normalizedConversationId);
    return Array.isArray(cached) ? cached.map((item) => normalizeChatMessage(item)) : [];
  }

  function writeConversationMessages(conversationId, nextMessages) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return [];
    }

    const normalizedMessages = Array.isArray(nextMessages)
      ? nextMessages.map((item) => normalizeChatMessage(item))
      : [];
    conversationMessageCacheRef.current.set(normalizedConversationId, normalizedMessages);

    if (activeConversationIdRef.current === normalizedConversationId) {
      setMessages(normalizedMessages);
    }

    return normalizedMessages;
  }

  function clearCompressionStateForConversation(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    updateCompressionState((prev) => {
      if (String(prev?.conversationId ?? "").trim() !== normalizedConversationId) {
        return prev;
      }

      return {
        inProgress: false,
        trigger: "",
        conversationId: ""
      };
    });
  }

  function updateCompressionState(nextValueOrUpdater) {
    const previousValue = compressionStateRef.current ?? EMPTY_COMPRESSION_STATE;
    const resolvedValue =
      typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(previousValue)
        : nextValueOrUpdater;
    const normalizedValue =
      resolvedValue && typeof resolvedValue === "object" && !Array.isArray(resolvedValue)
        ? {
            inProgress: Boolean(resolvedValue.inProgress),
            trigger: String(resolvedValue.trigger ?? "").trim(),
            conversationId: String(resolvedValue.conversationId ?? "").trim()
          }
        : EMPTY_COMPRESSION_STATE;
    compressionStateRef.current = normalizedValue;
    setCompressionState(normalizedValue);
    return normalizedValue;
  }

  function markConversationRunEndedLocally(conversationId, nextStatus = "idle") {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    activeAgentRunConversationIdsRef.current.delete(normalizedConversationId);
    externalStreamStatesRef.current.delete(normalizedConversationId);
    setConversationList((prev) =>
      prev.map((item) =>
        item.id === normalizedConversationId
          ? {
              ...item,
              agentBusy: false,
              agentStatus:
                String(nextStatus ?? "").trim() === "error"
                  ? "error"
                  : String(nextStatus ?? "").trim() === "waiting_approval"
                    ? "waiting_approval"
                    : "idle"
            }
          : item
      )
    );

    if (String(streamingConversationIdRef.current ?? "").trim() === normalizedConversationId) {
      streamingConversationIdRef.current = "";
      setStatus("idle");
    }
  }

  function shouldProcessAgentEvent(event) {
    const runId = String(event?.runId ?? "").trim();
    const eventSeq = Number(event?.eventSeq ?? 0);
    if (!runId || !Number.isFinite(eventSeq) || eventSeq <= 0) {
      return true;
    }

    const seenMap = processedRunEventSeqByRunIdRef.current;
    const lastProcessedSeq = Number(seenMap.get(runId) ?? 0);
    if (eventSeq <= lastProcessedSeq) {
      return false;
    }

    seenMap.set(runId, eventSeq);
    if (seenMap.size > 2048) {
      const overflowCount = seenMap.size - 1536;
      let removed = 0;
      for (const key of seenMap.keys()) {
        seenMap.delete(key);
        removed += 1;
        if (removed >= overflowCount) {
          break;
        }
      }
    }

    return true;
  }

  function isConversationCompressionActive(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return false;
    }

    const currentCompressionState = compressionStateRef.current ?? compressionState;
    return (
      Boolean(currentCompressionState?.inProgress) &&
      String(currentCompressionState?.conversationId ?? "").trim() === normalizedConversationId
    );
  }

  function applyPersistedHistorySnapshot(conversationId, history) {
    const normalizedConversationId = String(conversationId ?? history?.id ?? "").trim();
    if (!normalizedConversationId || !history || !Array.isArray(history.messages)) {
      return null;
    }

    const normalizedMessages = normalizeLoadedMessages(history.messages);
    const updatedSummary = toSummary(history);

    writeConversationMessages(normalizedConversationId, normalizedMessages);
    setConversationList((prev) => replaceSummaryById(prev, updatedSummary));

    if (activeConversationIdRef.current === normalizedConversationId) {
      setTokenUsageRecords(
        Array.isArray(history.tokenUsageRecords)
          ? history.tokenUsageRecords.map(normalizeTokenUsageRecord)
          : []
      );
      lastPersistedSignatureRef.current = buildPersistenceSignature({
        title: String(history.title ?? "新会话"),
        messages: Array.isArray(history.messages) ? history.messages : [],
        skills: Array.isArray(history.skills) ? history.skills : [...selectedSkillsRef.current],
        workplacePath: String(history.workplacePath ?? ""),
        approvalMode: String(history.approvalMode ?? "confirm"),
        developerPrompt: normalizeDeveloperPrompt(history.developerPrompt ?? "")
      });
    }

    return normalizedMessages;
  }

  function updateConversationMessages(conversationId, updater) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return [];
    }

    const currentMessages = readConversationMessages(normalizedConversationId);
    const nextValue = typeof updater === "function" ? updater(currentMessages) : updater;
    return writeConversationMessages(normalizedConversationId, nextValue);
  }

  function findConversationRecord(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    const draftConversationValue = draftConversationRef.current;
    if (draftConversationValue?.id === normalizedConversationId) {
      return {
        workplacePath: String(draftConversationValue.workplacePath ?? "").trim(),
        approvalMode: String(draftConversationValue.approvalMode ?? "confirm"),
        developerPrompt: normalizeDeveloperPrompt(draftConversationValue.developerPrompt ?? ""),
        skills: Array.isArray(draftConversationValue.skills) ? draftConversationValue.skills : [],
        isDraft: true
      };
    }

    const summary = conversationListRef.current.find((item) => item.id === normalizedConversationId);
    if (!summary) {
      return null;
    }

    const effectiveSkills = resolveConversationSkills(
      normalizedConversationId,
      conversationListRef.current,
      draftConversationValue
    );

    return {
      workplacePath: String(summary.workplacePath ?? "").trim(),
      approvalMode: String(summary.approvalMode ?? "confirm"),
      developerPrompt: normalizeDeveloperPrompt(summary.developerPrompt ?? ""),
      skills: Array.isArray(effectiveSkills) ? effectiveSkills : [],
      isDraft: false
    };
  }

  useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }

    if (isCompressing) {
      return;
    }

    if (
      activeConversationIsRunning ||
      streamLoopActiveRef.current ||
      pendingApproval ||
      activeConversationAgentBusy
    ) {
      return;
    }

    if (!activeConversationId) {
      return;
    }

    const isPersistedConversation = !isDraftConversationActive;

    if (!isPersistedConversation && messages.length === 0) {
      return;
    }

    const payloadMessages = toPersistableMessages(messages);
    const title = String(activeConversationTitle ?? "新会话");
    const payload = {
      title,
      messages: payloadMessages,
      skills: [...selectedSkillsRef.current],
      developerPrompt: activeConversationDeveloperPrompt
    };

    const persistenceSignature = JSON.stringify(payload);
    if (lastPersistedSignatureRef.current === persistenceSignature) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastPersistedSignatureRef.current === persistenceSignature) {
        return;
      }

      lastPersistedSignatureRef.current = persistenceSignature;

      upsertHistoryById(activeConversationId, payload)
        .then((response) => {
          const history = response?.history;
          if (!history) {
            return;
          }

          setConversationList((prev) => upsertSummary(prev, toSummary(history)));

          lastPersistedSignatureRef.current = buildPersistenceSignature({
            title: String(history.title ?? title),
            messages: Array.isArray(history.messages) ? history.messages : payloadMessages,
            skills: Array.isArray(history.skills) ? history.skills : [...selectedSkillsRef.current],
            workplacePath: String(history.workplacePath ?? payload.workplacePath ?? ""),
            approvalMode: String(
              history.approvalMode ?? activeConversationApprovalMode ?? "confirm"
            ),
            developerPrompt: normalizeDeveloperPrompt(
              history.developerPrompt ?? activeConversationDeveloperPrompt
            )
          });
          if (!isPersistedConversation) {
            setDraftConversation((prev) => (prev?.id === activeConversationId ? null : prev));
          }
        })
        .catch(() => {
          lastPersistedSignatureRef.current = "";
          // Persistence failure should not block the chat interaction.
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    messages,
    activeConversationIsRunning,
    isCompressing,
    pendingApproval,
    activeConversationAgentBusy,
    activeConversationId,
    historyLoaded,
    activeConversationTitle,
    draftConversation,
    activeConversationDeveloperPrompt,
    activeConversationApprovalMode
  ]);

  async function loadConversation(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    const targetConversationBusy =
      activeAgentRunConversationIdsRef.current.has(normalizedConversationId) ||
      Boolean(
        conversationListRef.current.find((item) => item.id === normalizedConversationId)?.agentBusy
      );
    const targetHasForegroundStream =
      isStreaming &&
      String(streamingConversationIdRef.current ?? "").trim() === normalizedConversationId;
    const preserveStreamingState =
      targetConversationBusy || targetHasForegroundStream || streamLoopActiveRef.current;

    if (!normalizedConversationId) {
      return;
    }

    if (!preserveStreamingState) {
      setStatus("loading");
    }
    setError("");

    try {
      const response = await fetchHistoryById(normalizedConversationId);
      const history = response?.history;

      if (!history) {
        throw new Error("历史不存在");
      }

      const persistedMessages = normalizeLoadedMessages(history.messages);
      const cachedMessages = readConversationMessages(normalizedConversationId);
      const nextMessages =
        cachedMessages.length > 0 && preserveStreamingState ? cachedMessages : persistedMessages;

      setDraftConversation(null);
      setActiveConversationId(normalizedConversationId);
      lastPersistedSignatureRef.current = "";
      const nextSummary = toSummary(history);
      const nextConversationList = upsertSummary(conversationListRef.current, nextSummary);
      selectedSkillsRef.current = [
        ...resolveConversationSkills(normalizedConversationId, nextConversationList, null)
      ];
      const nextTokenUsageRecords = Array.isArray(history.tokenUsageRecords)
        ? history.tokenUsageRecords.map(normalizeTokenUsageRecord)
        : [];
      conversationMessageCacheRef.current.set(normalizedConversationId, nextMessages);
      setMessages(nextMessages);
      setTokenUsageRecords(nextTokenUsageRecords);
      setConversationList(nextConversationList);
    } catch (loadError) {
      setError(loadError?.message || "加载会话失败");
    } finally {
      if (!preserveStreamingState) {
        setStatus("idle");
      }
    }
  }

  async function createConversation() {
    if (activeConversationIsRunning || status === "loading" || !historyLoaded || pendingApproval) {
      return;
    }

    if (isDraftConversationActive && messages.length === 0) {
      setError("");
      return;
    }

    const conversationId = createConversationId();
    setDraftConversation({
      id: conversationId,
      workplacePath: String(activeConversationWorkplace ?? "").trim(),
      approvalMode: String(activeConversationApprovalMode ?? "confirm"),
      developerPrompt: "",
      skills: [...selectedSkillsRef.current]
    });
    setActiveConversationId(conversationId);
    lastPersistedSignatureRef.current = "";
    setMessages([]);
    setPendingApprovalValue(null);
    setError("");
  }

  async function forkConversation(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();

    if (
      !normalizedConversationId ||
      activeConversationIsRunning ||
      status === "loading" ||
      !historyLoaded ||
      pendingApproval
    ) {
      return;
    }

    setStatus("loading");
    setError("");

    try {
      const response = await forkHistoryById(normalizedConversationId);
      const history = response?.history;

      if (!history) {
        throw new Error("Fork 会话失败");
      }

      setDraftConversation(null);
      setPendingApprovalValue(null);
      setActiveConversationId(String(history.id));
      lastPersistedSignatureRef.current = "";
      const nextSummary = toSummary(history);
      const nextConversationList = upsertSummary(conversationListRef.current, nextSummary);
      selectedSkillsRef.current = [
        ...resolveConversationSkills(String(history.id), nextConversationList, null)
      ];
      setMessages(normalizeLoadedMessages(history.messages));
      setTokenUsageRecords(
        Array.isArray(history.tokenUsageRecords)
          ? history.tokenUsageRecords.map(normalizeTokenUsageRecord)
          : []
      );
      setConversationList(nextConversationList);
    } catch (forkError) {
      setError(forkError?.message || "Fork 会话失败");
    } finally {
      setStatus("idle");
    }
  }

  async function deleteConversation(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (
      !normalizedConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      !historyLoaded ||
      pendingApproval
    ) {
      return;
    }

    try {
      const currentConversationList = Array.isArray(conversationListRef.current)
        ? conversationListRef.current
        : [];
      const localSubagentConversationIds = collectSubagentDescendantConversationIds(
        currentConversationList,
        normalizedConversationId
      );
      const response = await deleteHistoryById(normalizedConversationId);

      const deletedConversationIdSet = new Set([
        normalizedConversationId,
        ...localSubagentConversationIds
      ]);
      const serverDeletedConversationIds = Array.isArray(response?.deletedConversationIds)
        ? response.deletedConversationIds
        : [];
      for (const deletedConversationId of serverDeletedConversationIds) {
        const normalizedDeletedConversationId = String(deletedConversationId ?? "").trim();
        if (normalizedDeletedConversationId) {
          deletedConversationIdSet.add(normalizedDeletedConversationId);
        }
      }

      const remained = currentConversationList.filter(
        (item) => !deletedConversationIdSet.has(String(item?.id ?? "").trim())
      );
      setConversationList(remained);
      updateQueuedUserMessageList((prev) =>
        prev.filter(
          (item) => !deletedConversationIdSet.has(String(item?.conversationId ?? "").trim())
        )
      );
      for (const deletedConversationId of deletedConversationIdSet) {
        conversationMessageCacheRef.current.delete(deletedConversationId);
        clearConversationRuntimeReplyError(deletedConversationId);
        activeAgentRunConversationIdsRef.current.delete(deletedConversationId);
        externalStreamStatesRef.current.delete(deletedConversationId);
      }
      updatePendingApprovalsByConversation((prev) => {
        const next = { ...prev };
        for (const deletedConversationId of deletedConversationIdSet) {
          delete next[String(deletedConversationId ?? "").trim()];
        }
        return next;
      });

      if (!deletedConversationIdSet.has(String(activeConversationId ?? "").trim())) {
        return;
      }

      if (remained.length > 0) {
        await loadConversation(remained[0].id);
        return;
      }

      await createConversation();
    } catch (deleteError) {
      setError(deleteError?.message || "删除会话失败");
    }
  }

  async function deleteMessage(messageId) {
    const normalizedMessageId = String(messageId ?? "").trim();

    if (
      !normalizedMessageId ||
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    const targetMessage = messages.find(
      (message) => String(normalizeChatMessage(message).id ?? "").trim() === normalizedMessageId
    );

    if (!targetMessage) {
      setError("消息不存在");
      return;
    }

    if (readConversationRuntimeReplyError(activeConversationId)?.messageId === normalizedMessageId) {
      clearConversationRuntimeReplyError(activeConversationId);
    }

    if (getLocalQueueState(targetMessage) === "queued") {
      setMessages((prev) =>
        prev.filter(
          (message) => String(normalizeChatMessage(message).id ?? "").trim() !== normalizedMessageId
        )
      );
      updateQueuedUserMessageList((prev) =>
        prev.filter((item) => String(item?.messageId ?? "").trim() !== normalizedMessageId)
      );
      setError("");
      return;
    }

    const shouldCascadeTools =
      String(targetMessage.role ?? "").trim() === "assistant" &&
      Array.isArray(targetMessage.toolCalls) &&
      targetMessage.toolCalls.length > 0;
    const confirmed = window.confirm(
      shouldCascadeTools
        ? "删除这条 assistant 消息时，会同时删除本轮关联的工具消息。继续吗？"
        : "确定删除这条消息吗？"
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await deleteHistoryMessageById(activeConversationId, normalizedMessageId);
      const history = response?.history;

      if (!history) {
        throw new Error("删除后未返回最新历史");
      }

      const normalizedMessages = normalizeLoadedMessages(history.messages);
      const nextTokenUsageRecords = Array.isArray(history.tokenUsageRecords)
        ? history.tokenUsageRecords.map(normalizeTokenUsageRecord)
        : [];

      setMessages(normalizedMessages);
      setTokenUsageRecords(nextTokenUsageRecords);
      setConversationList((prev) => upsertSummary(prev, toSummary(history)));
      lastPersistedSignatureRef.current = buildPersistenceSignature({
        title: String(history.title ?? activeConversationTitle ?? "新会话"),
        messages: Array.isArray(history.messages) ? history.messages : [],
        skills: Array.isArray(history.skills) ? history.skills : [...selectedSkillsRef.current],
        workplacePath: String(history.workplacePath ?? activeConversationWorkplace ?? ""),
        approvalMode: String(history.approvalMode ?? activeConversationApprovalMode ?? "confirm"),
        developerPrompt: normalizeDeveloperPrompt(
          history.developerPrompt ?? activeConversationDeveloperPrompt
        )
      });
      setError("");
    } catch (deleteError) {
      setError(deleteError?.message || "删除消息失败");
    }
  }

  async function openWorkplaceBrowser() {
    if (
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    if (activeConversationWorkplaceLocked) {
      setError("当前会话工作区已固定，不能再次修改");
      return;
    }

    setWorkplaceSelecting(true);
    setError("");

    try {
      const response = await selectWorkplaceBySystemDialog(activeConversationWorkplace);

      if (response?.canceled) {
        return;
      }

      const selectedPath = String(response?.selectedPath ?? "").trim();
      if (!selectedPath) {
        setError("未获取到目录绝对路径");
        return;
      }

      await setConversationWorkplace(selectedPath);
    } catch (workplaceError) {
      if (workplaceError?.name === "AbortError") {
        return;
      }

      setError(workplaceError?.message || "打开系统目录选择器失败");
    } finally {
      setWorkplaceSelecting(false);
    }
  }

  async function setConversationWorkplace(workplacePath) {
    if (
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    const normalizedWorkplacePath = String(workplacePath ?? "").trim();

    if (!normalizedWorkplacePath) {
      setError("未获取到目录绝对路径");
      return;
    }

    if (isDraftConversationActive) {
      setDraftConversation((prev) => {
        if (!prev || prev.id !== activeConversationId) {
          return prev;
        }

        return {
          ...prev,
          workplacePath: normalizedWorkplacePath
        };
      });
      setError("");
      return;
    }

    if (activeConversationWorkplaceLocked) {
      setError("当前会话工作区已固定，不能再次修改");
      return;
    }

    try {
      const response = await updateHistoryWorkplaceById(activeConversationId, normalizedWorkplacePath);
      const updatedSummary = toSummary(response?.history ?? {});

      setConversationList((prev) => replaceSummaryById(prev, updatedSummary));
      setError("");
    } catch (workplaceError) {
      setError(workplaceError?.message || "设置工作区失败");
    }
  }

  async function setConversationApprovalMode(approvalMode) {
    if (
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    const normalizedApprovalMode = String(approvalMode ?? "").trim() === "auto"
      ? "auto"
      : "confirm";

    if (isDraftConversationActive) {
      setDraftConversation((prev) => {
        if (!prev || prev.id !== activeConversationId) {
          return prev;
        }

        return {
          ...prev,
          approvalMode: normalizedApprovalMode
        };
      });
      setError("");
      return;
    }

    try {
      const response = await updateHistoryApprovalModeById(
        activeConversationId,
        normalizedApprovalMode
      );
      const updatedSummary = toSummary(response?.history ?? {});

      setConversationList((prev) => replaceSummaryById(prev, updatedSummary));
      setError("");
    } catch (approvalModeError) {
      setError(approvalModeError?.message || "设置审批模式失败");
    }
  }

  async function setConversationSkills(nextSkills) {
    if (
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    const normalizedSkills = Array.isArray(nextSkills)
      ? Array.from(
          new Set(
            nextSkills
              .map((item) => String(item ?? "").trim())
              .filter(Boolean)
          )
        )
      : [];
    const skillsOwnerConversationId = String(
      activeConversationSkillOwnerId || activeConversationId
    ).trim();

    if (isDraftConversationActive) {
      setDraftConversation((prev) => {
        if (!prev || prev.id !== activeConversationId) {
          return prev;
        }

        selectedSkillsRef.current = normalizedSkills;
        return {
          ...prev,
          skills: normalizedSkills
        };
      });
      setError("");
      return;
    }

    try {
      selectedSkillsRef.current = normalizedSkills;
      setConversationList((prev) =>
        prev.map((item) =>
          item.id === skillsOwnerConversationId
            ? {
                ...item,
                skills: normalizedSkills
              }
            : item
        )
      );

      const response = await updateHistorySkillsById(skillsOwnerConversationId, normalizedSkills);
      const updatedSummary = toSummary(response?.history ?? {});

      setConversationList((prev) => replaceSummaryById(prev, updatedSummary));
      setError("");
    } catch (skillsError) {
      setError(skillsError?.message || "设置技能失败");
    }
  }

  async function setConversationDeveloperPrompt(nextDeveloperPrompt) {
    if (
      !historyLoaded ||
      !activeConversationId ||
      activeConversationIsRunning ||
      isCompressing ||
      pendingApproval
    ) {
      return;
    }

    if (activeConversationSource === "subagent") {
      setError("子智能体 prompt 由类型定义固定，不能在前端修改");
      return;
    }

    const normalizedDeveloperPrompt = normalizeDeveloperPrompt(nextDeveloperPrompt);

    if (isDraftConversationActive) {
      setDraftConversation((prev) => {
        if (!prev || prev.id !== activeConversationId) {
          return prev;
        }

        return {
          ...prev,
          developerPrompt: normalizedDeveloperPrompt
        };
      });
      setError("");
      return;
    }

    setConversationList((prev) =>
      prev.map((item) =>
        item.id === activeConversationId
          ? {
              ...item,
              developerPrompt: normalizedDeveloperPrompt
            }
          : item
      )
    );
    setError("");
  }

  async function compressConversation(trigger = "manual") {
    const normalizedTrigger = String(trigger ?? "").trim() === "auto" ? "auto" : "manual";
    const targetConversationId = String(activeConversationIdRef.current ?? "").trim();

    if (!historyLoaded || !targetConversationId) {
      return null;
    }

    if (activeConversationIsRunning) {
      setError("当前会话正在回复，暂时不能手动压缩");
      return null;
    }

    if (pendingApproval) {
      setError("当前存在待审批工具调用，暂时不能手动压缩");
      return null;
    }

    if (isDraftConversationActive) {
      setError("草稿会话尚未保存，暂时不能手动压缩");
      return null;
    }

    const currentMessages = messagesRef.current.map(normalizeChatMessage);
    if (currentMessages.length === 0) {
      setError("当前会话没有可压缩内容");
      return null;
    }

    if (normalizedTrigger === "manual" && !canManualCompress) {
      setError("当前上下文占用不足 20%，暂不允许手动压缩");
      return null;
    }

    const nextCompressionState = {
      inProgress: true,
      trigger: normalizedTrigger,
      conversationId: targetConversationId
    };
    updateCompressionState(nextCompressionState);
    setError("");

    try {
      const response = await compressHistoryById(targetConversationId, {
        trigger: normalizedTrigger,
        messages: toPersistableMessages(currentMessages)
      });

      const history = response?.history;
      if (!history) {
        throw new Error("压缩结果为空");
      }

      applyPersistedHistorySnapshot(targetConversationId, history);
      if (String(activeConversationIdRef.current ?? "").trim() === targetConversationId) {
        const normalizedMessages = normalizeLoadedMessages(history.messages);
        lastPersistedSignatureRef.current = JSON.stringify({
          title: String(history.title ?? "新会话"),
          messages: toPersistableMessages(normalizedMessages),
          skills: Array.isArray(history.skills) ? history.skills : [...selectedSkillsRef.current],
          workplacePath: String(history.workplacePath ?? ""),
          approvalMode: String(history.approvalMode ?? "confirm"),
          developerPrompt: normalizeDeveloperPrompt(history.developerPrompt ?? "")
        });
      }
      updateCompressionState({
        inProgress: false,
        trigger: "",
        conversationId: ""
      });
      maybeStartQueuedRunForConversation(targetConversationId, {
        ignoreCompressionGate: true
      });
      if (!response?.compression?.compressed) {
        const compressionMessage = getCompressionResultMessage(
          response?.compression,
          normalizedTrigger
        );
        if (
          compressionMessage &&
          String(activeConversationIdRef.current ?? "").trim() === targetConversationId
        ) {
          setError(compressionMessage);
        }
      }
      return response;
    } catch (compressionError) {
      updateCompressionState((prev) => ({
        ...prev,
        inProgress: false,
        trigger: "",
        conversationId:
          String(prev?.conversationId ?? "").trim() === targetConversationId
            ? ""
            : prev?.conversationId ?? ""
      }));
      if (String(activeConversationIdRef.current ?? "").trim() === targetConversationId) {
        setError(compressionError?.message || "压缩会话失败");
      }
      maybeStartQueuedRunForConversation(targetConversationId, {
        ignoreCompressionGate: true
      });
      return null;
    }
  }

  function applyAgentEvent(event, streamState, targetConversationId, options = {}) {
    if (!shouldProcessAgentEvent(event)) {
      return true;
    }

    const normalizedTargetConversationId = String(targetConversationId ?? "").trim();
    const source = String(options?.source ?? "direct").trim().toLowerCase();

    const isActiveTarget = normalizedTargetConversationId === activeConversationIdRef.current;
    const updateTargetMessages = (updater) =>
      updateConversationMessages(normalizedTargetConversationId, updater);
    const ensureStreamBuffers = () => {
      if (typeof streamState.pendingContentBuffer !== "string") {
        streamState.pendingContentBuffer = "";
      }
      if (typeof streamState.pendingReasoningBuffer !== "string") {
        streamState.pendingReasoningBuffer = "";
      }
      if (
        !(
          typeof streamState.flushFrameId === "number" ||
          streamState.flushFrameId === null ||
          typeof streamState.flushFrameId === "undefined"
        )
      ) {
        streamState.flushFrameId = null;
      }
    };
    const cancelBufferedAssistantFlush = () => {
      ensureStreamBuffers();
      if (typeof streamState.flushFrameId === "number") {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(streamState.flushFrameId);
        } else {
          clearTimeout(streamState.flushFrameId);
        }
      }
      streamState.flushFrameId = null;
    };
    const flushBufferedAssistantTokens = () => {
      ensureStreamBuffers();
      const targetAssistantId = String(streamState.activeAssistantMessageId ?? "").trim();
      const contentDelta = String(streamState.pendingContentBuffer ?? "");
      const reasoningDelta = String(streamState.pendingReasoningBuffer ?? "");

      streamState.pendingContentBuffer = "";
      streamState.pendingReasoningBuffer = "";

      if (!targetAssistantId || (!contentDelta && !reasoningDelta)) {
        return;
      }

      const now = Date.now();
      updateTargetMessages((prev) =>
        prev.map((item) => {
          if (String(item?.id ?? "").trim() !== targetAssistantId) {
            return item;
          }

          const normalized = normalizeChatMessage(item);
          const currentReasoningStartedAt = Number(normalized.reasoningStartedAt ?? 0);
          const currentReasoningFinishedAt = Number(normalized.reasoningFinishedAt ?? 0);
          const nextReasoningStartedAt =
            reasoningDelta.length > 0
              ? currentReasoningStartedAt > 0
                ? currentReasoningStartedAt
                : now
              : currentReasoningStartedAt;
          const nextReasoningFinishedAt =
            reasoningDelta.length > 0
              ? 0
              : contentDelta.length > 0 &&
                  currentReasoningStartedAt > 0 &&
                  currentReasoningFinishedAt <= 0
                ? now
                : currentReasoningFinishedAt;

          return {
            ...normalized,
            content: String(normalized.content ?? "") + contentDelta,
            reasoningContent: String(normalized.reasoningContent ?? "") + reasoningDelta,
            reasoningStartedAt: nextReasoningStartedAt,
            reasoningFinishedAt: nextReasoningFinishedAt
          };
        })
      );
    };
    const scheduleBufferedAssistantFlush = () => {
      ensureStreamBuffers();
      if (typeof streamState.flushFrameId === "number") {
        return;
      }

      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        streamState.flushFrameId = window.requestAnimationFrame(() => {
          streamState.flushFrameId = null;
          flushBufferedAssistantTokens();
        });
        return;
      }

      streamState.flushFrameId = setTimeout(() => {
        streamState.flushFrameId = null;
        flushBufferedAssistantTokens();
      }, 16);
    };
    const ensureActiveAssistantMessage = () => {
      const currentAssistantId = String(streamState.activeAssistantMessageId ?? "").trim();
      if (currentAssistantId) {
        return currentAssistantId;
      }

      const cachedMessages = readConversationMessages(normalizedTargetConversationId);
      const lastMessage =
        Array.isArray(cachedMessages) && cachedMessages.length > 0
          ? normalizeChatMessage(cachedMessages[cachedMessages.length - 1])
          : null;
      if (
        lastMessage &&
        String(lastMessage.role ?? "").trim() === "assistant" &&
        Array.isArray(lastMessage.toolCalls) &&
        lastMessage.toolCalls.length === 0 &&
        String(lastMessage.id ?? "").trim()
      ) {
        const reusableAssistantId = String(lastMessage.id).trim();
        streamState.activeAssistantMessageId = reusableAssistantId;
        return reusableAssistantId;
      }

      const nextAssistantId = createId("assistant");
      streamState.activeAssistantMessageId = nextAssistantId;
      updateTargetMessages((prev) => [
        ...prev,
        normalizeChatMessage({
          id: nextAssistantId,
          role: "assistant",
          timestamp: Date.now(),
          content: "",
          reasoningContent: "",
          reasoningStartedAt: 0,
          reasoningFinishedAt: 0,
          tokenUsage: null
        })
      ]);
      return nextAssistantId;
    };

    if (event?.type !== "retry") {
      setRetryNotice((prev) => (prev ? "" : prev));
    }

    if (event?.type === "uploaded_files_parsed") {
      const incomingFiles = Array.isArray(event?.files) ? event.files : [];
      const targetMessageId = String(event?.messageId ?? "").trim();
      const truncatedFileCount = Number(event?.truncatedFileCount ?? 0);
      if (incomingFiles.length === 0) {
        return true;
      }

      updateTargetMessages((prev) => {
        const nextList = [...prev];
        let targetIndex = -1;

        if (targetMessageId) {
          targetIndex = nextList.findIndex(
            (item) => String(item?.id ?? "").trim() === targetMessageId
          );
        }

        if (targetIndex < 0) {
          for (let index = nextList.length - 1; index >= 0; index -= 1) {
            if (String(nextList[index]?.role ?? "").trim() === "user") {
              targetIndex = index;
              break;
            }
          }
        }

        if (targetIndex < 0) {
          return nextList;
        }

        const targetMessage = normalizeChatMessage(nextList[targetIndex]);
        const nextMeta = targetMessage?.meta && typeof targetMessage.meta === "object"
          ? { ...targetMessage.meta }
          : {};

        nextMeta.parsedFiles = incomingFiles;

        if (truncatedFileCount > 0) {
          nextMeta.parsedFilesTruncatedCount = truncatedFileCount;
        } else if (Object.prototype.hasOwnProperty.call(nextMeta, "parsedFilesTruncatedCount")) {
          delete nextMeta.parsedFilesTruncatedCount;
        }

        nextList[targetIndex] = {
          ...targetMessage,
          meta: nextMeta
        };

        return nextList;
      });

      return true;
    }

    if (event?.type === "compression_started") {
      const nextCompressionState = {
        inProgress: true,
        trigger: String(event?.trigger ?? "auto").trim() || "auto",
        conversationId: normalizedTargetConversationId
      };
      updateCompressionState(nextCompressionState);
      return true;
    }

    if (event?.type === "conversation_messages_appended") {
      const incomingMessages = Array.isArray(event?.messages)
        ? event.messages.map((item) => normalizeChatMessage(item))
        : [];

      if (incomingMessages.length === 0) {
        return true;
      }

      updateTargetMessages((prev) => {
        const existingIds = new Set(
          prev.map((item) => String(normalizeChatMessage(item).id ?? "").trim()).filter(Boolean)
        );
        const nextMessages = prev.slice();

        for (const message of incomingMessages) {
          const messageId = String(message?.id ?? "").trim();
          if (messageId && existingIds.has(messageId)) {
            continue;
          }

          if (messageId) {
            existingIds.add(messageId);
          }

          nextMessages.push(message);
        }

        return nextMessages;
      });
      return true;
    }

    if (event?.type === "session_start") {
      activeAgentRunConversationIdsRef.current.add(normalizedTargetConversationId);
      setConversationList((prev) =>
        prev.map((item) =>
          item.id === normalizedTargetConversationId
            ? {
                ...item,
                agentBusy: true,
                agentStatus: "running"
              }
            : item
        )
      );
      streamState.activeAssistantMessageId = null;
      clearConversationRuntimeReplyError(normalizedTargetConversationId);
      return true;
    }

    if (event?.type === "session_resume") {
      activeAgentRunConversationIdsRef.current.add(normalizedTargetConversationId);
      setConversationList((prev) =>
        prev.map((item) =>
          item.id === normalizedTargetConversationId
            ? {
                ...item,
                agentBusy: true,
                agentStatus: "running"
              }
            : item
        )
      );
      streamState.activeAssistantMessageId = null;
      clearConversationRuntimeReplyError(normalizedTargetConversationId);
      return true;
    }

    if (event?.type === "compression_completed") {
      const history = event?.history;
      if (history && Array.isArray(history.messages)) {
        applyPersistedHistorySnapshot(normalizedTargetConversationId, history);
      }

      clearCompressionStateForConversation(normalizedTargetConversationId);
      maybeStartQueuedRunForConversation(normalizedTargetConversationId, {
        ignoreCompressionGate: true
      });
      return true;
    }

    if (event?.type === "assistant_token") {
      ensureActiveAssistantMessage();
      ensureStreamBuffers();
      streamState.pendingContentBuffer += String(event.token ?? "");
      scheduleBufferedAssistantFlush();
      return true;
    }

    if (event?.type === "assistant_reasoning_token") {
      ensureActiveAssistantMessage();
      ensureStreamBuffers();
      streamState.pendingReasoningBuffer += String(event.token ?? "");
      scheduleBufferedAssistantFlush();
      return true;
    }

    if (event?.type === "assistant_message_end") {
      cancelBufferedAssistantFlush();
      flushBufferedAssistantTokens();
      const toolCalls = normalizeToolCalls(event?.toolCalls);
      const messageContent = typeof event?.content === "string" ? event.content : "";
      const reasoningContent =
        typeof event?.reasoningContent === "string" ? event.reasoningContent : "";

      if (toolCalls.length === 0 && streamState.activeAssistantMessageId) {
        updateTargetMessages((prev) =>
          prev.map((item) =>
            item.id === streamState.activeAssistantMessageId
              ? {
                  ...normalizeChatMessage(item),
                  content: messageContent || item.content,
                  reasoningContent: reasoningContent || item.reasoningContent || "",
                  reasoningFinishedAt:
                    Number(item.reasoningStartedAt ?? 0) > 0
                      ? Number(item.reasoningFinishedAt ?? 0) || Date.now()
                      : 0
                }
              : item
          )
        );
        return true;
      }

      if (streamState.activeAssistantMessageId) {
        updateTargetMessages((prev) =>
          prev.map((item) =>
            item.id === streamState.activeAssistantMessageId
              ? {
                  ...normalizeChatMessage(item),
                  content: messageContent || item.content,
                  reasoningContent: reasoningContent || item.reasoningContent || "",
                  reasoningFinishedAt:
                    Number(item.reasoningStartedAt ?? 0) > 0
                      ? Number(item.reasoningFinishedAt ?? 0) || Date.now()
                      : 0,
                  toolCalls
                }
              : item
          )
        );
        return true;
      }

      const assistantMessageId = createId("assistant");
      streamState.activeAssistantMessageId = assistantMessageId;
      updateTargetMessages((prev) => [
        ...prev,
        normalizeChatMessage({
          id: assistantMessageId,
          role: "assistant",
          timestamp: Date.now(),
          content: messageContent,
          reasoningContent,
          reasoningStartedAt: reasoningContent ? Date.now() : 0,
          reasoningFinishedAt: reasoningContent ? Date.now() : 0,
          toolCalls,
          tokenUsage: null
        })
      ]);
      return true;
    }

    if (event?.type === "tool_call") {
      cancelBufferedAssistantFlush();
      flushBufferedAssistantTokens();
      const toolPayload = createToolMessagePayloadFromCall(event);
      const toolMessage = normalizeChatMessage({
        id: createId("tool-call"),
        role: "tool",
        timestamp: Date.now(),
        content: serializeToolMessagePayload(toolPayload),
        toolCallId: String(toolPayload.toolCallId ?? "").trim(),
        toolName: String(toolPayload.toolName ?? "").trim(),
        meta: {
          kind: "tool_event",
          ...toolPayload
        }
      });

      updateTargetMessages((prev) => [...prev, toolMessage]);
      streamState.activeAssistantMessageId = null;
      return true;
    }

    if (event?.type === "tool_pending_approval") {
      setPendingApprovalValue({
        approvalId: String(event.approvalId ?? ""),
        conversationId: String(event.conversationId ?? targetConversationId),
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        toolApprovalGroup: String(event.toolApprovalGroup ?? "unknown"),
        toolApprovalSection: String(event.toolApprovalSection ?? "unknown"),
        arguments: event.arguments ?? {},
        toolCount: Number(event.toolCount ?? 1),
        approvalMode: String(event.approvalMode ?? "confirm")
      });

      updateTargetMessages((prev) => {
        const nextList = [...prev];
        const targetIndex = findToolMessageIndex(nextList, event);

        if (targetIndex >= 0) {
          const targetMessage = nextList[targetIndex];
          const currentPayload = parseToolMessagePayload(targetMessage.content);

          if (currentPayload) {
            const mergedPayload = applyToolPendingApprovalToPayload(currentPayload, event);
            nextList[targetIndex] = {
              ...normalizeChatMessage(targetMessage),
              content: serializeToolMessagePayload(mergedPayload),
              meta: {
                kind: "tool_event",
                ...mergedPayload
              }
            };
          }
        }

        return nextList;
      });

      return true;
    }

    if (event?.type === "tool_result") {
      updateTargetMessages((prev) => {
        const nextList = [...prev];
        const targetIndex = findToolMessageIndex(nextList, event);

        if (targetIndex >= 0) {
          const targetMessage = nextList[targetIndex];
          const currentPayload = parseToolMessagePayload(targetMessage.content);

          if (currentPayload) {
            const mergedPayload = applyToolResultToPayload(currentPayload, event);
            nextList[targetIndex] = {
              ...normalizeChatMessage(targetMessage),
              content: serializeToolMessagePayload(mergedPayload),
              meta: {
                kind: "tool_event",
                ...mergedPayload
              }
            };

            return nextList;
          }
        }

        const fallbackPayload = createToolMessagePayloadFromResult(event);
        nextList.push({
          ...normalizeChatMessage({
            id: createId("tool-result"),
            role: "tool",
            timestamp: Date.now(),
            content: serializeToolMessagePayload(fallbackPayload),
            toolCallId: String(fallbackPayload.toolCallId ?? "").trim(),
            toolName: String(fallbackPayload.toolName ?? "").trim(),
            meta: {
              kind: "tool_event",
              ...fallbackPayload
            }
          })
        });

        return nextList;
      });
      const pendingApprovalForConversation = readPendingApprovalValue(normalizedTargetConversationId);
      const pendingToolCallId = String(pendingApprovalForConversation?.toolCallId ?? "").trim();
      const resultToolCallId = String(event?.toolCallId ?? "").trim();
      if (
        pendingApprovalForConversation &&
        pendingToolCallId &&
        resultToolCallId &&
        pendingToolCallId === resultToolCallId
      ) {
        setPendingApprovalValue(null, { conversationId: normalizedTargetConversationId });
      }

      return true;
    }

    if (event?.type === "tool_image_input") {
      const imageAttachments = normalizeImageAttachments(event?.imageAttachments);
      if (imageAttachments.length === 0) {
        return true;
      }

      updateTargetMessages((prev) => [
        ...prev,
        normalizeChatMessage({
          id: createId("tool-image-input"),
          role: "user",
          timestamp: Date.now(),
          content:
            String(event?.content ?? "").trim()
            || "Tool returned image attachments for follow-up reasoning.",
          meta: {
            kind: "tool_image_input",
            toolCallId: String(event?.toolCallId ?? "").trim(),
            toolName: String(event?.toolName ?? "").trim(),
            attachments: imageAttachments
          }
        })
      ]);

      return true;
    }

    if (event?.type === "runtime_hook_injected") {
      const content = String(event?.content ?? "").trim();
      if (!content) {
        return true;
      }

      updateTargetMessages((prev) => [
        ...prev,
        normalizeChatMessage({
          id: createId("runtime-hook"),
          role: "user",
          timestamp: Date.now(),
          content,
          meta: {
            kind: "runtime_hook_injected",
            hookType: String(event?.hookType ?? "").trim() || "runtime_hooks",
            level: String(event?.level ?? "").trim() || "info",
            source: String(event?.source ?? "").trim() || "hook",
            blockId: String(event?.blockId ?? "").trim(),
            metadata:
              event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
                ? event.metadata
                : {}
          }
        })
      ]);

      return true;
    }

    if (event?.type === "usage") {
      const usage = normalizeTokenUsage(event.usage);
      if (usage.totalTokens <= 0) {
        return true;
      }

      const usageRecord = normalizeTokenUsageRecord({
        id: createId("usage"),
        conversationId: targetConversationId,
        model: String(event.model ?? ""),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        promptTokensDetails: usage.promptTokensDetails ?? null,
        completionTokensDetails: usage.completionTokensDetails ?? null,
        createdAt: Date.now()
      });

      if (isActiveTarget) {
        setTokenUsageRecords((prev) => [...prev, usageRecord]);
      }
      updateTargetMessages((prev) => {
        const targetAssistantId =
          typeof streamState.activeAssistantMessageId === "string" &&
          streamState.activeAssistantMessageId
            ? streamState.activeAssistantMessageId
            : "";

        if (!targetAssistantId) {
          return prev;
        }

        return prev.map((item) =>
          item.id === targetAssistantId
            ? {
                ...item,
                tokenUsage: usageRecord
              }
            : item
        );
      });
      setConversationList((prev) =>
        prev.map((item) =>
          item.id === normalizedTargetConversationId
            ? {
                ...item,
                tokenUsage: {
                  ...normalizeTokenUsage(item?.tokenUsage ?? {}),
                  promptTokens: usageRecord.promptTokens,
                  completionTokens: usageRecord.completionTokens,
                  totalTokens: usageRecord.totalTokens,
                  usageCount: Number(item?.tokenUsage?.usageCount ?? 0) + 1,
                  lastUsedAt: usageRecord.createdAt
                }
              }
            : item
          )
        );

      return true;
    }

    if (event?.type === "retry") {
      setRetryNotice(`请求重试：第 ${event.attempt} 次，等待 ${event.delayMs}ms`);
      return true;
    }

    if (event?.type === "final") {
      if (!streamState.activeAssistantMessageId && typeof event?.assistantText === "string") {
        const maybeContent = event.assistantText.trim();

        if (maybeContent.length > 0) {
          streamState.activeAssistantMessageId = createId("assistant");
          updateTargetMessages((prev) => [
            ...prev,
            {
              id: streamState.activeAssistantMessageId,
              role: "assistant",
              timestamp: Date.now(),
              content: maybeContent,
              reasoningContent: "",
              reasoningStartedAt: 0,
              reasoningFinishedAt: 0,
              tokenUsage: null
            }
          ]);
        }
      }
      return true;
    }

    if (event?.type === "session_pause") {
      cancelBufferedAssistantFlush();
      flushBufferedAssistantTokens();
      if (event?.history && Array.isArray(event.history.messages)) {
        applyPersistedHistorySnapshot(normalizedTargetConversationId, event.history);
      }
      markConversationRunEndedLocally(normalizedTargetConversationId, "waiting_approval");
      streamState.activeAssistantMessageId = null;
      return true;
    }

    if (event?.type === "session_end") {
      cancelBufferedAssistantFlush();
      flushBufferedAssistantTokens();
      if (event?.history && Array.isArray(event.history.messages)) {
        applyPersistedHistorySnapshot(normalizedTargetConversationId, event.history);
      }
      const runStatus = String(event?.status ?? "").trim() || "idle";
      markConversationRunEndedLocally(
        normalizedTargetConversationId,
        runStatus
      );
      if (runStatus !== "waiting_approval") {
        setPendingApprovalValue(null, { conversationId: normalizedTargetConversationId });
      }
      streamState.activeAssistantMessageId = null;
      if (!streamLoopActiveRef.current && status !== "streaming") {
        const nextQueued = queuedUserMessagesRef.current.find(
          (item) => String(item?.conversationId ?? "").trim() === normalizedTargetConversationId
        );
        const nextPlan = nextQueued ? buildQueuedRunPlan(nextQueued.messageId) : null;
        if (nextPlan) {
          void runConversationStreamLoop(nextPlan);
        }
      }
      return true;
    }

    if (event?.type === "error") {
      cancelBufferedAssistantFlush();
      flushBufferedAssistantTokens();
      markConversationRunEndedLocally(normalizedTargetConversationId, "error");
      setPendingApprovalValue(null, { conversationId: normalizedTargetConversationId });
      attachConversationRuntimeReplyError(
        normalizedTargetConversationId,
        streamState,
        event.message || "流式会话发生错误"
      );
      return true;
    }

    return false;
  }

  function updateQueuedUserMessageList(updater) {
    const currentList = Array.isArray(queuedUserMessagesRef.current)
      ? queuedUserMessagesRef.current.map((item) => ({ ...item }))
      : [];
    const nextValue = typeof updater === "function" ? updater(currentList) : updater;
    const normalizedList = Array.isArray(nextValue)
      ? nextValue
          .map((item) => {
            const messageId = String(item?.messageId ?? "").trim();
            const conversationId = String(item?.conversationId ?? "").trim();
            if (!messageId || !conversationId) {
              return null;
            }

            return {
              messageId,
              conversationId,
              queuedAt: Number(item?.queuedAt ?? Date.now()),
              message: item?.message ? normalizeChatMessage(item.message) : null
            };
          })
          .filter(Boolean)
      : [];

    queuedUserMessagesRef.current = normalizedList;
    setQueuedUserMessages(normalizedList);
    return normalizedList;
  }

  function updatePendingApprovalsByConversation(updater) {
    const currentValue =
      pendingApprovalsByConversationRef.current &&
      typeof pendingApprovalsByConversationRef.current === "object" &&
      !Array.isArray(pendingApprovalsByConversationRef.current)
        ? pendingApprovalsByConversationRef.current
        : {};
    const nextValue =
      typeof updater === "function"
        ? updater(currentValue)
        : updater && typeof updater === "object" && !Array.isArray(updater)
          ? updater
          : {};
    const normalized = {};

    for (const [conversationId, approval] of Object.entries(nextValue)) {
      const normalizedConversationId = String(conversationId ?? "").trim();
      if (!normalizedConversationId || !approval || typeof approval !== "object") {
        continue;
      }

      normalized[normalizedConversationId] = {
        ...approval,
        conversationId: normalizedConversationId
      };
    }

    pendingApprovalsByConversationRef.current = normalized;
    setPendingApprovalsByConversation(normalized);
    return normalized;
  }

  function readPendingApprovalValue(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    const approval = pendingApprovalsByConversationRef.current?.[normalizedConversationId];
    return approval && typeof approval === "object" ? approval : null;
  }

  function hasPendingApprovalValue(conversationId) {
    return Boolean(readPendingApprovalValue(conversationId));
  }

  function setPendingApprovalValue(nextValue, options = {}) {
    const clearAll = options?.clearAll === true;
    if (clearAll && (!nextValue || typeof nextValue !== "object")) {
      updatePendingApprovalsByConversation({});
      return;
    }

    const resolvedConversationId = String(
      options?.conversationId
      ?? nextValue?.conversationId
      ?? activeConversationIdRef.current
      ?? ""
    ).trim();

    if (!resolvedConversationId) {
      if (!nextValue || typeof nextValue !== "object") {
        updatePendingApprovalsByConversation({});
      }
      return;
    }

    updatePendingApprovalsByConversation((prev) => {
      const next = { ...prev };
      if (!nextValue || typeof nextValue !== "object") {
        delete next[resolvedConversationId];
        return next;
      }

      next[resolvedConversationId] = {
        ...nextValue,
        conversationId: resolvedConversationId
      };
      return next;
    });
  }

  function removeQueuedUserMessage(messageId) {
    const normalizedMessageId = String(messageId ?? "").trim();
    if (!normalizedMessageId) {
      return;
    }

    updateQueuedUserMessageList((prev) =>
      prev.filter((item) => String(item?.messageId ?? "").trim() !== normalizedMessageId)
    );
    setError("");
  }

  function reorderQueuedUserMessages(sourceMessageId, targetMessageId, position = "before") {
    const normalizedSourceMessageId = String(sourceMessageId ?? "").trim();
    const normalizedTargetMessageId = String(targetMessageId ?? "").trim();
    const normalizedPosition = String(position ?? "").trim() === "after" ? "after" : "before";

    if (!normalizedSourceMessageId || !normalizedTargetMessageId) {
      return;
    }

    if (normalizedSourceMessageId === normalizedTargetMessageId) {
      return;
    }

    updateQueuedUserMessageList((prev) => {
      const sourceIndex = prev.findIndex(
        (item) => String(item?.messageId ?? "").trim() === normalizedSourceMessageId
      );
      const targetIndex = prev.findIndex(
        (item) => String(item?.messageId ?? "").trim() === normalizedTargetMessageId
      );

      if (sourceIndex < 0 || targetIndex < 0) {
        return prev;
      }

      const next = prev.slice();
      const [movedItem] = next.splice(sourceIndex, 1);
      if (!movedItem) {
        return prev;
      }

      let insertionIndex = targetIndex;
      if (sourceIndex < targetIndex) {
        insertionIndex -= 1;
      }
      if (normalizedPosition === "after") {
        insertionIndex += 1;
      }

      const boundedIndex = Math.max(0, Math.min(insertionIndex, next.length));
      next.splice(boundedIndex, 0, movedItem);
      return next;
    });
    setError("");
  }

  function buildUserMessage(payload, options = {}) {
    const text = String(payload.text ?? "").trim();
    const imageAttachments = normalizeImageAttachments(
      Array.isArray(payload.imageAttachments)
        ? payload.imageAttachments
        : payload.imageAttachment
          ? [payload.imageAttachment]
          : []
    );
    const parsedFileAttachments = normalizeParsedFileAttachments(payload.parsedFileAttachments);
    const fallbackFileMessage =
      parsedFileAttachments.length > 0
        ? `已上传 ${parsedFileAttachments.length} 个文件，请结合文件内容回答。`
        : "";

    const userMessageMeta = {};
    if (imageAttachments.length > 0) {
      userMessageMeta.attachments = imageAttachments;
    }

    if (parsedFileAttachments.length > 0) {
      userMessageMeta.parsedFiles = parsedFileAttachments;
    }

    const localQueueState = String(options.localQueueState ?? "").trim();
    if (localQueueState) {
      userMessageMeta[LOCAL_QUEUE_STATE_KEY] = localQueueState;
    }

    return normalizeChatMessage({
      id: createId("user"),
      role: "user",
      timestamp: Date.now(),
      content: text || fallbackFileMessage,
      meta: userMessageMeta
    });
  }

  function buildQueuedActivationMessages(conversationId, messageId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    const normalizedMessageId = String(messageId ?? "").trim();
    if (!normalizedConversationId || !normalizedMessageId) {
      return [];
    }

    return readConversationMessages(normalizedConversationId).map((item) => {
      const normalized = normalizeChatMessage(item);
      if (normalized.id !== normalizedMessageId) {
        return normalized;
      }

      return {
        ...normalized,
        meta: clearLocalQueueStateFromMeta(normalized.meta)
      };
    });
  }

  function buildQueuedRunPlan(messageId) {
    const normalizedMessageId = String(messageId ?? "").trim();
    if (!normalizedMessageId) {
      return null;
    }

    const queuedRecord = queuedUserMessagesRef.current.find(
      (item) => String(item?.messageId ?? "").trim() === normalizedMessageId
    );
    const normalizedConversationId = String(queuedRecord?.conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    let activatedMessages = buildQueuedActivationMessages(normalizedConversationId, normalizedMessageId);
    if (!activatedMessages.some((item) => item.id === normalizedMessageId)) {
      if (queuedRecord?.message) {
        activatedMessages = [
          ...readConversationMessages(normalizedConversationId),
          {
            ...normalizeChatMessage(queuedRecord.message),
            meta: clearLocalQueueStateFromMeta(queuedRecord.message.meta)
          }
        ];
      }
    }

    if (!activatedMessages.some((item) => item.id === normalizedMessageId)) {
      updateQueuedUserMessageList((prev) =>
        prev.filter((item) => String(item?.messageId ?? "").trim() !== normalizedMessageId)
      );
      return null;
    }

    writeConversationMessages(normalizedConversationId, activatedMessages);
    updateQueuedUserMessageList((prev) =>
      prev.filter((item) => String(item?.messageId ?? "").trim() !== normalizedMessageId)
    );

    const conversationRecord = findConversationRecord(normalizedConversationId);

    return {
      conversationId: normalizedConversationId,
      messages: normalizeForApi(activatedMessages),
      approvalMode: String(conversationRecord?.approvalMode ?? "confirm"),
      developerPrompt: String(conversationRecord?.developerPrompt ?? ""),
      enableDeepThinking: deepThinkingEnabled
    };
  }

  function maybeStartQueuedRunForConversation(conversationId, options = {}) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    const ignoreCompressionGate = options.ignoreCompressionGate === true;
    if (
      streamLoopActiveRef.current ||
      isStreaming ||
      hasPendingApprovalValue(normalizedConversationId) ||
      activeAgentRunConversationIdsRef.current.has(normalizedConversationId) ||
      (!ignoreCompressionGate && isConversationCompressionActive(normalizedConversationId))
    ) {
      return;
    }

    const nextQueued = queuedUserMessagesRef.current.find(
      (item) => String(item?.conversationId ?? "").trim() === normalizedConversationId
    );
    const nextPlan = nextQueued ? buildQueuedRunPlan(nextQueued.messageId) : null;
    if (nextPlan) {
      void runConversationStreamLoop(nextPlan);
    }
  }

  function refreshHistoryTitleWithRetry(targetConversationId, remainingAttempts = 4) {
    const normalizedConversationId = String(targetConversationId ?? "").trim();
    if (!normalizedConversationId || remainingAttempts < 0) {
      return;
    }

    fetchHistories()
      .then((response) => {
        const summaries = normalizeSummaryList(
          Array.isArray(response?.histories) ? response.histories : []
        );

        setConversationList((prev) => mergeSummaryList(prev, summaries));

        const currentSummary = summaries.find((item) => item.id === normalizedConversationId);
        const shouldRetry =
          remainingAttempts > 0 &&
          currentSummary &&
          currentSummary.messageCount > 0 &&
          currentSummary.title === "新会话";

        if (shouldRetry) {
          window.setTimeout(
            () => refreshHistoryTitleWithRetry(normalizedConversationId, remainingAttempts - 1),
            1200
          );
        }
      })
      .catch(() => {
        if (remainingAttempts > 0) {
          window.setTimeout(
            () => refreshHistoryTitleWithRetry(normalizedConversationId, remainingAttempts - 1),
            1200
          );
        }
      });
  }

  async function runConversationStreamLoop(initialPlan) {
    if (
      streamLoopActiveRef.current ||
      !initialPlan ||
      !Array.isArray(initialPlan.messages) ||
      initialPlan.messages.length === 0
    ) {
      return;
    }

    streamLoopActiveRef.current = true;
    setStatus("streaming");
    setError("");
    setRetryNotice("");

    let nextPlan = initialPlan;

    try {
      while (nextPlan) {
        const currentPlan = nextPlan;
        const controller = new AbortController();
        const streamState = {
          activeAssistantMessageId: null,
          pendingContentBuffer: "",
          pendingReasoningBuffer: "",
          flushFrameId: null
        };
        abortRef.current = controller;
        streamingConversationIdRef.current = String(currentPlan.conversationId ?? "").trim();

        try {
          await streamChat({
            conversationId: currentPlan.conversationId,
            messages: currentPlan.messages,
            approvalMode: currentPlan.approvalMode,
            developerPrompt: currentPlan.developerPrompt,
            enableDeepThinking: currentPlan.enableDeepThinking,
            signal: controller.signal,
            onAgentEvent: (event) => {
              applyAgentEvent(event, streamState, currentPlan.conversationId, {
                source: "foreground"
              });
            }
          });
        } catch (streamError) {
          if (streamError?.name !== "AbortError") {
            setRetryNotice("");
            markConversationRunEndedLocally(currentPlan.conversationId, "error");
            setPendingApprovalValue(null, {
              conversationId: String(currentPlan.conversationId ?? "").trim()
            });
            attachConversationRuntimeReplyError(
              currentPlan.conversationId,
              streamState,
              streamError?.message || "流式请求失败"
            );
            break;
          }
        } finally {
          abortRef.current = null;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 0));

        if (hasPendingApprovalValue(currentPlan.conversationId)) {
          break;
        }

        nextPlan = null;
        while (!nextPlan) {
          const nextQueued = queuedUserMessagesRef.current[0];
          if (!nextQueued) {
            break;
          }

          const nextQueuedConversationId = String(nextQueued?.conversationId ?? "").trim();
          if (
            nextQueuedConversationId &&
            activeAgentRunConversationIdsRef.current.has(nextQueuedConversationId)
          ) {
            break;
          }

          nextPlan = buildQueuedRunPlan(nextQueued.messageId);
        }
      }
    } finally {
      streamLoopActiveRef.current = false;
      streamingConversationIdRef.current = "";
      setStatus("idle");
      abortRef.current = null;
      refreshHistoryTitleWithRetry(initialPlan.conversationId, 4);
    }
  }

  async function sendMessage(rawText) {
    const payload =
      typeof rawText === "string"
        ? { text: rawText, imageAttachments: [], parsedFileAttachments: [] }
        : rawText && typeof rawText === "object"
          ? rawText
          : { text: "", imageAttachments: [], parsedFileAttachments: [] };
    const imageAttachments = normalizeImageAttachments(
      Array.isArray(payload.imageAttachments)
        ? payload.imageAttachments
        : payload.imageAttachment
          ? [payload.imageAttachment]
          : []
    );
    const parsedFileAttachments = normalizeParsedFileAttachments(payload.parsedFileAttachments);
    const text = String(payload.text ?? "").trim();

    if (
      (!text && imageAttachments.length === 0 && parsedFileAttachments.length === 0) ||
      !historyLoaded ||
      !activeConversationId ||
      pendingApproval
    ) {
      return;
    }

    const targetConversationId = activeConversationId;
    const shouldPersistDraftConversation = isDraftConversationActive;
    const normalizedPayload = {
      text,
      imageAttachments,
      parsedFileAttachments
    };
    const shouldQueueMessage =
      isConversationCompressionActive(targetConversationId) ||
      isStreaming ||
      streamLoopActiveRef.current ||
      queuedUserMessagesRef.current.length > 0 ||
      activeAgentRunConversationIdsRef.current.has(targetConversationId);
    const userMessage = buildUserMessage(normalizedPayload, {
      localQueueState: shouldQueueMessage ? "queued" : ""
    });

    if (shouldQueueMessage) {
      updateQueuedUserMessageList((prev) => [
        ...prev,
        {
          messageId: userMessage.id,
          conversationId: targetConversationId,
          queuedAt: userMessage.timestamp,
          message: userMessage
        }
      ]);
      setError("");
      maybeStartQueuedRunForConversation(targetConversationId);

      return;
    }

    const nextMessages = [...messagesRef.current.map(normalizeChatMessage), userMessage];
    const messagesForApi = normalizeForApi(nextMessages);

    if (shouldPersistDraftConversation) {
      const initialPayload = buildConversationUpsertPayload({
        title: "新会话",
        workplacePath: draftConversation?.workplacePath ?? "",
        approvalMode:
          String(draftConversation?.approvalMode ?? activeConversationApprovalMode ?? "confirm"),
        developerPrompt: activeConversationDeveloperPrompt,
        skills: selectedSkillsRef.current,
        messages: toPersistableMessages(nextMessages)
      });

      try {
        const response = await upsertHistoryById(targetConversationId, initialPayload);
        const history = response?.history;

        if (history) {
          setConversationList((prev) => upsertSummary(prev, toSummary(history)));
          setDraftConversation((prev) => (prev?.id === targetConversationId ? null : prev));
        }
      } catch (persistError) {
        setError(persistError?.message || "初始化会话失败");
        return;
      }
    }

    setMessages((prev) => [...prev, userMessage]);
    await runConversationStreamLoop({
      conversationId: targetConversationId,
      messages: messagesForApi,
      approvalMode: String(
        shouldPersistDraftConversation
          ? draftConversation?.approvalMode ?? activeConversationApprovalMode
          : activeConversationApprovalMode
      ),
      developerPrompt: activeConversationDeveloperPrompt,
      enableDeepThinking: deepThinkingEnabled
    });
  }

  async function confirmPendingApproval() {
    const approvalId = String(pendingApproval?.approvalId ?? "").trim();
    const targetConversationId = String(pendingApproval?.conversationId ?? "").trim();
    const foregroundConversationId = String(streamingConversationIdRef.current ?? "").trim();
    const targetHasForegroundStream =
      Boolean(foregroundConversationId) && foregroundConversationId === targetConversationId;
    const canBindForegroundStream = !foregroundConversationId || targetHasForegroundStream;

    if (!approvalId || !targetConversationId || isCompressing || targetHasForegroundStream) {
      return;
    }

    if (canBindForegroundStream) {
      setStatus("streaming");
      streamingConversationIdRef.current = targetConversationId;
    }
    setPendingApprovalValue(null, { conversationId: targetConversationId });

    const controller = new AbortController();
    if (canBindForegroundStream) {
      abortRef.current = controller;
    }
    const streamState = {
      activeAssistantMessageId: null,
      pendingContentBuffer: "",
      pendingReasoningBuffer: "",
      flushFrameId: null
    };

    try {
      await confirmToolApprovalById(approvalId, controller.signal, (event) => {
        applyAgentEvent(event, streamState, targetConversationId, {
          source: "foreground"
        });
      });
    } catch (approvalError) {
      if (approvalError?.name !== "AbortError") {
        markConversationRunEndedLocally(targetConversationId, "error");
        setPendingApprovalValue(null, { conversationId: targetConversationId });
        attachConversationRuntimeReplyError(
          targetConversationId,
          streamState,
          approvalError?.message || "确认执行失败"
        );
      }
    } finally {
      if (canBindForegroundStream) {
        if (String(streamingConversationIdRef.current ?? "").trim() === targetConversationId) {
          streamingConversationIdRef.current = "";
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (!streamLoopActiveRef.current) {
          setStatus("idle");
        }
      }

      if (!hasPendingApprovalValue(targetConversationId)) {
        const nextQueued = queuedUserMessagesRef.current[0];
        const nextQueuedConversationId = String(nextQueued?.conversationId ?? "").trim();
        const nextPlan = nextQueued ? buildQueuedRunPlan(nextQueued.messageId) : null;
        if (
          nextPlan &&
          (
            !nextQueuedConversationId ||
            !activeAgentRunConversationIdsRef.current.has(nextQueuedConversationId)
          )
        ) {
          void runConversationStreamLoop(nextPlan);
        }
      }
    }
  }

  async function rejectPendingApproval() {
    const approvalId = String(pendingApproval?.approvalId ?? "").trim();

    if (!approvalId || isCompressing) {
      return;
    }

    try {
      await rejectToolApprovalById(approvalId);
      setPendingApprovalValue(null, {
        conversationId: String(pendingApproval?.conversationId ?? "").trim()
      });
      setError("已拒绝该工具操作");
    } catch (rejectError) {
      setError(rejectError?.message || "拒绝执行失败");
    }
  }

  async function stopStream() {
    setRetryNotice("");
    const targetConversationId = String(activeConversationIdRef.current ?? "").trim();
    const activeAbortController = abortRef.current;
    const localRunLikelyActive =
      Boolean(activeAbortController) ||
      Boolean(streamLoopActiveRef.current) ||
      Boolean(hasPendingApprovalValue(targetConversationId)) ||
      Boolean(
        targetConversationId &&
        (
          activeAgentRunConversationIdsRef.current.has(targetConversationId) ||
          String(streamingConversationIdRef.current ?? "").trim() === targetConversationId
        )
      );
    let shouldFinalizeLocally = false;

    if (activeAbortController) {
      activeAbortController.abort();
      shouldFinalizeLocally = true;
    }

    if (!targetConversationId) {
      return;
    }

    try {
      const stopResult = await stopConversationRunById(targetConversationId);
      shouldFinalizeLocally =
        shouldFinalizeLocally ||
        Boolean(stopResult?.success) ||
        Boolean(stopResult?.stopped === false);
    } catch {
      shouldFinalizeLocally = shouldFinalizeLocally || localRunLikelyActive;
    }

    if (shouldFinalizeLocally || localRunLikelyActive) {
      abortRef.current = null;
      setPendingApprovalValue(null, { conversationId: targetConversationId });
      clearConversationRuntimeReplyError(targetConversationId);
      markConversationRunEndedLocally(targetConversationId, "aborted");
    }
  }

  async function clearChat() {
    if (
      activeConversationIsRunning ||
      isCompressing ||
      !historyLoaded ||
      !activeConversationId ||
      pendingApproval
    ) {
      return;
    }

    try {
      const response = await clearHistoryById(activeConversationId);
      const history = response?.history;
      if (!history) {
        throw new Error("清空会话失败");
      }

      applyPersistedHistorySnapshot(activeConversationId, history);
      updateQueuedUserMessageList((prev) =>
        prev.filter(
          (item) => String(item?.conversationId ?? "").trim() !== String(activeConversationId)
        )
      );
      clearConversationRuntimeReplyError(activeConversationId);
      setError("");
      setRetryNotice("");
      setStatus("idle");
    } catch (clearError) {
      setError(clearError?.message || "清空会话失败");
    }
  }

  return useMemo(
    () => ({
      messages,
      conversationList,
      activeConversationId,
      activeConversationTitle,
      activeConversationWorkplace,
      activeConversationWorkplaceLocked,
      activeConversationApprovalMode,
      activeConversationDeveloperPrompt,
      activeConversationSkills,
      activeConversationSource,
      activeConversationAgentDisplayName,
      activeConversationSubagents,
      activeConversationTokenUsage,
      activeConversationContextTokens,
      activeConversationContextUsageRatio,
      canManualCompress,
      skillCatalog,
      skillCatalogLoaded,
      tokenUsageRecords,
      isCompressing,
      compressionTrigger: activeCompressionTrigger,
      skillsDrawerOpen,
      setSkillsDrawerOpen,
      reloadSkillCatalog: refreshSkillCatalog,
      workplaceSelecting,
      pendingApproval,
      isDraftConversation: isDraftConversationActive,
      retryNotice,
      activeConversationRuntimeReplyError,
      queuedUserMessages: activeQueuedUserMessages,
      queuedUserMessageCount: activeQueuedUserMessages.length,
      isStreaming: activeConversationIsRunning,
      canStopStream: activeConversationCanStop,
      historyLoaded,
      deepThinkingEnabled,
      setDeepThinkingEnabled,
      error,
      loadConversation,
      createConversation,
      forkConversation,
      deleteConversation,
      deleteMessage,
      openWorkplaceBrowser,
      setConversationWorkplace,
      setConversationApprovalMode,
      setConversationSkills,
      setConversationDeveloperPrompt,
      compressConversation,
      sendMessage,
      removeQueuedUserMessage,
      reorderQueuedUserMessages,
      confirmPendingApproval,
      rejectPendingApproval,
      stopStream,
      clearChat
    }),
    [
      messages,
      conversationList,
      activeConversationId,
      activeConversationTitle,
      activeConversationWorkplace,
      activeConversationWorkplaceLocked,
      activeConversationApprovalMode,
      activeConversationDeveloperPrompt,
      activeConversationSkills,
      activeConversationSource,
      activeConversationAgentDisplayName,
      activeConversationSubagents,
      activeConversationTokenUsage,
      activeConversationContextTokens,
      activeConversationContextUsageRatio,
      canManualCompress,
      skillCatalog,
      skillCatalogLoaded,
      tokenUsageRecords,
      isCompressing,
      activeCompressionTrigger,
      skillsDrawerOpen,
      setSkillsDrawerOpen,
      refreshSkillCatalog,
      workplaceSelecting,
      pendingApproval,
      retryNotice,
      activeConversationRuntimeReplyError,
      activeQueuedUserMessages,
      queuedUserMessages.length,
      activeConversationIsRunning,
      activeConversationCanStop,
      historyLoaded,
      deepThinkingEnabled,
      error,
      loadConversation,
      createConversation,
      forkConversation,
      deleteConversation,
      deleteMessage,
      openWorkplaceBrowser,
      setConversationWorkplace,
      setConversationApprovalMode,
      setConversationSkills,
      setConversationDeveloperPrompt,
      compressConversation,
      sendMessage,
      removeQueuedUserMessage,
      reorderQueuedUserMessages,
      confirmPendingApproval,
      rejectPendingApproval,
      stopStream,
      clearChat
    ]
  );
}
