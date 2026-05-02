import path from "node:path";

import {
  APPROVAL_RULES_FILE,
  BACKGROUNDS_DIR,
  CONFIG_FILE,
  FEISHU_CONFIG_FILE,
  GLOBAL_AGENTS_FILE,
  HOOKS_DIR,
  RUNTIME_BLOCKS_DIR,
  MCP_CONFIG_FILE,
  REMOTE_CONTROL_CONFIG_FILE,
  MEMORY_SUMMARY_FILE,
  MEMORY_SUMMARY_DIR,
  PERSONAS_DIR,
  DEBATE_DB_FILE,
  HISTORY_DB_FILE,
  HISTORY_DIR,
  MEMORY_DB_FILE,
  PROJECT_ROOT,
  SKILLS_DIR,
  SKILLS_SNAPSHOT_FILE,
  SUBAGENTS_DIR,
  TOOLS_DIR
} from "../config/paths.js";
import { ensureYyzHome } from "../config/ensureYyzHome.js";
import { ChatAgent } from "../services/agent/ChatAgent.js";
import { ConfigStore } from "../services/config/ConfigStore.js";
import { BackgroundStore } from "../services/appearance/BackgroundStore.js";
import { FeishuConfigStore } from "../im/feishu/config/FeishuConfigStore.js";
import { ApprovalRulesStore } from "../services/config/ApprovalRulesStore.js";
import { AgentsPromptStore } from "../services/config/AgentsPromptStore.js";
import { MemorySummaryStore } from "../services/config/MemorySummaryStore.js";
import { PersonaStore } from "../services/personas/PersonaStore.js";
import { McpConfigStore } from "../services/config/McpConfigStore.js";
import { ConversationCompressionService } from "../services/context/ConversationCompressionService.js";
import { AttachmentParserService } from "../services/files/AttachmentParserService.js";
import { SqliteChatHistoryStore } from "../services/history/SqliteChatHistoryStore.js";
import { FeishuLongConnectionService } from "../im/feishu/runtime/FeishuLongConnectionService.js";
import { FeishuRuntimeService } from "../im/feishu/runtime/FeishuRuntimeService.js";
import { FeishuWebhookIngestService } from "../im/feishu/ingest/FeishuWebhookIngestService.js";
import { FeishuOpenApiClient } from "../im/feishu/transport/FeishuOpenApiClient.js";
import { DebateService } from "../services/debate/DebateService.js";
import { SqliteDebateStore } from "../services/debate/SqliteDebateStore.js";
import { RemoteControlConfigStore } from "../integrations/remote-control/config/RemoteControlConfigStore.js";
import { RemoteControlProviderAdapter } from "../integrations/remote-control/providers/RemoteControlProviderAdapter.js";
import { RemoteControlProviderRegistry } from "../integrations/remote-control/providers/RemoteControlProviderRegistry.js";
import { HookBlockBuilder } from "../services/hooks/HookBlockBuilder.js";
import { HookRegistry } from "../services/hooks/HookRegistry.js";
import { AutomationSchedulerService } from "../services/automation/AutomationSchedulerService.js";
import { SqliteAutomationTaskStore } from "../services/automation/SqliteAutomationTaskStore.js";
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
import { SpeechToTextService } from "../services/stt/SpeechToTextService.js";
import { EdgeTextToSpeechService } from "../services/tts/EdgeTextToSpeechService.js";
import { ToolRegistry } from "../services/tools/ToolRegistry.js";
import { UnifiedToolRegistry } from "../services/tools/UnifiedToolRegistry.js";

export async function createServices() {
  await ensureYyzHome();

  const localToolRegistry = new ToolRegistry();
  await localToolRegistry.autoRegisterFromDir(TOOLS_DIR);
  const hookRegistry = new HookRegistry();
  await hookRegistry.autoRegisterFromDir(HOOKS_DIR);
  const runtimeBlockRegistry = new RuntimeBlockRegistry();
  await runtimeBlockRegistry.autoRegisterFromDir(RUNTIME_BLOCKS_DIR);

  const configStore = new ConfigStore(CONFIG_FILE);
  await configStore.ensureFile();
  const feishuConfigStore = new FeishuConfigStore(FEISHU_CONFIG_FILE);
  await feishuConfigStore.ensureFile();
  const remoteControlConfigStore = new RemoteControlConfigStore(REMOTE_CONTROL_CONFIG_FILE);
  await remoteControlConfigStore.ensureFile();
  const backgroundStore = new BackgroundStore({
    rootDir: BACKGROUNDS_DIR
  });
  await backgroundStore.ensureDir();

  const mcpConfigStore = new McpConfigStore(MCP_CONFIG_FILE);
  await mcpConfigStore.ensureFile();

  const approvalRulesStore = new ApprovalRulesStore(APPROVAL_RULES_FILE);
  await approvalRulesStore.ensureFile();

  const agentsPromptStore = new AgentsPromptStore({
    globalFilePath: GLOBAL_AGENTS_FILE
  });
  const memorySummaryStore = new MemorySummaryStore({
    rootDir: MEMORY_SUMMARY_DIR,
    legacyJsonFilePath: MEMORY_SUMMARY_FILE
  });
  await memorySummaryStore.ensureFile();

  const skillCatalog = new SkillCatalog({
    rootDir: SKILLS_DIR,
    snapshotFile: SKILLS_SNAPSHOT_FILE
  });
  await skillCatalog.ensureSeedSkills();
  await skillCatalog.read();

  const skillPromptBuilder = new SkillPromptBuilder({ skillCatalog });
  const skillValidator = new SkillValidator({ skillCatalog });
  const personaStore = new PersonaStore({
    rootDir: PERSONAS_DIR
  });

  const mcpManager = new McpManager({
    configStore: mcpConfigStore
  });
  await mcpManager.refresh();
  const speechToTextService = new SpeechToTextService();
  const edgeTextToSpeechService = new EdgeTextToSpeechService({
    defaultVoice: "zh-CN-XiaoxiaoNeural",
    defaultRate: "+0%",
    defaultVolume: "+0%",
    defaultPitch: "+0Hz",
    connectionTimeoutMs: 20000
  });

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
  const automationTaskStore = new SqliteAutomationTaskStore({
    dbFilePath: HISTORY_DB_FILE,
    dirPath: HISTORY_DIR
  });
  await automationTaskStore.initialize();
  const debateStore = new SqliteDebateStore({
    dbFilePath: DEBATE_DB_FILE,
    dirPath: HISTORY_DIR
  });
  await debateStore.initialize();

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
  const debateService = new DebateService({
    store: debateStore,
    configStore
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
  const feishuOpenApiClient = new FeishuOpenApiClient({
    configStore: feishuConfigStore
  });
  const feishuRuntimeService = new FeishuRuntimeService({
    remoteControlConfigStore,
    historyStore,
    feishuOpenApiClient,
    edgeTextToSpeechService,
    defaultWorkplacePath: PROJECT_ROOT,
    queueFlushDelayMs: 1200
  });
  const feishuWebhookIngestService = new FeishuWebhookIngestService({
    runtimeService: feishuRuntimeService,
    openApiClient: feishuOpenApiClient,
    attachmentParserService,
    speechToTextService,
    configStore
  });
  const feishuLongConnectionService = new FeishuLongConnectionService({
    configStore: feishuConfigStore,
    eventIngestService: feishuWebhookIngestService
  });
  const remoteControlProviderRegistry = new RemoteControlProviderRegistry();
  const feishuProviderAdapter = new RemoteControlProviderAdapter({
    providerKey: "feishu",
    configStore: feishuConfigStore,
    runtimeService: feishuRuntimeService,
    eventIngestService: feishuWebhookIngestService,
    connectionService: feishuLongConnectionService
  });
  remoteControlProviderRegistry.register({
    key: "feishu",
    label: "飞书",
    adapter: feishuProviderAdapter
  });
  const initialRemoteControlConfig = await remoteControlConfigStore.read();
  await feishuProviderAdapter.setActive(
    String(initialRemoteControlConfig.activeProviderKey ?? "").trim().toLowerCase() === "feishu",
    {
      forceRefresh: true
    }
  );
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
    personaStore,
    memorySummaryService,
    orchestratorSchedulerService,
    orchestratorStore,
    orchestratorSupervisorService: null
  });
  const automationSchedulerService = new AutomationSchedulerService({
    taskStore: automationTaskStore,
    historyStore,
    runtimeService: conversationAgentRuntimeService,
    wakeDispatcher: null,
    conversationRunCoordinator,
    orchestratorSupervisorService: null,
    defaultWorkplacePath: PROJECT_ROOT,
    tickIntervalMs: 15000,
    maxDueTasksPerTick: 10
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
    subagentDefinitionRegistry,
    configStore
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
  feishuRuntimeService.runtimeService = conversationAgentRuntimeService;
  feishuRuntimeService.wakeDispatcher = wakeDispatcher;
  feishuRuntimeService.conversationRunCoordinator = conversationRunCoordinator;
  feishuRuntimeService.orchestratorSupervisorService = orchestratorSupervisorService;
  automationSchedulerService.wakeDispatcher = wakeDispatcher;
  automationSchedulerService.orchestratorSupervisorService = orchestratorSupervisorService;
  automationSchedulerService.start();

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
    backgroundStore,
    remoteControlConfigStore,
    remoteControlProviderRegistry,
    feishuConfigStore,
    mcpConfigStore,
    approvalRulesStore,
    agentsPromptStore,
    memorySummaryStore,
    memorySummaryService,
    skillCatalog,
    skillPromptBuilder,
    skillValidator,
    personaStore,
    mcpManager,
    speechToTextService,
    edgeTextToSpeechService,
    historyStore,
    automationTaskStore,
    automationSchedulerService,
    debateStore,
    debateService,
    memoryStore,
    longTermMemoryRecallService,
    compressionService,
    attachmentParserService,
    feishuOpenApiClient,
    feishuWebhookIngestService,
    feishuLongConnectionService,
    feishuRuntimeService,
    feishuProviderAdapter,
    chatAgent
  };
}
