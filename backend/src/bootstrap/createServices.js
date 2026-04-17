import path from "node:path";

import {
  APPROVAL_RULES_FILE,
  CONFIG_FILE,
  GLOBAL_AGENTS_FILE,
  HOOKS_DIR,
  RUNTIME_BLOCKS_DIR,
  MCP_CONFIG_FILE,
  MEMORY_SUMMARY_FILE,
  HISTORY_DB_FILE,
  HISTORY_DIR,
  MEMORY_DB_FILE,
  PROJECT_ROOT,
  SKILLS_DIR,
  SKILLS_SNAPSHOT_FILE,
  SUBAGENTS_DIR,
  TOOLS_DIR
} from "../config/paths.js";
import { ChatAgent } from "../services/agent/ChatAgent.js";
import { ConfigStore } from "../services/config/ConfigStore.js";
import { ApprovalRulesStore } from "../services/config/ApprovalRulesStore.js";
import { AgentsPromptStore } from "../services/config/AgentsPromptStore.js";
import { MemorySummaryStore } from "../services/config/MemorySummaryStore.js";
import { McpConfigStore } from "../services/config/McpConfigStore.js";
import { ConversationCompressionService } from "../services/context/ConversationCompressionService.js";
import { AttachmentParserService } from "../services/files/AttachmentParserService.js";
import { SqliteChatHistoryStore } from "../services/history/SqliteChatHistoryStore.js";
import { HookBlockBuilder } from "../services/hooks/HookBlockBuilder.js";
import { HookRegistry } from "../services/hooks/HookRegistry.js";
import { LongTermMemoryRecallService } from "../services/memory/LongTermMemoryRecallService.js";
import { MemorySummaryService } from "../services/memory/MemorySummaryService.js";
import { SqliteLongTermMemoryStore } from "../services/memory/SqliteLongTermMemoryStore.js";
import { McpManager } from "../services/mcp/McpManager.js";
import { createOrchestratorMessageAdapter } from "../services/orchestration/adapters/orchestratorMessageAdapter.js";
import { AgentWakeDispatcher } from "../services/orchestration/AgentWakeDispatcher.js";
import { ConversationAgentRuntimeService } from "../services/orchestration/ConversationAgentRuntimeService.js";
import { OrchestratorSchedulerService } from "../services/orchestration/OrchestratorSchedulerService.js";
import { OrchestratorSupervisorService } from "../services/orchestration/OrchestratorSupervisorService.js";
import { SqliteOrchestratorStore } from "../services/orchestration/SqliteOrchestratorStore.js";
import { RuntimeBlockRegistry } from "../services/runtime/RuntimeBlockRegistry.js";
import { RuntimeBlockRuntime } from "../services/runtime/RuntimeBlockRuntime.js";
import { RuntimeInjectionComposer } from "../services/runtime/RuntimeInjectionComposer.js";
import { RuntimeScopeBuilder } from "../services/runtime/RuntimeScopeBuilder.js";
import { ConversationRunCoordinator } from "../services/runs/ConversationRunCoordinator.js";
import { SkillCatalog } from "../services/skills/SkillCatalog.js";
import { SkillPromptBuilder } from "../services/skills/SkillPromptBuilder.js";
import { SkillValidator } from "../services/skills/SkillValidator.js";
import { AgentRuntimeFactory } from "../services/subagents/AgentRuntimeFactory.js";
import { SubagentDefinitionRegistry } from "../services/subagents/SubagentDefinitionRegistry.js";
import { ConversationEventBroadcaster } from "../services/stream/ConversationEventBroadcaster.js";
import { ToolRegistry } from "../services/tools/ToolRegistry.js";
import { UnifiedToolRegistry } from "../services/tools/UnifiedToolRegistry.js";

export async function createServices() {
  const localToolRegistry = new ToolRegistry();
  await localToolRegistry.autoRegisterFromDir(TOOLS_DIR);
  const hookRegistry = new HookRegistry();
  await hookRegistry.autoRegisterFromDir(HOOKS_DIR);
  const runtimeBlockRegistry = new RuntimeBlockRegistry();
  await runtimeBlockRegistry.autoRegisterFromDir(RUNTIME_BLOCKS_DIR);

  const configStore = new ConfigStore(CONFIG_FILE);
  await configStore.ensureFile();

  const mcpConfigStore = new McpConfigStore(MCP_CONFIG_FILE);
  await mcpConfigStore.ensureFile();

  const approvalRulesStore = new ApprovalRulesStore(APPROVAL_RULES_FILE);
  await approvalRulesStore.ensureFile();

  const agentsPromptStore = new AgentsPromptStore({
    globalFilePath: GLOBAL_AGENTS_FILE
  });
  const memorySummaryStore = new MemorySummaryStore(MEMORY_SUMMARY_FILE);
  await memorySummaryStore.ensureFile();

  const skillCatalog = new SkillCatalog({
    rootDir: SKILLS_DIR,
    snapshotFile: SKILLS_SNAPSHOT_FILE
  });
  await skillCatalog.ensureSeedSkills();
  await skillCatalog.read();

  const skillPromptBuilder = new SkillPromptBuilder({ skillCatalog });
  const skillValidator = new SkillValidator({ skillCatalog });

  const mcpManager = new McpManager({
    configStore: mcpConfigStore
  });
  await mcpManager.refresh();

  const toolRegistry = new UnifiedToolRegistry({
    localToolRegistry,
    mcpManager
  });

  const historyStore = new SqliteChatHistoryStore({
    dbFilePath: HISTORY_DB_FILE,
    dirPath: HISTORY_DIR,
    defaultWorkplacePath: PROJECT_ROOT
  });
  await historyStore.initialize();
  const orchestratorStore = new SqliteOrchestratorStore({
    dbFilePath: HISTORY_DB_FILE,
    dirPath: HISTORY_DIR
  });
  await orchestratorStore.initialize();

  const memoryStore = new SqliteLongTermMemoryStore({
    dbFilePath: MEMORY_DB_FILE
  });
  await memoryStore.initialize();
  const longTermMemoryRecallService = new LongTermMemoryRecallService({
    memoryStore,
    maxRecalledNodes: 3,
    maxSourceUserMessages: 2,
    minScore: 8
  });

  const compressionService = new ConversationCompressionService();
  const memorySummaryService = new MemorySummaryService({
    store: memorySummaryStore,
    configStore,
    historyStore,
    compressionService
  });
  const hookBlockBuilder = new HookBlockBuilder({
    hookRegistry,
    maxHooks: 3,
    maxBlockChars: 1800
  });
  const runtimeScopeBuilder = new RuntimeScopeBuilder({
    compressionService,
    recentTurnWindow: 10
  });
  const runtimeBlockRuntime = new RuntimeBlockRuntime({
    blockRegistry: runtimeBlockRegistry,
    scopeBuilder: runtimeScopeBuilder,
    services: {
      hookBlockBuilder
    },
    maxSystemBlocks: 3,
    maxSystemChars: 2400,
    maxCurrentUserBlocks: 2,
    maxCurrentUserChars: 12000
  });
  const runtimeInjectionComposer = new RuntimeInjectionComposer();
  const conversationEventBroadcaster = new ConversationEventBroadcaster();
  const conversationRunCoordinator = new ConversationRunCoordinator({
    conversationEventBroadcaster
  });
  const orchestratorSchedulerService = new OrchestratorSchedulerService({
    messageAdapter: createOrchestratorMessageAdapter(),
    store: orchestratorStore
  });
  const subagentDefinitionRegistry = new SubagentDefinitionRegistry({
    rootDir: SUBAGENTS_DIR
  });
  await subagentDefinitionRegistry.load();
  const agentRuntimeFactory = new AgentRuntimeFactory({
    baseToolRegistry: toolRegistry,
    baseHookRegistry: hookRegistry,
    sharedSubagentToolsDir: path.join(SUBAGENTS_DIR, "tools"),
    approvalRulesStore,
    longTermMemoryRecallService,
    runtimeBlockRegistry,
    runtimeScopeBuilder,
    runtimeInjectionComposer,
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000
  });
  const attachmentParserService = new AttachmentParserService();
  const conversationAgentRuntimeService = new ConversationAgentRuntimeService({
    chatAgent: null,
    agentRuntimeFactory,
    subagentDefinitionRegistry,
    configStore,
    historyStore,
    memoryStore,
    compressionService,
    approvalRulesStore,
    agentsPromptStore,
    memorySummaryStore,
    skillCatalog,
    skillValidator,
    skillPromptBuilder,
    memorySummaryService,
    orchestratorSchedulerService,
    orchestratorStore,
    orchestratorSupervisorService: null
  });
  const wakeDispatcher = new AgentWakeDispatcher({
    historyStore,
    schedulerService: orchestratorSchedulerService,
    orchestratorStore,
    runtimeService: conversationAgentRuntimeService,
    conversationEventBroadcaster,
    conversationRunCoordinator
  });
  const orchestratorSupervisorService = new OrchestratorSupervisorService({
    historyStore,
    orchestratorStore,
    schedulerService: orchestratorSchedulerService,
    wakeDispatcher,
    subagentDefinitionRegistry
  });
  wakeDispatcher.orchestratorSupervisorService = orchestratorSupervisorService;

  const chatAgent = new ChatAgent({
    toolRegistry,
    approvalRulesStore,
    longTermMemoryRecallService,
    runtimeBlockRuntime,
    runtimeInjectionComposer,
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000
  });
  conversationAgentRuntimeService.chatAgent = chatAgent;
  conversationAgentRuntimeService.orchestratorSupervisorService = orchestratorSupervisorService;

  return {
    toolRegistry,
    localToolRegistry,
    hookRegistry,
    hookBlockBuilder,
    runtimeBlockRegistry,
    runtimeScopeBuilder,
    runtimeBlockRuntime,
    runtimeInjectionComposer,
    orchestratorStore,
    orchestratorSchedulerService,
    subagentDefinitionRegistry,
    agentRuntimeFactory,
    conversationAgentRuntimeService,
    wakeDispatcher,
    conversationEventBroadcaster,
    conversationRunCoordinator,
    orchestratorSupervisorService,
    configStore,
    mcpConfigStore,
    approvalRulesStore,
    agentsPromptStore,
    memorySummaryStore,
    memorySummaryService,
    skillCatalog,
    skillPromptBuilder,
    skillValidator,
    mcpManager,
    historyStore,
    memoryStore,
    longTermMemoryRecallService,
    compressionService,
    attachmentParserService,
    chatAgent
  };
}
