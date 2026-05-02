import { createHash } from "node:crypto";

import {
  applyModelProfileToRuntimeConfig,
  resolveModelProfile
} from "../config/modelProfileConfig.js";
import { runModelProviderCompletion } from "../modelProviders/runtime.js";
import { safeJsonParse } from "../../utils/safeJsonParse.js";

const DEFAULT_MEMORY_SUMMARY_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_EFFECTIVE_CONTEXT_MAX_CHARS = 24000;
const DEFAULT_EFFECTIVE_CONTEXT_MESSAGE_MAX_CHARS = 8000;
const MEMORY_EVIDENCE_TOOL_NAME = "submit_memory_evidence";
const SUMMARY_PREFIX = "[CONTEXT COMPACTION]";
const PHASE_SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_MEMORY_MARKDOWN_CHARS = 12000;
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
  /下(一|1)步\s*(是|做|先|继续|开始|处理|推进)/u,
  /接下来\s*(做|开始|处理|继续|推进|先)/u,
  /(阶段|方案|结论|规则|约定|决策)\s*(定了|确定了|收敛了|确认了)/u,
  /(本轮|这个任务|这部分)\s*(完成了|搞定了|先这样|就这样)/u,
  /(关键风险|主要风险|阻塞点|后续注意|下次继续)/u
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

function resolveStageMaxTokens(runtimeConfig = {}, stage = "evidence") {
  const configured = Number(runtimeConfig?.maxOutputTokens ?? 0);
  const fallbackByStage = {
    evidence: 360,
    global: 900,
    workspace: 1000
  };
  const capByStage = {
    evidence: 520,
    global: 1200,
    workspace: 1200
  };
  const fallback = Number(fallbackByStage[stage] ?? 420);
  const cap = Number(capByStage[stage] ?? 680);
  if (!Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }

  return Math.max(160, Math.min(Math.trunc(configured), cap));
}

function resolveSummaryRuntimeConfig(runtimeConfig = {}) {
  const profiledConfig = applyModelProfileToRuntimeConfig(
    runtimeConfig,
    resolveModelProfile(runtimeConfig, "", "compression")
  );
  const model = normalizeText(profiledConfig?.model);
  const baseURL = normalizeText(profiledConfig?.baseURL);
  const apiKey = normalizeText(profiledConfig?.apiKey);
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
    provider: profiledConfig.provider,
    providerCapabilities: profiledConfig.providerCapabilities,
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
    formatMarkdownForPrompt(previousGlobal),
    "",
    "Previous workspace memory:",
    formatMarkdownForPrompt(previousWorkspace),
    "",
    "Conversation evidence:",
    conversationContextText || "(none)"
  ].join("\n");
}

function createGlobalSummaryPrompt({ compactEvidence, previousGlobal }) {
  return [
    "Rewrite the complete global memory Markdown document.",
    "Return Markdown only. Do not return JSON. Do not wrap the answer in a code fence.",
    "This is soft-structured memory: keep useful headings, concise bullets, and durable facts.",
    "Scope: global cross-workspace memory only.",
    "Include stable user profile, communication preferences, reusable operating rules, and durable cross-project tips.",
    "Never include repository-specific implementation details, transient task progress, tool logs, or one-off debugging noise.",
    "Prefer preserving existing useful memory and merging new evidence into it. Remove contradictions only when the new evidence is clearly newer or more explicit.",
    "",
    "Compact evidence:",
    buildPromptPayloadString(compactEvidence),
    "",
    "Previous global memory Markdown:",
    formatMarkdownForPrompt(previousGlobal),
    "",
    "Return the full next global memory Markdown document now."
  ].join("\n");
}

function createWorkspaceSummaryPrompt({
  workspacePath,
  compactEvidence,
  previousWorkspace
}) {
  return [
    "Rewrite the complete current workspace memory Markdown document.",
    "Return Markdown only. Do not return JSON. Do not wrap the answer in a code fence.",
    "This is soft-structured memory: keep useful headings, concise bullets, and durable facts.",
    "Scope: only the current workspace/repository.",
    "Include durable repository purpose, workspace info, architecture surfaces, entrypoints, invariants, stable rules, risks, gotchas, architectural decisions, and reusable handoff context.",
    "Prefer headings like: Workspace Info, Purpose, Architecture & Surfaces, Entrypoints, Invariants & Stable Rules, Risks & Gotchas, Architectural Decisions, Handoff Context.",
    "Handoff Context must be phrased as durable near-term handoff direction, not a disposable TODO list. Avoid items that will become wrong immediately after one task is completed.",
    "For status-like facts that may change, qualify them with phrases like \"as last observed\" or \"currently observed\" instead of stating them as permanent truth.",
    "Exclude global user preferences, unrelated repositories, raw chat history, tool logs, overly granular one-off debugging details, and temporary task noise.",
    `Current workspace path: ${workspacePath}`,
    "Prefer preserving existing useful memory and merging new evidence into it. Remove contradictions only when the new evidence is clearly newer or more explicit.",
    "",
    "Compact evidence:",
    buildPromptPayloadString(compactEvidence),
    "",
    "Previous workspace memory Markdown:",
    formatMarkdownForPrompt(previousWorkspace),
    "",
    "Return the full next workspace memory Markdown document now."
  ].join("\n");
}

function formatMarkdownForPrompt(value) {
  const normalized = normalizeMemoryMarkdown(value);
  return normalized || "(empty)";
}

function stripOuterMarkdownFence(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
  return match ? match[1].trim() : text;
}

function normalizeMemoryMarkdown(value) {
  const normalized = stripOuterMarkdownFence(value).replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length <= MAX_MEMORY_MARKDOWN_CHARS) {
    return normalized;
  }

  return normalized.slice(0, MAX_MEMORY_MARKDOWN_CHARS).trimEnd();
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
  runtimeConfig,
  toolDefinition,
  toolName,
  prompt,
  stage
}) {
  const completion = await runModelProviderCompletion(runtimeConfig, {
    temperature: 0,
    max_tokens: resolveStageMaxTokens(runtimeConfig, stage),
    tools: [toolDefinition],
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return extractToolPayload(completion, toolName);
}

async function runMarkdownCompletion({
  runtimeConfig,
  prompt,
  stage
}) {
  const completion = await runModelProviderCompletion(runtimeConfig, {
    temperature: 0,
    max_tokens: resolveStageMaxTokens(runtimeConfig, stage),
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return normalizeMemoryMarkdown(completion?.choices?.[0]?.message?.content ?? "");
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

    const currentSummary = await this.store.getPromptData(workspacePath);
    const previousGlobalMarkdown = normalizeMemoryMarkdown(currentSummary.globalMarkdown);
    const previousWorkspaceMarkdown = normalizeMemoryMarkdown(currentSummary.workspaceMarkdown);
    const previousUpdatedAt = normalizeText(currentSummary.workspaceUpdatedAt);
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
      previousGlobal: previousGlobalMarkdown,
      previousWorkspace: previousWorkspaceMarkdown,
      conversationContextText
    });

    const compactEvidence = normalizeCompactEvidence(
      (await runToolCompletion({
        runtimeConfig,
        toolDefinition: createMemoryEvidenceToolDefinition(),
        toolName: MEMORY_EVIDENCE_TOOL_NAME,
        prompt: evidencePrompt,
        stage: "evidence"
      })) ?? {}
    );

    const globalPrompt = createGlobalSummaryPrompt({
      compactEvidence,
      previousGlobal: previousGlobalMarkdown
    });
    const workspacePrompt = createWorkspaceSummaryPrompt({
      workspacePath,
      compactEvidence,
      previousWorkspace: previousWorkspaceMarkdown
    });
    const globalMarkdown =
      (await runMarkdownCompletion({
        runtimeConfig,
        prompt: globalPrompt,
        stage: "global"
      })) || previousGlobalMarkdown;
    const workspaceMarkdown =
      (await runMarkdownCompletion({
        runtimeConfig,
        prompt: workspacePrompt,
        stage: "workspace"
      })) || previousWorkspaceMarkdown;
    const previousComparable = {
      global: previousGlobalMarkdown,
      workspace: previousWorkspaceMarkdown
    };
    const candidate = {
      global: globalMarkdown,
      workspace: workspaceMarkdown
    };
    const previousHash = buildCandidateHash(previousComparable);
    const nextHash = buildCandidateHash(candidate);

    if (previousHash === nextHash) {
      return null;
    }

    const saved = {
      global: previousGlobalMarkdown,
      workspace: previousWorkspaceMarkdown
    };

    if (previousGlobalMarkdown !== globalMarkdown) {
      saved.global = await this.store.saveGlobalMarkdown(globalMarkdown);
    }

    if (previousWorkspaceMarkdown !== workspaceMarkdown) {
      saved.workspace = await this.store.saveWorkspaceMarkdown(workspacePath, workspaceMarkdown);
    }

    return {
      saved,
      workspacePath,
      changed: previousHash !== nextHash
    };
  }
}
