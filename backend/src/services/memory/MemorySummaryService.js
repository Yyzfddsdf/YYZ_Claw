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

function createMemorySummaryToolDefinition() {
  return {
    type: "function",
    function: {
      name: MEMORY_SUMMARY_TOOL_NAME,
      description:
        "Submit the final compact memory summary. Keep global entries cross-workspace and durable. Keep workspace entries specific to the current repository and rewrite evidence into stable repo memory instead of copying a session recap.",
      parameters: {
        type: "object",
        properties: {
          global: {
            type: "object",
            properties: {
              userProfile: {
                type: "array",
                description:
                  "Stable cross-workspace user facts such as long-term environment, working setup, or durable role/context facts.",
                items: { type: "string" }
              },
              userPreferences: {
                type: "array",
                description:
                  "Stable cross-workspace preferences such as communication style, execution style, or preferred output shape.",
                items: { type: "string" }
              },
              generalTips: {
                type: "array",
                description:
                  "Stable cross-workspace tips such as environment caveats, terminal encoding reminders, or reusable workflow hints.",
                items: { type: "string" }
              }
            },
            required: ["userProfile", "userPreferences", "generalTips"],
            additionalProperties: false
          },
          workspace: {
            type: "object",
            properties: {
              purpose: {
                type: "string",
                description:
                  "One sentence: what this repository is for in the long run."
              },
              surfaces: {
                type: "array",
                description:
                  "The most important modules, directories, subsystems, flows, or technical surfaces in this repository.",
                items: { type: "string" }
              },
              invariants: {
                type: "array",
                description:
                  "Durable boundaries, rules, constraints, or behaviors that should stay true in this repository.",
                items: { type: "string" }
              },
              entrypoints: {
                type: "array",
                description:
                  "High-value starting points such as key files, commands, boot paths, or important ownership notes.",
                items: { type: "string" }
              },
              gotchas: {
                type: "array",
                description:
                  "Real recurring pitfalls or failure modes. Return an empty array if there are none.",
                items: { type: "string" }
              }
            },
            required: [
              "purpose",
              "surfaces",
              "invariants",
              "entrypoints",
              "gotchas"
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

function createWorkspaceSummaryPrompt({
  workspacePath,
  previousGlobal,
  previousWorkspace,
  conversationContextText
}) {
  return [
    "You are updating a compact durable memory summary for a coding agent.",
    `Do not return normal prose. Call ${MEMORY_SUMMARY_TOOL_NAME} exactly once with the final payload.`,
    "",
    "Write the memory in concise English. Keep file paths, code identifiers, and user-authored literals unchanged when needed.",
    "Treat the conversation context as evidence. Rewrite it into durable memory instead of copying a session review or exploration report.",
    "Do not include markdown headings, numbering, bold markers, or long paragraphs.",
    "Each array item should be a short standalone line.",
    "",
    "Use this exact JSON shape:",
    "{\"global\":{\"userProfile\":[],\"userPreferences\":[],\"generalTips\":[]},\"workspace\":{\"purpose\":\"\",\"surfaces\":[],\"invariants\":[],\"entrypoints\":[],\"gotchas\":[]}}",
    "",
    "Global section:",
    "- Only include durable facts that remain useful across workspaces.",
    "- Do not copy repo-specific implementation details into global.",
    "- Avoid near-duplicate phrasing.",
    "",
    "Workspace section:",
    "- This is a durable repository memory card, not a status update.",
    "- Focus on long-lived repo understanding: what the repo is for, where the important surfaces are, what must stay true, where to start, and what repeatedly goes wrong.",
    "- Exclude transient items such as: 'this session', 'reviewed', 'explored', 'not yet analyzed', 'next step', 'no current blockers', or temporary investigative gaps.",
    "- If a field is uncertain, leave it empty instead of inventing content.",
    "",
    "Field contract:",
    "1. global.userProfile",
    "   Question: what stable user facts remain true across workspaces?",
    "   Good: ['Works mainly in Windows / PowerShell environments']",
    "2. global.userPreferences",
    "   Question: what stable execution or communication preferences keep showing up?",
    "   Good: ['Prefers structured code-quality reviews']",
    "3. global.generalTips",
    "   Question: what reusable environment or workflow tips repeatedly matter?",
    "   Good: ['Use explicit UTF-8 encoding for terminal file reads and writes on Windows']",
    "4. workspace.purpose",
    "   Question: what is this repository for, in one sentence?",
    "   Good: 'Implements the anti-fraud assistant backend, orchestration, and supporting interfaces.'",
    "5. workspace.surfaces",
    "   Question: what major subsystems, directories, or flows matter most here?",
    "   Good: ['cmd/api/main.go', 'internal/bootstrap/server', 'case retrieval flow']",
    "6. workspace.invariants",
    "   Question: what durable boundaries, rules, or must-stay-true behaviors matter here?",
    "   Good: ['Keep memory-summary injection separate from user input']",
    "   Bad: ['Go', 'Gin', 'Uses GORM']",
    "7. workspace.entrypoints",
    "   Question: where should an agent start reading or executing to orient quickly?",
    "   Good: ['cmd/api/main.go starts the service and delegates bootstrapping to server.Run()']",
    "8. workspace.gotchas",
    "   Question: what real recurring pitfalls or failure modes matter here?",
    "   Good: ['Manual compression can no-op when the retained head/tail window is too large']",
    "",
    "Length limits:",
    "  global.userProfile: at most 8 items, each at most 180 characters",
    "  global.userPreferences: at most 8 items, each at most 180 characters",
    "  global.generalTips: at most 8 items, each at most 180 characters",
    "  workspace.purpose: at most 220 characters",
    "  workspace.surfaces: at most 5 items, each at most 120 characters",
    "  workspace.invariants: at most 5 items, each at most 180 characters",
    "  workspace.entrypoints: at most 5 items, each at most 200 characters",
    "  workspace.gotchas: at most 4 items, each at most 180 characters",
    "",
    "Do not copy prompt wording, section labels, or meta commentary into the result.",
    "",
    `Current workspace: ${workspacePath}`,
    "",
    "Previous global summary:",
    buildPromptPayloadString(previousGlobal),
    "",
    "Previous workspace summary:",
    buildPromptPayloadString(previousWorkspace),
    "",
    "Conversation evidence for this update:",
    conversationContextText || "(none)",
    "",
    "Now produce the final tool payload."
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

function sanitizeCandidatePayload({
  candidate,
  previousGlobal,
  previousWorkspace,
  messages,
  workspacePath
}) {
  return {
    global: buildSanitizedGlobalSummary({
      candidateGlobal: candidate?.global,
      previousGlobal,
      messages,
      workspacePath
    }),
    workspace: buildSanitizedWorkspaceSummary({
      candidateWorkspace: candidate?.workspace,
      previousWorkspace,
      messages,
      workspacePath
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

    const normalizedCandidate = normalizeCandidatePayload(parsed);
    const candidate = sanitizeCandidatePayload({
      candidate: normalizedCandidate,
      previousGlobal: currentSummary.global,
      previousWorkspace: previousWorkspaceSummary,
      messages,
      workspacePath
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

    if (previousHash === nextHash && !shouldPersistWorkspaceEntry) {
      return null;
    }

    if (previousHash === nextHash && shouldPersistWorkspaceEntry) {
      const previousEntry = currentSummary.workspaces[workspacePath] ?? null;
      if (
        previousEntry &&
        normalizeText(previousEntry.updatedAt) ===
          normalizeText(nextPayload.workspaces[workspacePath]?.updatedAt)
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
