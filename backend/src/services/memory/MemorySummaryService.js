import { createHash } from "node:crypto";

import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import { safeJsonParse } from "../../utils/safeJsonParse.js";
import {
  createEmptyMemorySummary,
  hasAnyWorkspaceSummary,
  normalizeGlobalSummary,
  normalizeWorkspaceSummary
} from "../config/MemorySummaryStore.js";

const DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_EFFECTIVE_CONTEXT_MAX_CHARS = 24000;
const DEFAULT_EFFECTIVE_CONTEXT_MESSAGE_MAX_CHARS = 8000;
const MEMORY_EVIDENCE_TOOL_NAME = "submit_memory_evidence";
const GLOBAL_SUMMARY_TOOL_NAME = "submit_global_memory";
const WORKSPACE_SUMMARY_TOOL_NAME = "submit_workspace_memory";
const SUMMARY_PREFIX = "[CONTEXT COMPACTION]";
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

function createMemoryEvidenceToolDefinition() {
  return {
    type: "function",
    function: {
      name: MEMORY_EVIDENCE_TOOL_NAME,
      description:
        "Submit compact memory evidence extracted from the conversation. Keep each field short and concrete.",
      parameters: {
        type: "object",
        properties: {
          userSignals: {
            type: "array",
            items: { type: "string" }
          },
          repoSignals: {
            type: "array",
            items: { type: "string" }
          },
          stableRules: {
            type: "array",
            items: { type: "string" }
          },
          decisions: {
            type: "array",
            items: { type: "string" }
          },
          risks: {
            type: "array",
            items: { type: "string" }
          },
          nextSignals: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["userSignals", "repoSignals", "stableRules", "decisions", "risks", "nextSignals"],
        additionalProperties: false
      }
    }
  };
}

function createGlobalSummaryToolDefinition() {
  return {
    type: "function",
    function: {
      name: GLOBAL_SUMMARY_TOOL_NAME,
      description:
        "Submit global long-term memory fields only. Exclude workspace-specific implementation details.",
      parameters: {
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
      }
    }
  };
}

function createWorkspaceSummaryToolDefinition() {
  return {
    type: "function",
    function: {
      name: WORKSPACE_SUMMARY_TOOL_NAME,
      description:
        "Submit repository-specific workspace memory fields only. Keep entries durable and non-transient.",
      parameters: {
        type: "object",
        properties: {
          purpose: {
            type: "string",
            minLength: 1
          },
          surfaces: {
            type: "array",
            items: { type: "string" }
          },
          invariants: {
            type: "array",
            items: { type: "string" }
          },
          entrypoints: {
            type: "array",
            items: { type: "string" }
          },
          gotchas: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["purpose", "surfaces", "invariants", "entrypoints", "gotchas"],
        additionalProperties: false
      }
    }
  };
}

function resolveStageMaxTokens(runtimeConfig = {}, stage = "evidence") {
  const configured = Number(runtimeConfig?.maxOutputTokens ?? 0);
  const fallbackByStage = {
    evidence: 360,
    global: 420,
    workspace: 460
  };
  const capByStage = {
    evidence: 520,
    global: 620,
    workspace: 680
  };
  const fallback = Number(fallbackByStage[stage] ?? 420);
  const cap = Number(capByStage[stage] ?? 680);
  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }

  return Math.max(160, Math.min(Math.trunc(configured), cap));
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
        ? Math.min(
            Math.max(Math.trunc(maxOutputTokens), 400),
            DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS
          )
        : DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS
  };
}

function buildCandidateHash(candidate) {
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

function mergePriorityItems(...groups) {
  const values = [];
  const seen = new Set();

  for (const group of groups) {
    const source = Array.isArray(group) ? group : [];
    for (const item of source) {
      const normalized = normalizeText(item);
      if (!normalized) {
        continue;
      }

      const compareKey = normalized.normalize("NFKC").toLowerCase();
      if (seen.has(compareKey)) {
        continue;
      }

      seen.add(compareKey);
      values.push(normalized);
    }
  }

  return values;
}

function normalizeListLine(value) {
  return normalizeText(String(value ?? "").replace(/^([-*+]|\d+[.)])\s+/u, ""));
}

function stripMarkdownArtifacts(value) {
  return String(value ?? "")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*/gu, "")
    .replace(/^#{1,6}\s*/gmu, "");
}

function stripSummaryPrefix(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.startsWith(SUMMARY_PREFIX)
    ? normalized.slice(SUMMARY_PREFIX.length).trim()
    : normalized;
}

function parseCompressionSummarySections(summaryText = "") {
  const sections = {
    goal: [],
    constraints: [],
    done: [],
    inProgress: [],
    blocked: [],
    keyDecisions: [],
    relevantFiles: [],
    nextSteps: [],
    criticalContext: [],
    toolsPatterns: []
  };

  let currentSection = "";
  let currentProgressSection = "";
  const lines = stripSummaryPrefix(summaryText).split(/\r?\n/u);

  for (const rawLine of lines) {
    const line = normalizeText(rawLine);
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^##\s+(.+)$/u);
    if (sectionMatch) {
      const heading = normalizeText(sectionMatch[1]).toLowerCase();
      currentProgressSection = "";
      if (heading === "goal") {
        currentSection = "goal";
      } else if (heading === "constraints") {
        currentSection = "constraints";
      } else if (heading === "progress") {
        currentSection = "progress";
      } else if (heading === "key decisions") {
        currentSection = "keyDecisions";
      } else if (heading === "relevant files") {
        currentSection = "relevantFiles";
      } else if (heading === "next steps") {
        currentSection = "nextSteps";
      } else if (heading === "critical context") {
        currentSection = "criticalContext";
      } else if (heading === "tools & patterns") {
        currentSection = "toolsPatterns";
      } else {
        currentSection = "";
      }
      continue;
    }

    const subSectionMatch = line.match(/^###\s+(.+)$/u);
    if (subSectionMatch && currentSection === "progress") {
      const heading = normalizeText(subSectionMatch[1]).toLowerCase();
      if (heading === "done") {
        currentProgressSection = "done";
      } else if (heading === "in progress") {
        currentProgressSection = "inProgress";
      } else if (heading === "blocked") {
        currentProgressSection = "blocked";
      } else {
        currentProgressSection = "";
      }
      continue;
    }

    const item = normalizeListLine(line);
    if (!item) {
      continue;
    }

    if (currentSection === "progress" && currentProgressSection) {
      sections[currentProgressSection].push(item);
      continue;
    }

    if (currentSection && currentSection !== "progress" && Array.isArray(sections[currentSection])) {
      sections[currentSection].push(item);
    }
  }

  return sections;
}

function normalizeWorkspaceFieldText(value) {
  return normalizeText(stripMarkdownArtifacts(normalizeListLine(value)));
}

function sanitizeWorkspaceItems(items = []) {
  return mergePriorityItems(
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeWorkspaceFieldText(item))
      .filter(Boolean)
  );
}

function sanitizeWorkspaceSummaryFields(summary) {
  const normalized = normalizeWorkspaceSummary(summary);
  return normalizeWorkspaceSummary({
    purpose: normalizeWorkspaceFieldText(normalized.purpose),
    surfaces: sanitizeWorkspaceItems(normalized.surfaces),
    invariants: sanitizeWorkspaceItems(normalized.invariants),
    entrypoints: sanitizeWorkspaceItems(normalized.entrypoints),
    gotchas: sanitizeWorkspaceItems(normalized.gotchas)
  });
}

function buildSanitizedGlobalSummary({
  candidateGlobal,
  previousGlobal
}) {
  return normalizeGlobalSummary({
    userProfile: mergePriorityItems(
      candidateGlobal?.userProfile,
      previousGlobal?.userProfile
    ),
    userPreferences: mergePriorityItems(
      candidateGlobal?.userPreferences,
      previousGlobal?.userPreferences
    ),
    generalTips: mergePriorityItems(
      candidateGlobal?.generalTips,
      previousGlobal?.generalTips
    )
  });
}

function buildSanitizedWorkspaceSummary({
  candidateWorkspace,
  previousWorkspace
}) {
  const normalizedCandidate = sanitizeWorkspaceSummaryFields(candidateWorkspace);
  const fallback = sanitizeWorkspaceSummaryFields(previousWorkspace);
  return sanitizeWorkspaceSummaryFields({
    purpose: normalizedCandidate.purpose || fallback.purpose,
    surfaces: mergePriorityItems(normalizedCandidate.surfaces, fallback.surfaces),
    invariants: mergePriorityItems(normalizedCandidate.invariants, fallback.invariants),
    entrypoints: mergePriorityItems(normalizedCandidate.entrypoints, fallback.entrypoints),
    gotchas: mergePriorityItems(normalizedCandidate.gotchas, fallback.gotchas)
  });
}

function createMemoryEvidencePrompt({
  workspacePath,
  previousGlobal,
  previousWorkspace,
  conversationContextText
}) {
  return [
    "Compress the conversation evidence for downstream memory extraction.",
    `Do not return prose. Call ${MEMORY_EVIDENCE_TOOL_NAME} exactly once.`,
    "Keep every array concise and durable. Avoid session-noise.",
    `Workspace path context (do not output as a field): ${workspacePath}`,
    "",
    "Previous global memory:",
    buildPromptPayloadString(previousGlobal),
    "",
    "Previous workspace memory:",
    buildPromptPayloadString(previousWorkspace),
    "",
    "Conversation evidence:",
    conversationContextText || "(none)"
  ].join("\n");
}

function createGlobalSummaryPrompt({ compactEvidence, previousGlobal }) {
  return [
    "Generate global cross-workspace memory only.",
    `Do not return prose. Call ${GLOBAL_SUMMARY_TOOL_NAME} exactly once.`,
    "Never include repository-specific implementation details in global memory.",
    "",
    "Compact evidence:",
    buildPromptPayloadString(compactEvidence),
    "",
    "Previous global memory:",
    buildPromptPayloadString(previousGlobal)
  ].join("\n");
}

function createWorkspaceSummaryPrompt({
  workspacePath,
  compactEvidence,
  previousWorkspace
}) {
  return [
    "Generate workspace repository memory only.",
    `Do not return prose. Call ${WORKSPACE_SUMMARY_TOOL_NAME} exactly once.`,
    "Focus on durable repository understanding. Exclude transient session status.",
    `Current workspace path context (do not output as a field): ${workspacePath}`,
    "",
    "Compact evidence:",
    buildPromptPayloadString(compactEvidence),
    "",
    "Previous workspace memory:",
    buildPromptPayloadString(previousWorkspace)
  ].join("\n");
}

function extractToolPayload(completion, toolName) {
  const toolCalls = Array.isArray(completion?.choices?.[0]?.message?.tool_calls)
    ? completion.choices[0].message.tool_calls
    : [];

  for (const toolCall of toolCalls) {
    const calledToolName = normalizeText(toolCall?.function?.name);
    if (calledToolName !== normalizeText(toolName)) {
      continue;
    }

    const parsed = safeJsonParse(toolCall?.function?.arguments ?? "", null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeCompactEvidence(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const toList = (value = []) =>
    mergePriorityItems(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeWorkspaceFieldText(item))
        .filter(Boolean)
    ).slice(0, 8);

  return {
    userSignals: toList(source.userSignals),
    repoSignals: toList(source.repoSignals),
    stableRules: toList(source.stableRules),
    decisions: toList(source.decisions),
    risks: toList(source.risks),
    nextSignals: toList(source.nextSignals)
  };
}

async function runToolCompletion({
  client,
  runtimeConfig,
  toolDefinition,
  toolName,
  prompt,
  stage
}) {
  const completion = await client.chat.completions.create({
    model: runtimeConfig.model,
    temperature: 0,
    max_tokens: resolveStageMaxTokens(runtimeConfig, stage),
    tools: [toolDefinition],
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

  return extractToolPayload(completion, toolName);
}

function sanitizeCandidatePayload({
  candidate,
  previousGlobal,
  previousWorkspace
}) {
  return {
    global: buildSanitizedGlobalSummary({
      candidateGlobal: candidate?.global,
      previousGlobal
    }),
    workspace: buildSanitizedWorkspaceSummary({
      candidateWorkspace: candidate?.workspace,
      previousWorkspace
    })
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
    const evidencePrompt = createMemoryEvidencePrompt({
      workspacePath,
      previousGlobal: currentSummary.global,
      previousWorkspace: previousWorkspaceSummary,
      conversationContextText
    });

    const client = createOpenAIClient(runtimeConfig);
    const compactEvidence = normalizeCompactEvidence(
      (await runToolCompletion({
        client,
        runtimeConfig,
        toolDefinition: createMemoryEvidenceToolDefinition(),
        toolName: MEMORY_EVIDENCE_TOOL_NAME,
        prompt: evidencePrompt,
        stage: "evidence"
      })) ?? {}
    );

    const globalPrompt = createGlobalSummaryPrompt({
      compactEvidence,
      previousGlobal: currentSummary.global
    });
    const workspacePrompt = createWorkspaceSummaryPrompt({
      workspacePath,
      compactEvidence,
      previousWorkspace: previousWorkspaceSummary
    });
    const globalPayload =
      (await runToolCompletion({
        client,
        runtimeConfig,
        toolDefinition: createGlobalSummaryToolDefinition(),
        toolName: GLOBAL_SUMMARY_TOOL_NAME,
        prompt: globalPrompt,
        stage: "global"
      })) ?? {};
    const workspacePayload =
      (await runToolCompletion({
        client,
        runtimeConfig,
        toolDefinition: createWorkspaceSummaryToolDefinition(),
        toolName: WORKSPACE_SUMMARY_TOOL_NAME,
        prompt: workspacePrompt,
        stage: "workspace"
      })) ?? {};

    const normalizedCandidate = {
      global: normalizeGlobalSummary(globalPayload),
      workspace: normalizeWorkspaceSummary(workspacePayload)
    };
    const candidate = sanitizeCandidatePayload({
      candidate: normalizedCandidate,
      previousGlobal: currentSummary.global,
      previousWorkspace: previousWorkspaceSummary
    });
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

    if (previousHash === nextHash) {
      return null;
    }

    const saved = await this.store.save(nextPayload);
    return {
      saved,
      workspacePath,
      changed: previousHash !== nextHash
    };
  }
}
