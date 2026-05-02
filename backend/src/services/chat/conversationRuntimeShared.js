import os from "node:os";
import path from "node:path";

import { PROJECT_ROOT, YYZ_DIR } from "../../config/paths.js";
import { configSchema } from "../../schemas/configSchema.js";
import {
  applyModelProfileToRuntimeConfig,
  resolveModelProfile
} from "../config/modelProfileConfig.js";
import { runModelProviderCompletion } from "../modelProviders/runtime.js";

export const DEFAULT_HISTORY_TITLE = "新会话";
export const DEFAULT_WORKPLACE_PATH = path.resolve(PROJECT_ROOT);
const titleGenerationLocks = new Set();

function resolveHostSystemInfo() {
  const platform = String(process.platform ?? "").trim();
  const normalizedSystem =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "macos"
        : platform === "linux"
          ? "linux"
          : platform || "unknown";

  const release = String(os.release?.() ?? "").trim() || "unknown";
  const version =
    typeof os.version === "function"
      ? String(os.version() ?? "").trim() || release
      : release;

  return {
    normalizedSystem,
    platform: platform || "unknown",
    release,
    version
  };
}

const HOST_SYSTEM_INFO = resolveHostSystemInfo();

export function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function isAutoTitleCandidate(title) {
  const normalized = String(title ?? "").trim();
  return (
    normalized.length === 0 ||
    normalized === DEFAULT_HISTORY_TITLE ||
    normalized === "未命名会话"
  );
}

export function extractFirstSentence(input) {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(.{1,220}?)([。！？.!?\n]|$)/u);
  return String(match?.[1] ?? normalized).trim();
}

function sanitizeTitle(input) {
  const normalized = String(input ?? "")
    .replace(/["'`]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
}

export function buildForkTitle(title) {
  const baseTitle = sanitizeTitle(title) || DEFAULT_HISTORY_TITLE;
  const suffix = "（Fork）";
  const maxBaseLength = Math.max(1, 32 - suffix.length);
  const normalizedBase =
    baseTitle.length > maxBaseLength ? `${baseTitle.slice(0, maxBaseLength)}...` : baseTitle;
  return `${normalizedBase}${suffix}`;
}

function normalizeForTitleCompare(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[\s"'`，。！？,.!?:;；：、\-—_()（）【】\[\]{}<>《》]/g, "")
    .trim();
}

async function generateConversationTitle({ configStore, firstSentence }) {
  if (!firstSentence) {
    return "";
  }

  const configValidation = configSchema.safeParse(await configStore.read());
  if (!configValidation.success) {
    return "";
  }

  try {
    const runtimeConfig = applyModelProfileToRuntimeConfig(
      configValidation.data,
      resolveModelProfile(configValidation.data, "", "main")
    );
    const completion = await runModelProviderCompletion(runtimeConfig, {
      temperature: 0.2,
      max_tokens: 48,
      messages: [
        {
          role: "system",
          content:
            "你是会话标题生成器。请基于输入内容生成一个 8-16 字中文标题。要求概括主题，不要直接复述原句，不要使用引号。"
        },
        {
          role: "user",
          content: firstSentence
        }
      ]
    });

    const candidateTitle = sanitizeTitle(completion?.choices?.[0]?.message?.content ?? "");

    if (!candidateTitle) {
      return "";
    }

    if (
      normalizeForTitleCompare(candidateTitle) === normalizeForTitleCompare(firstSentence)
    ) {
      return "";
    }

    return candidateTitle;
  } catch {
    return "";
  }
}

export function scheduleAsyncTitleGeneration({
  conversationId,
  firstSentence,
  configStore,
  historyStore
}) {
  if (!conversationId || !firstSentence) {
    return;
  }

  if (titleGenerationLocks.has(conversationId)) {
    return;
  }

  titleGenerationLocks.add(conversationId);

  setTimeout(async () => {
    try {
      const latest = historyStore.getConversation(conversationId);

      if (!latest || !isAutoTitleCandidate(latest.title)) {
        return;
      }

      const generatedTitle = await generateConversationTitle({
        configStore,
        firstSentence
      });

      if (!generatedTitle) {
        return;
      }

      const fresh = historyStore.getConversation(conversationId);
      if (!fresh || !isAutoTitleCandidate(fresh.title)) {
        return;
      }

      historyStore.updateConversationTitle(conversationId, generatedTitle);
    } finally {
      titleGenerationLocks.delete(conversationId);
    }
  }, 0);
}

export async function loadApprovalRules(approvalRulesStore) {
  if (!approvalRulesStore || typeof approvalRulesStore.read !== "function") {
    return null;
  }

  return approvalRulesStore.read();
}

export async function loadAgentsPrompt(agentsPromptStore, workspacePath) {
  if (!agentsPromptStore || typeof agentsPromptStore.read !== "function") {
    return "";
  }

  const content = await agentsPromptStore.read(workspacePath);
  const globalPrompt = String(content?.globalPrompt ?? "").trim();
  const projectPrompt = String(content?.projectPrompt ?? "").trim();
  const soulPrompt = String(content?.soulPrompt ?? "").trim();

  if (!globalPrompt && !projectPrompt && !soulPrompt) {
    return "";
  }

  const sections = [
    "你正在遵守 workspace prompt 规则。优先级：项目级 SOUL.md / AGENTS.md 高于全局 AGENTS.md。",
    "<workspace-prompts>"
  ];

  if (soulPrompt) {
    sections.push("## 项目 SOUL.md");
    sections.push(soulPrompt);
  }

  if (globalPrompt) {
    sections.push("## 全局 AGENTS.md");
    sections.push(globalPrompt);
  }

  if (projectPrompt) {
    sections.push("## 项目 AGENTS.md");
    sections.push(projectPrompt);
  }

  sections.push("</workspace-prompts>");

  return sections.join("\n");
}

export async function loadMemorySummaryPrompt(memorySummaryStore, workspacePath) {
  if (!memorySummaryStore || typeof memorySummaryStore.getPromptData !== "function") {
    return "";
  }

  const promptData = await memorySummaryStore.getPromptData(workspacePath);
  if (!memorySummaryStore.hasPromptContent(promptData)) {
    return "";
  }

  const sections = [
    "The following is automatically maintained global/workspace memory in Markdown. It is background context, not new user input. If it conflicts with AGENTS.md or the current user request, follow AGENTS.md and the current user request.",
    "<memory-summary>"
  ];

  const globalMarkdown = String(promptData.globalMarkdown ?? "").trim();
  if (globalMarkdown) {
    sections.push("## Global Memory");
    sections.push(globalMarkdown);
  }

  const workspaceMarkdown = String(promptData.workspaceMarkdown ?? "").trim();
  if (workspaceMarkdown) {
    sections.push("## Workspace Memory");
    sections.push(`Workspace: ${String(promptData.workspacePath ?? workspacePath).trim()}`);
    sections.push(workspaceMarkdown);
  }

  sections.push("</memory-summary>");

  return sections.join("\n");
}

export async function resolvePinnedMemorySummaryPrompt({
  historyStore,
  memorySummaryStore,
  conversationId,
  workspacePath,
  existingConversation = null
} = {}) {
  const resolvedConversationId = String(conversationId ?? "").trim();
  const history =
    existingConversation ??
    (resolvedConversationId && historyStore?.getConversation
      ? historyStore.getConversation(resolvedConversationId)
      : null);

  if (history && typeof history.memorySummaryPrompt === "string") {
    return history.memorySummaryPrompt;
  }

  const prompt = await loadMemorySummaryPrompt(memorySummaryStore, workspacePath);

  if (
    resolvedConversationId &&
    historyStore &&
    typeof historyStore.updateConversationMemorySummaryPrompt === "function"
  ) {
    historyStore.updateConversationMemorySummaryPrompt(resolvedConversationId, prompt);
  }

  return prompt;
}

export async function buildSkillsSystemPrompt({
  skillPromptBuilder,
  activeSkillNames = [],
  includeSystem = true,
  workspacePath = ""
}) {
  if (!skillPromptBuilder || typeof skillPromptBuilder.buildIndexPrompt !== "function") {
    return "";
  }

  return skillPromptBuilder.buildIndexPrompt({
    selectedSkillNames: activeSkillNames,
    includeSystem,
    workspacePath
  });
}

export function createDeveloperPromptMessage(developerPrompt) {
  const normalizedPrompt = String(developerPrompt ?? "").trim();

  if (!normalizedPrompt) {
    return null;
  }

  return {
    role: "system",
    content: normalizedPrompt
  };
}

export function createPersonaPromptMessage(personaPrompt) {
  const normalizedPrompt = String(personaPrompt ?? "").trim();

  if (!normalizedPrompt) {
    return null;
  }

  return {
    role: "system",
    content: normalizedPrompt
  };
}

export function buildSubagentGuardPrompt() {
  return [
    "你当前运行在子智能体模式。",
    "工作区系统提示词、通用工具规范、skills 注入、文件解析注入、记忆 recall 注入仍然生效；这里额外补充的是子智能体专属约束。",
    "你的核心职责是完成被分配的那一小块任务，而不是接管主智能体的整体决策。",
    "权限边界：只允许使用当前运行时实际暴露给你的工具；某个工具没有出现在你的工具列表里，就视为无权限，不要假设自己能做。",
    "不要伪造工具结果、不要伪造主智能体结论、不要伪造公共池状态、不要把猜测包装成已经验证的事实。",
    "长期记忆边界：允许读取自动 recall 带来的记忆上下文，也允许使用只读记忆收益；但不允许主动写入、修改、合并、删除长期记忆。",
    "编排边界：除非当前工具列表明确暴露对应能力，否则不要假设自己可以创建、删除、调度其他智能体，也不要替主智能体做任务拆分结论。",
    "作用域边界：优先完成当前被分配的范围，不要顺手扩大到无关模块、无关重构、无关策略改写；如果发现范围外问题，只在汇报中提出。",
    "公共池读取：当任务依赖协作上下文、前序结论、其他智能体汇报或项目状态时，先用 pool_list / pool_read 查看，而不是重复向主智能体发问。",
    "pool_report 只用于共享阶段性进度、阻塞和协作情报；它会进入公共池并可能被其他子智能体看到，不要把最终完成交付写到这里。",
    "如果当前回合不是主智能体调度触发（例如用户直接对子智能体说话），不要使用 pool_report 或 subagent_finish_report。",
    "如果当前回合是由主智能体调度触发，最终完成交接优先使用 subagent_finish_report；这个工具只会在当前回合结束后定向发给主智能体。",
    "只有主智能体调度触发的子智能体回合，才会在回合结束后自动向主智能体回报；普通用户直接对子智能体说话，不会自动回报主智能体。",
    "公共池汇报时机：只有到达有价值的原子步骤边界时才汇报，不要每做一个微小动作就汇报。",
    "以下情况必须汇报：完成了一个可交付的研究结论；完成了一块已验证的实现；发现关键阻塞；需要主智能体决策；准备宣告任务完成。",
    "以下情况不要急着汇报：刚打开文件、刚想到猜测、还没形成结论、改动还没验证、信息粒度过碎。",
    "汇报内容要简洁且可接手，优先包含：本次完成了什么、证据或改动点、验证结果、剩余风险或阻塞、建议的下一步。",
    "如果没有做验证，必须明确写未验证，不要把未运行测试、未检查代码路径说成已完成。",
    "只有在当前分配范围已经真正完成，或者你已经明确进入阻塞/交接状态时，才给出阶段完成结论。"
  ].join("\n");
}

function createRuntimeModelLines(runtimeConfig = {}) {
  const model = String(runtimeConfig?.model ?? "").trim();
  const provider = String(runtimeConfig?.provider ?? "").trim();
  const profileName = String(runtimeConfig?.modelProfileName ?? "").trim();
  const profileId = String(runtimeConfig?.modelProfileId ?? "").trim();
  const lines = [];

  if (model) {
    lines.push(`当前运行模型(model): ${model}`);
  }
  if (provider) {
    lines.push(`当前模型接口(provider): ${provider}`);
  }
  if (profileName || profileId) {
    lines.push(
      `当前模型配置(profile): ${profileName || profileId}${profileName && profileId ? ` (${profileId})` : ""}`
    );
  }

  return lines;
}

export function createWorkplaceSystemPrompt(workplacePath, runtimeConfig = {}) {
  const homeDirectory = String(os.homedir?.() ?? "").trim();

  return [
    "你是 YYZ_CLAW，一个通用智能助手。",
    "你正在本地智能体工作模式。",
    ...createRuntimeModelLines(runtimeConfig),
    `当前操作系统: ${HOST_SYSTEM_INFO.normalizedSystem}`,
    `系统版本号: ${HOST_SYSTEM_INFO.release}`,
    `系统详细版本: ${HOST_SYSTEM_INFO.version}`,
    `系统平台标识: ${HOST_SYSTEM_INFO.platform}`,
    `用户主目录(home): ${homeDirectory}`,
    `用户主目录 .yyz: ${YYZ_DIR}`,
    `当前工作区(workplace): ${workplacePath}`,
    "如果涉及代码文件、目录、命令执行等任务，请默认以当前工作区作为起点。",
    "如果涉及身份、skills、背景、历史、模型、配置、长期记忆等 YYZ_CLAW 外部资源，请默认使用用户主目录 .yyz；项目根目录不再保存 .yyz 资源。"
  ].join("\n");
}

export function createLongTermMemorySystemPrompt() {
  return [
    "你可以使用 long-term memory tools 操作独立的 memory.sqlite。",
    "这个系统只用于跨会话长期记忆，不是短期上下文，不是聊天归档，不是知识库，不是向量检索，也不是自由图系统。",
    "禁止保存完整聊天内容、最近几轮消息、当前任务状态、工具调用日志和临时信息。",
    "只保存未来大概率仍有用、长期稳定的信息。",
    "长期记忆结构固定为三层：主题层 -> 内容层 -> 记忆节点层。",
    "只有确有必要时才新增别的主题。",
    "系统会在每轮请求前基于当前用户消息的关键词自动尝试召回底层记忆节点；这部分召回内容属于隐藏的临时上下文，不是新的用户输入。",
    "不要为了模拟系统 recall 而自行遍历全部记忆节点或把召回内容伪装成用户刚说的话。",
    "在执行任何长期记忆写入前，优先先调用 memory_find_candidates；至少也要先用 memory_browse 明确查看现有 topicId/contentId/memoryNodeId。",
    "memory_browse 只用于层级浏览和最终记忆节点详情：无参数返回主题节点列表；topicId 返回内容节点列表；contentId 返回记忆节点列表；memoryNodeId 返回该记忆节点详细内容和 relatedMemoryNodes。",
    "memory_find_candidates 用于在写入前查找最相近的现有 topic/content/node 候选，并决定优先 update、merge 还是 create。",
    "memory_retrieve 只用于查看单个主题/内容/记忆节点的描述文本：topicId 查看主题描述占位，contentId 查看内容描述，memoryNodeId 只查看该记忆节点的 explanation。",
    "memory_link_nodes 只用于在两个 memory node 之间建立或更新关系；不要给 topic 或 content 建关系。",
    "浏览列表时只返回当前层必要字段，字段名必须明确区分 topicId/contentId/memoryNodeId，不要用含糊的裸 id。",
    "写入时先判断是否值得长期保存，再查看是否已经有了类似结点，没有再选择/创建主题与内容，最后创建或更新记忆节点。",
    "memory_create_node 现在只接受现有 contentId；memory_create_content 现在只接受现有 topicId；不要把 create 工具当作自动补建父级的捷径。",
    "如果 memory_find_candidates 已给出高相似候选，优先 update 或 merge；不要通过新建 topic 或 content 来绕过去重。",
    "记忆节点必须包含：name、coreMemory、explanation、specificKeywords、generalKeywords；其中两组关键词都必须是字符串数组。",
    "记忆内容允许较长，不要求一律很短；但必须结构清楚、信息稳定、避免无意义重复。",
    "coreMemory 应尽量概括核心事实，但必要时可以稍长；explanation 用于补充背景、边界和原因。",
    "specificKeywords 写精确召回词，例如项目名、模块名、产品名、报错词、接口名、功能名、专有表达；generalKeywords 写泛化召回词，例如类别、主题、意图、抽象标签、场景词。",
    "两组关键词都要面向 recall 优化：既要有能强命中的具体词，也要有能放宽表达面的泛化词；不要写成聊天流水账，不要只写一堆过泛空词。"
  ].join("\n");
}

export async function buildConversationPromptMessages(options = {}) {
  const workplacePath = String(options.workspacePath ?? "").trim();
  const includeAgentsPrompt = options.includeAgentsPrompt !== false;
  const includeMemorySummaryPrompt = options.includeMemorySummaryPrompt !== false;
  const includeWorkplacePrompt = options.includeWorkplacePrompt !== false;
  const includeLongTermMemoryPrompt = options.includeLongTermMemoryPrompt !== false;
  const includeSkillsPrompt = options.includeSkillsPrompt !== false;
  const includeSubagentGuardPrompt = Boolean(options.includeSubagentGuardPrompt);
  const definitionPrompt = String(options.definitionPrompt ?? "").trim();
  const runtimeConfig =
    options.runtimeConfig && typeof options.runtimeConfig === "object" && !Array.isArray(options.runtimeConfig)
      ? options.runtimeConfig
      : {};
  const hasPinnedMemorySummaryPrompt = typeof options.memorySummaryPrompt === "string";
  const promptMessages = [];

  const developerPromptMessage = createDeveloperPromptMessage(options.developerPrompt);
  if (developerPromptMessage) {
    promptMessages.push(developerPromptMessage);
  }

  if (includeAgentsPrompt) {
    const agentsPrompt = await loadAgentsPrompt(options.agentsPromptStore, workplacePath);
    if (agentsPrompt) {
      promptMessages.push({
        role: "system",
        content: agentsPrompt
      });
    }
  }

  const personaPromptMessage = createPersonaPromptMessage(options.personaPrompt);
  if (personaPromptMessage) {
    promptMessages.push(personaPromptMessage);
  }

  if (includeMemorySummaryPrompt) {
    const memorySummaryPrompt = hasPinnedMemorySummaryPrompt
      ? options.memorySummaryPrompt
      : await loadMemorySummaryPrompt(options.memorySummaryStore, workplacePath);
    if (memorySummaryPrompt) {
      promptMessages.push({
        role: "system",
        content: memorySummaryPrompt
      });
    }
  }

  if (includeWorkplacePrompt) {
    promptMessages.push({
      role: "system",
      content: createWorkplaceSystemPrompt(workplacePath, runtimeConfig)
    });
  }

  if (includeLongTermMemoryPrompt) {
    promptMessages.push({
      role: "system",
      content: createLongTermMemorySystemPrompt()
    });
  }

  if (includeSubagentGuardPrompt) {
    promptMessages.push({
      role: "system",
      content: buildSubagentGuardPrompt()
    });
  }

  if (includeSkillsPrompt) {
    const skillsSystemPrompt = await buildSkillsSystemPrompt({
      skillPromptBuilder: options.skillPromptBuilder,
      activeSkillNames: Array.isArray(options.activeSkillNames) ? options.activeSkillNames : [],
      includeSystem: options.includeSystem !== false,
      workspacePath: workplacePath
    });
    if (skillsSystemPrompt) {
      promptMessages.push({
        role: "system",
        content: skillsSystemPrompt
      });
    }
  }

  if (definitionPrompt) {
    promptMessages.push({
      role: "system",
      content: definitionPrompt
    });
  }

  return promptMessages;
}

export function normalizeUsageRecordPayload(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = Number(usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completionTokens ?? 0);
  const totalTokens = Number(usage.totalTokens ?? promptTokens + completionTokens);

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens,
    promptTokensDetails:
      usage.promptTokensDetails && typeof usage.promptTokensDetails === "object"
        ? usage.promptTokensDetails
        : null,
    completionTokensDetails:
      usage.completionTokensDetails && typeof usage.completionTokensDetails === "object"
        ? usage.completionTokensDetails
        : null
  };
}

export function resolveAgentRuntimeConfig(config = {}, options = {}) {
  const useSubagentConfig = Boolean(options?.isSubagent);
  const role = String(options?.role ?? "").trim();
  const profile = resolveModelProfile(
    config,
    String(options?.modelProfileId ?? "").trim(),
    role || (useSubagentConfig ? "subagent" : "main")
  );
  const profiledConfig = applyModelProfileToRuntimeConfig(config, profile);
  const providerCapabilities =
    profiledConfig.providerCapabilities && typeof profiledConfig.providerCapabilities === "object"
      ? profiledConfig.providerCapabilities
      : {};
  const supportsThinking =
    providerCapabilities.supportsReasoningEffort ||
    providerCapabilities.supportsThinkingSwitch ||
    providerCapabilities.supportsReasoningContent;
  const enableDeepThinking = Boolean(options?.enableDeepThinking) && supportsThinking;
  const reasoningEffort = String(options?.reasoningEffort ?? "").trim();

  return {
    ...profiledConfig,
    enableDeepThinking,
    reasoningEffort
  };
}

const THINKING_MODE_VALUES = new Set(["off", "default", "low", "medium", "high", "xhigh", "max"]);
const THINKING_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

export function normalizeThinkingMode(value, fallback = "off") {
  const normalized = String(value ?? "").trim();
  if (THINKING_MODE_VALUES.has(normalized)) {
    return normalized;
  }

  const normalizedFallback = String(fallback ?? "").trim();
  if (!normalized && !normalizedFallback) {
    return "";
  }
  return THINKING_MODE_VALUES.has(normalizedFallback) ? normalizedFallback : "off";
}

export function inferThinkingModeFromRuntimeOptions(options = {}, fallback = "off") {
  const requestedMode = normalizeThinkingMode(options?.thinkingMode, "");
  if (requestedMode) {
    return requestedMode;
  }

  if (options?.enableDeepThinking === false) {
    return "off";
  }

  const reasoningEffort = String(options?.reasoningEffort ?? "").trim();
  if (THINKING_EFFORT_VALUES.has(reasoningEffort)) {
    return reasoningEffort;
  }

  if (options?.enableDeepThinking === true) {
    return "default";
  }

  return normalizeThinkingMode(fallback);
}

export function buildThinkingRuntimeOptions(thinkingMode) {
  const normalized = normalizeThinkingMode(thinkingMode);
  return {
    thinkingMode: normalized,
    enableDeepThinking: normalized !== "off",
    reasoningEffort: THINKING_EFFORT_VALUES.has(normalized) ? normalized : ""
  };
}

export function buildCompressionTokenSnapshot(compressionResult) {
  const estimatedTokensAfter = Number(compressionResult?.estimatedTokensAfter ?? 0);
  if (!Number.isFinite(estimatedTokensAfter) || estimatedTokensAfter <= 0) {
    return null;
  }

  return {
    promptTokens: estimatedTokensAfter,
    completionTokens: 0,
    totalTokens: estimatedTokensAfter
  };
}

export function buildCompressionSnapshotMetadata(compressionResult, fallbackModel = "") {
  const summaryCreatedAt = Number(
    compressionResult?.summaryMessage?.meta?.createdAt ??
      compressionResult?.summaryMessage?.timestamp ??
      Date.now()
  );

  return {
    createdAt: Number.isFinite(summaryCreatedAt) && summaryCreatedAt > 0 ? summaryCreatedAt : Date.now(),
    model: String(fallbackModel ?? "").trim()
  };
}
