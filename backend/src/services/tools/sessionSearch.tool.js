import {
  applyModelProfileToRuntimeConfig,
  resolveModelProfile
} from "../config/modelProfileConfig.js";
import { runModelProviderCompletion } from "../modelProviders/runtime.js";

const MAX_SESSION_CHARS = 100_000;
const MAX_SESSIONS_TO_SUMMARIZE = 5;
const DEFAULT_SUMMARY_MAX_TOKENS = 4000;
const SUMMARY_TOOL_OUTPUT_TRUNCATE = 500;
const MAX_SUMMARY_RETRIES = 3;
const HIDDEN_CONVERSATION_SOURCES = Object.freeze(["tool"]);

function getHistoryStore(executionContext = {}) {
  const historyStore = executionContext.historyStore;

  if (!historyStore) {
    throw new Error("history store is not available");
  }

  return historyStore;
}

function resolveSummaryRuntimeConfig(runtimeConfig = {}) {
  const profiledConfig = applyModelProfileToRuntimeConfig(
    runtimeConfig,
    resolveModelProfile(runtimeConfig, "", "compression")
  );
  const model = String(profiledConfig?.model ?? "").trim();
  const baseURL = String(profiledConfig?.baseURL ?? "").trim();
  const apiKey = String(profiledConfig?.apiKey ?? "").trim();
  const maxTokens = Number(runtimeConfig?.compressionMaxOutputTokens ?? DEFAULT_SUMMARY_MAX_TOKENS);

  if (!model || !baseURL || !apiKey) {
    throw new Error("summary model config is incomplete");
  }

  return {
    model,
    baseURL,
    apiKey,
    provider: profiledConfig.provider,
    providerCapabilities: profiledConfig.providerCapabilities,
    maxTokens:
      Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.min(Math.max(Math.trunc(maxTokens), 300), 8000)
        : DEFAULT_SUMMARY_MAX_TOKENS
  };
}

function formatTimestamp(timestamp) {
  const value = Number(timestamp ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

function normalizeRoleFilter(roleFilter) {
  if (Array.isArray(roleFilter)) {
    return roleFilter.map((item) => String(item ?? "").trim()).filter(Boolean);
  }

  if (typeof roleFilter === "string") {
    return roleFilter
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function isSearchableConversationMessage(message) {
  const metaKind = String(message?.meta?.kind ?? "").trim();
  return metaKind !== "compression_summary" && metaKind !== "tool_event";
}

function buildPreviewFromMessages(messages = []) {
  const lastNonEmpty = [...messages]
    .reverse()
    .find((item) => String(item?.content ?? "").trim().length > 0);

  if (!lastNonEmpty) {
    return "";
  }

  const content = String(lastNonEmpty.content ?? "").trim();
  return content.length > 120 ? `${content.slice(0, 120)}...` : content;
}

function buildMatchContextText(match = {}) {
  const context = Array.isArray(match?.context) ? match.context : [];
  if (context.length === 0) {
    return "";
  }

  return context
    .map((item) => {
      const role = String(item?.role ?? "unknown").trim().toUpperCase() || "UNKNOWN";
      const toolName = String(item?.toolName ?? "").trim();
      const prefix = role === "TOOL" && toolName ? `[${role}:${toolName}]` : `[${role}]`;
      return `${prefix}\n${String(item?.content ?? "")}`.trim();
    })
    .join("\n\n");
}

function formatConversation(messages = []) {
  return messages
    .map((message) => {
      const role = String(message?.role ?? "unknown").trim().toUpperCase() || "UNKNOWN";
      let content = String(message?.content ?? "");

      if (role === "TOOL") {
        const toolName = String(message?.toolName ?? "").trim() || "unknown_tool";
        if (content.length > SUMMARY_TOOL_OUTPUT_TRUNCATE) {
          content =
            `${content.slice(0, Math.floor(SUMMARY_TOOL_OUTPUT_TRUNCATE / 2))}\n...[truncated]...\n` +
            content.slice(-Math.floor(SUMMARY_TOOL_OUTPUT_TRUNCATE / 2));
        }
        return `[TOOL:${toolName}]\n${content}`;
      }

      const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
      if (role === "ASSISTANT" && toolCalls.length > 0) {
        const toolNames = toolCalls
          .map((toolCall) => String(toolCall?.function?.name ?? "").trim())
          .filter(Boolean);
        if (toolNames.length > 0) {
          return `[ASSISTANT]\n[Called: ${toolNames.join(", ")}]${content ? `\n${content}` : ""}`;
        }
      }

      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

function truncateAroundMatches(fullText, query, maxChars = MAX_SESSION_CHARS) {
  const source = String(fullText ?? "");
  if (source.length <= maxChars) {
    return source;
  }

  const textLower = source.toLowerCase();
  const queryLower = String(query ?? "").trim().toLowerCase();
  if (!queryLower) {
    return `${source.slice(0, maxChars)}\n\n...[later conversation truncated]...`;
  }

  const matchPositions = [];
  const phraseRegex = new RegExp(queryLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

  for (const match of textLower.matchAll(phraseRegex)) {
    matchPositions.push(match.index ?? 0);
  }

  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(Boolean);
    if (terms.length > 1) {
      const termPositions = new Map();
      for (const term of terms) {
        const termRegex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        termPositions.set(
          term,
          Array.from(textLower.matchAll(termRegex), (match) => match.index ?? 0)
        );
      }

      const rarestTerm = [...termPositions.entries()].sort(
        (left, right) => left[1].length - right[1].length
      )[0]?.[0];

      for (const position of termPositions.get(rarestTerm) ?? []) {
        const allNear = terms.every((term) => {
          if (term === rarestTerm) {
            return true;
          }

          return (termPositions.get(term) ?? []).some((candidate) => Math.abs(candidate - position) < 200);
        });

        if (allNear) {
          matchPositions.push(position);
        }
      }
    }
  }

  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const termRegex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      for (const match of textLower.matchAll(termRegex)) {
        matchPositions.push(match.index ?? 0);
      }
    }
  }

  if (matchPositions.length === 0) {
    return `${source.slice(0, maxChars)}\n\n...[later conversation truncated]...`;
  }

  matchPositions.sort((left, right) => left - right);

  let bestStart = 0;
  let bestCount = 0;

  for (const candidate of matchPositions) {
    let windowStart = Math.max(0, candidate - Math.floor(maxChars / 4));
    let windowEnd = windowStart + maxChars;
    if (windowEnd > source.length) {
      windowEnd = source.length;
      windowStart = Math.max(0, windowEnd - maxChars);
    }

    const count = matchPositions.filter((position) => position >= windowStart && position < windowEnd).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = windowStart;
    }
  }

  const start = bestStart;
  const end = Math.min(source.length, start + maxChars);
  const prefix = start > 0 ? "...[earlier conversation truncated]...\n\n" : "";
  const suffix = end < source.length ? "\n\n...[later conversation truncated]..." : "";
  return `${prefix}${source.slice(start, end)}${suffix}`;
}

async function summarizeConversation({
  query,
  conversationText,
  runtimeConfig,
  conversationMeta
}) {
  const summaryRuntimeConfig = resolveSummaryRuntimeConfig(runtimeConfig);
  for (let attempt = 0; attempt < MAX_SUMMARY_RETRIES; attempt += 1) {
    try {
      const completion = await runModelProviderCompletion(summaryRuntimeConfig, {
        temperature: 0.1,
        max_tokens: summaryRuntimeConfig.maxTokens,
        messages: [
          {
            role: "system",
            content:
              "你在回看一段历史对话，任务是做检索回顾摘要。重点围绕搜索主题，总结：1. 用户想做什么；2. 做了哪些操作；3. 得到了什么结果；4. 关键命令、文件路径、配置值、报错；5. 是否还有未完成事项。只输出事实摘要，不要寒暄。"
          },
          {
            role: "user",
            content: [
              `搜索主题：${query}`,
              `会话标题：${conversationMeta.title || "未命名会话"}`,
              `会话来源：${conversationMeta.source || "chat"}`,
              `父会话：${conversationMeta.parentConversationId || "无"}`,
              `最后活跃时间：${formatTimestamp(conversationMeta.updatedAt) || "未知"}`,
              "",
              "对话内容：",
              conversationText
            ].join("\n")
          }
        ]
      });

      const content = String(completion?.choices?.[0]?.message?.content ?? "").trim();
      if (content) {
        return content;
      }
    } catch {
      if (attempt >= MAX_SUMMARY_RETRIES - 1) {
        throw new Error("summary unavailable");
      }
    }

    if (attempt < MAX_SUMMARY_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }

  return "";
}

async function summarizeConversationSafe(params) {
  try {
    return await summarizeConversation(params);
  } catch {
    return "";
  }
}

export default {
  name: "session_search",
  description:
    "Search past conversation history or browse recent sessions. Empty query lists recent sessions. Non-empty query searches historical messages, excludes compression summaries, and returns concise summaries of matched conversations.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Leave empty to browse recent sessions."
      },
      roleFilter: {
        type: "string",
        description: "Optional comma-separated roles to search, for example 'user,assistant'."
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SESSIONS_TO_SUMMARIZE,
        description: "Max matched conversations to summarize. Default 3."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const historyStore = getHistoryStore(executionContext);
    const currentConversationId = String(executionContext?.conversationId ?? "").trim();
    const runtimeConfig = executionContext?.runtimeConfig ?? {};
    const currentLineageIds = currentConversationId
      ? historyStore.getConversationLineageIds(currentConversationId)
      : [];
    const currentLineageIdSet = new Set(currentLineageIds);
    const limit = Math.max(
      1,
      Math.min(
        MAX_SESSIONS_TO_SUMMARIZE,
        Number.isFinite(Number(args.limit)) ? Math.trunc(Number(args.limit)) : 3
      )
    );
    const query = String(args.query ?? "").trim();

    if (!query) {
      const recent = historyStore
        .listRecentConversationsRich({
          limit: Math.max(limit + currentLineageIds.length + 2, 8),
          excludeConversationIds: currentLineageIds,
          excludeSources: HIDDEN_CONVERSATION_SOURCES,
          includeChildren: true
        })
        .slice(0, limit)
        .map((conversation) => ({
          conversationId: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          updatedAtText: formatTimestamp(conversation.updatedAt),
          messageCount: Number(conversation.messageCount ?? 0),
          preview: String(conversation.preview ?? "").trim(),
          source: conversation.source,
          model: conversation.model
        }));

      return {
        mode: "recent",
        count: recent.length,
        results: recent
      };
    }

    const roleFilter = normalizeRoleFilter(args.roleFilter);
    const rawMatches = historyStore.searchConversationMessages({
      query,
      roleFilter,
      excludeConversationIds: currentLineageIds,
      excludeSources: HIDDEN_CONVERSATION_SOURCES,
      excludeMetaKinds: ["compression_summary", "tool_event"],
      contextBefore: 1,
      contextAfter: 1,
      limit: 50,
      offset: 0
    });

    if (rawMatches.length === 0) {
      return {
        mode: "search",
        query,
        count: 0,
        results: []
      };
    }

    const uniqueConversationMatches = [];
    const seenConversationIds = new Set();
    for (const match of rawMatches) {
      const conversationId = String(match.conversationId ?? "").trim();
      if (!conversationId || currentLineageIdSet.has(conversationId) || seenConversationIds.has(conversationId)) {
        continue;
      }
      seenConversationIds.add(conversationId);
      uniqueConversationMatches.push(match);
      if (uniqueConversationMatches.length >= limit) {
        break;
      }
    }

    const prepared = uniqueConversationMatches
      .map((match) => {
        const conversation = historyStore.getConversation(match.conversationId);
        if (!conversation) {
          return null;
        }

        const searchableMessages = Array.isArray(conversation.messages)
          ? conversation.messages.filter(isSearchableConversationMessage)
          : [];
        if (searchableMessages.length === 0) {
          return null;
        }

        const transcriptBody = truncateAroundMatches(formatConversation(searchableMessages), query);
        const contextText = buildMatchContextText(match);
        const transcript = contextText
          ? `${contextText}\n\n[Full conversation]\n${transcriptBody}`
          : transcriptBody;
        return {
          match,
          conversation,
          transcript
        };
      })
      .filter(Boolean);

    const summaries = await Promise.all(
      prepared.map(async (item) => {
        const summary = await summarizeConversationSafe({
          query,
          conversationText: item.transcript,
          runtimeConfig,
          conversationMeta: item.conversation
        });

        return {
          conversationId: item.conversation.id,
          title: item.conversation.title,
          updatedAt: item.conversation.updatedAt,
          updatedAtText: formatTimestamp(item.conversation.updatedAt),
          when: formatTimestamp(item.conversation.updatedAt),
          source: String(item.conversation.source ?? "chat").trim() || "chat",
          model: String(item.conversation.model ?? "").trim(),
          matchSnippet: item.match.snippet,
          matchContext: item.match.context,
          summary:
            summary ||
            `[Raw preview - summary unavailable]\n${item.transcript.slice(0, 800)}${
              item.transcript.length > 800 ? "\n...[truncated]..." : ""
            }`
        };
      })
    );

    return {
      mode: "search",
      query,
      sessionsSearched: rawMatches.length,
      count: summaries.length,
      results: summaries
    };
  }
};
