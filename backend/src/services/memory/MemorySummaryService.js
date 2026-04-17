import { createHash } from "node:crypto";

import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import { safeJsonParse } from "../../utils/safeJsonParse.js";
import {
  createEmptyMemorySummary,
  hasAnyWorkspaceSummary,
  normalizeGlobalSummary,
  normalizeMemorySummaryPayload,
  normalizeWorkspaceSummary
} from "../config/MemorySummaryStore.js";

const DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_EFFECTIVE_CONTEXT_MAX_CHARS = 24000;
const DEFAULT_EFFECTIVE_CONTEXT_MESSAGE_MAX_CHARS = 8000;
const MEMORY_SUMMARY_TOOL_NAME = "submit_memory_summary";
const PHASE_SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;
const EXPLICIT_REFRESH_PATTERNS = [
  /总结一下/u,
  /更新一下(记忆|总结)/u,
  /记一下/u,
  /记住这(个|些)/u,
  /写进记忆/u,
  /下次从这里继续/u,
  /同步下进展/u
];
const PHASE_SHIFT_PATTERNS = [
  /下(一|1)步/u,
  /接下来/u,
  /(改完|做完|完成了|搞定了|先这样|就这样|定下来)/u,
  /(不要|必须|统一|改成|改为|只做|不做|默认|固定)/u,
  /(卡住|阻塞|风险|报错|失败|不通过|有问题|不行)/u
];

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMessage(message) {
  return {
    role: normalizeText(message?.role),
    content: typeof message?.content === "string" ? message.content : "",
    timestamp: Number(message?.timestamp ?? 0),
    meta:
      message?.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
        ? message.meta
        : {}
  };
}

function normalizeConversationMessages(messages = []) {
  return Array.isArray(messages)
    ? messages.map((message) => normalizeMessage(message)).filter((message) => message.role)
    : [];
}

function findLatestCompressionSummary(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (normalizeText(message?.meta?.kind) === "compression_summary") {
      return {
        message,
        index
      };
    }
  }

  return null;
}

function collectRecentUserTexts(messages = [], limit = 3) {
  const values = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (normalizeText(message?.role) !== "user") {
      continue;
    }

    const content = normalizeText(message?.content);
    if (!content) {
      continue;
    }

    values.push(content);
    if (values.length >= limit) {
      break;
    }
  }

  return values;
}

function hasExplicitRefreshRequest(messages = []) {
  const recentUserTexts = collectRecentUserTexts(messages, 3);
  return recentUserTexts.some((text) =>
    EXPLICIT_REFRESH_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function hasPhaseShiftSignal(messages = []) {
  const recentUserTexts = collectRecentUserTexts(messages, 4);
  return recentUserTexts.some((text) =>
    PHASE_SHIFT_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function getLatestMessageTimestamp(messages = []) {
  let latestTimestamp = 0;
  for (const message of messages) {
    const timestamp = Number(message?.timestamp ?? 0);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }

  return latestTimestamp;
}

function resolveRefreshReason(messages = [], previousUpdatedAt = "") {
  const explicitRequested = hasExplicitRefreshRequest(messages);
  const phaseShiftSignal = hasPhaseShiftSignal(messages);
  const latestCompressionSummary = findLatestCompressionSummary(messages);
  const latestCompressionAt = Math.max(
    Number(latestCompressionSummary?.message?.meta?.createdAt ?? 0),
    Number(latestCompressionSummary?.message?.timestamp ?? 0)
  );
  const previousUpdatedAtMs = Number.isFinite(Date.parse(previousUpdatedAt))
    ? Date.parse(previousUpdatedAt)
    : 0;
  const latestMessageAt = getLatestMessageTimestamp(messages);
  const hasNewActivity = latestMessageAt > previousUpdatedAtMs;
  const hasNewCompression =
    latestCompressionAt > 0 && latestCompressionAt > previousUpdatedAtMs;
  const cooldownElapsed =
    previousUpdatedAtMs <= 0 || latestMessageAt - previousUpdatedAtMs >= PHASE_SIGNAL_COOLDOWN_MS;
  const shouldRefreshFromPhaseSignal =
    phaseShiftSignal && hasNewActivity && cooldownElapsed && !hasNewCompression;

  return {
    explicitRequested,
    phaseShiftSignal,
    hasNewCompression,
    hasNewActivity,
    latestCompressionSummary,
    shouldRefresh: explicitRequested || hasNewCompression || shouldRefreshFromPhaseSignal
  };
}

function buildPromptPayloadString(value) {
  return JSON.stringify(value, null, 2);
}

function createMemorySummaryToolDefinition() {
  return {
    type: "function",
    function: {
      name: MEMORY_SUMMARY_TOOL_NAME,
      description: "Submit the compact global and workspace memory summary payload.",
      parameters: {
        type: "object",
        properties: {
          global: {
            type: "object",
            properties: {
              userProfile: {
                type: "array",
                items: { type: "string" }
              },
              userPreferences: {
                type: "array",
                items: { type: "string" }
              },
              generalTips: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["userProfile", "userPreferences", "generalTips"],
            additionalProperties: false
          },
          workspace: {
            type: "object",
            properties: {
              scope: { type: "string" },
              appliesTo: {
                type: "array",
                items: { type: "string" }
              },
              currentFocus: {
                type: "array",
                items: { type: "string" }
              },
              stableRules: {
                type: "array",
                items: { type: "string" }
              },
              reusableKnowledge: {
                type: "array",
                items: { type: "string" }
              },
              pitfalls: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: [
              "scope",
              "appliesTo",
              "currentFocus",
              "stableRules",
              "reusableKnowledge",
              "pitfalls"
            ],
            additionalProperties: false
          }
        },
        required: ["global", "workspace"],
        additionalProperties: false
      }
    }
  };
}

function resolveSummaryRuntimeConfig(runtimeConfig = {}) {
  const model =
    normalizeText(runtimeConfig?.compressionModel) || normalizeText(runtimeConfig?.model);
  const baseURL =
    normalizeText(runtimeConfig?.compressionBaseURL) || normalizeText(runtimeConfig?.baseURL);
  const apiKey =
    normalizeText(runtimeConfig?.compressionApiKey) || normalizeText(runtimeConfig?.apiKey);
  const enableDeepThinking = Boolean(runtimeConfig?.enableDeepThinking);
  const maxOutputTokens = Number(
    runtimeConfig?.compressionMaxOutputTokens ?? DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS
  );

  if (!model || !baseURL || !apiKey) {
    return null;
  }

  return {
    model,
    baseURL,
    apiKey,
    enableDeepThinking,
    maxOutputTokens:
      Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? Math.min(Math.max(Math.trunc(maxOutputTokens), 400), DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS)
        : DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS
  };
}

function buildCandidateHash(candidate) {
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

function createWorkspaceSummaryPrompt({
  workspacePath,
  previousGlobal,
  previousWorkspace,
  conversationContextText
}) {
  return [
    "You update a compact memory summary file for a coding agent.",
    `Do not answer with plain text. Call the ${MEMORY_SUMMARY_TOOL_NAME} tool exactly once with the final payload.`,
    "",
    "The JSON schema is:",
    "{\"global\":{\"userProfile\":[],\"userPreferences\":[],\"generalTips\":[]},\"workspace\":{\"scope\":\"\",\"appliesTo\":[],\"currentFocus\":[],\"stableRules\":[],\"reusableKnowledge\":[],\"pitfalls\":[]}}",
    "",
    "Rules:",
    "- Keep only durable, reusable information.",
    "- Drop transient retries, one-off edits, temporary experiments, and chat filler.",
    "- The workspace section is injected like a system prompt, so it must stay compact and high-signal.",
    "- Global fields are cross-workspace only: stable user facts, stable preferences, and general environment tips.",
    "- Preserve still-valid previous items unless new evidence clearly replaces them.",
    "- Use concise Chinese when possible.",
    "- Limits:",
    "  global.userProfile <= 8 items, each <= 180 chars",
    "  global.userPreferences <= 8 items, each <= 180 chars",
    "  global.generalTips <= 8 items, each <= 180 chars",
    "  workspace.scope <= 220 chars",
    "  workspace.appliesTo <= 5 items, each <= 120 chars",
    "  workspace.currentFocus <= 4 items, each <= 180 chars",
    "  workspace.stableRules <= 5 items, each <= 180 chars",
    "  workspace.reusableKnowledge <= 5 items, each <= 180 chars",
    "  workspace.pitfalls <= 4 items, each <= 180 chars",
    "",
    `Workspace: ${workspacePath}`,
    "",
    "Previous global summary:",
    buildPromptPayloadString(previousGlobal),
    "",
    "Previous workspace summary:",
    buildPromptPayloadString(previousWorkspace),
    "",
    "Conversation context selected with the same effective-message strategy used by conversation compression:",
    conversationContextText || "(none)",
    "",
    "Update the JSON now."
  ].join("\n");
}

function extractMemorySummaryToolPayload(completion) {
  const toolCalls = Array.isArray(completion?.choices?.[0]?.message?.tool_calls)
    ? completion.choices[0].message.tool_calls
    : [];

  for (const toolCall of toolCalls) {
    const toolName = normalizeText(toolCall?.function?.name);
    if (toolName !== MEMORY_SUMMARY_TOOL_NAME) {
      continue;
    }

    const parsed = safeJsonParse(toolCall?.function?.arguments ?? "", null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeCandidatePayload(candidate) {
  const normalized = normalizeMemorySummaryPayload({
    schemaVersion: 1,
    global: candidate?.global,
    workspaces: {
      __workspace__: {
        summary: candidate?.workspace,
        updatedAt: ""
      }
    }
  });

  return {
    global: normalizeGlobalSummary(normalized.global),
    workspace: normalizeWorkspaceSummary(normalized.workspaces.__workspace__?.summary)
  };
}

export class MemorySummaryService {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.configStore = options.configStore ?? null;
    this.historyStore = options.historyStore ?? null;
    this.compressionService = options.compressionService ?? null;
    this.scheduledConversationIds = new Set();
  }

  scheduleRefresh(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    if (!conversationId || this.scheduledConversationIds.has(conversationId)) {
      return;
    }

    this.scheduledConversationIds.add(conversationId);
    setTimeout(async () => {
      try {
        await this.refreshConversationSummary(options);
      } catch {
        // Memory summary refresh is best effort and must not break the main chat flow.
      } finally {
        this.scheduledConversationIds.delete(conversationId);
      }
    }, 0);
  }

  async refreshConversationSummary(options = {}) {
    if (!this.store || !this.configStore || !this.historyStore || !this.compressionService) {
      return null;
    }

    const conversationId = normalizeText(options.conversationId);
    if (!conversationId) {
      return null;
    }

    const conversation = this.historyStore.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    if (normalizeText(conversation?.source).toLowerCase() === "subagent") {
      return null;
    }

    const workspacePath = this.store.resolveWorkspacePathKey(conversation?.workplacePath);
    if (!workspacePath) {
      return null;
    }

    const rawMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messages = normalizeConversationMessages(rawMessages);
    if (messages.length === 0) {
      return null;
    }

    const currentSummary = await this.store.read();
    const previousWorkspaceEntry = currentSummary.workspaces[workspacePath] ?? null;
    const previousWorkspaceSummary = previousWorkspaceEntry?.summary ?? {};
    const previousUpdatedAt = normalizeText(previousWorkspaceEntry?.updatedAt);
    const refreshReason = resolveRefreshReason(messages, previousUpdatedAt);

    if (!refreshReason.shouldRefresh) {
      return null;
    }

    const runtimeConfig = resolveSummaryRuntimeConfig(await this.configStore.read());
    if (!runtimeConfig) {
      return null;
    }

    const conversationContextText = this.compressionService.buildEffectiveConversationSummaryText(
      rawMessages,
      {
        maxCharsPerMessage: DEFAULT_EFFECTIVE_CONTEXT_MESSAGE_MAX_CHARS,
        maxTotalChars: DEFAULT_EFFECTIVE_CONTEXT_MAX_CHARS
      }
    );
    const prompt = createWorkspaceSummaryPrompt({
      workspacePath,
      previousGlobal: currentSummary.global,
      previousWorkspace: previousWorkspaceSummary,
      conversationContextText
    });

    const client = createOpenAIClient(runtimeConfig);
    const completion = await client.chat.completions.create({
      model: runtimeConfig.model,
      temperature: 0,
      max_tokens: runtimeConfig.maxOutputTokens,
      tools: [createMemorySummaryToolDefinition()],
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      extra_body: {
        enable_thinking: Boolean(runtimeConfig.enableDeepThinking)
      }
    });

    const parsed = extractMemorySummaryToolPayload(completion);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const candidate = normalizeCandidatePayload(parsed);
    const previousComparable = {
      global: normalizeGlobalSummary(currentSummary.global),
      workspace: normalizeWorkspaceSummary(previousWorkspaceSummary)
    };
    const previousHash = buildCandidateHash(previousComparable);
    const nextHash = buildCandidateHash(candidate);

    const nextPayload = createEmptyMemorySummary();
    nextPayload.global = candidate.global;
    nextPayload.workspaces = {
      ...currentSummary.workspaces
    };

    const shouldPersistWorkspaceEntry =
      hasAnyWorkspaceSummary(candidate.workspace) || Boolean(previousWorkspaceEntry);

    if (shouldPersistWorkspaceEntry) {
      nextPayload.workspaces[workspacePath] = {
        summary: candidate.workspace,
        updatedAt: new Date().toISOString()
      };
    } else {
      delete nextPayload.workspaces[workspacePath];
    }

    if (previousHash === nextHash && !shouldPersistWorkspaceEntry) {
      return null;
    }

    if (previousHash === nextHash && shouldPersistWorkspaceEntry) {
      const previousEntry = currentSummary.workspaces[workspacePath] ?? null;
      if (
        previousEntry &&
        normalizeText(previousEntry.updatedAt) === normalizeText(nextPayload.workspaces[workspacePath]?.updatedAt)
      ) {
        return null;
      }
    }

    const saved = await this.store.save(nextPayload);
    return {
      saved,
      workspacePath,
      changed: previousHash !== nextHash
    };
  }
}
