import { RemoteControlRuntimeService } from "../../../integrations/remote-control/runtime/RemoteControlRuntimeService.js";

export class FeishuRuntimeService extends RemoteControlRuntimeService {
  constructor(options = {}) {
    super({
      platformKey: "feishu",
      platformLabel: "飞书",
      turnSource: "feishu",
      messageKind: "feishu_user_message",
      defaultSessionKey: "feishu_default",
      coreConfigStore: options.configStore,
      controlConfigStore: options.remoteControlConfigStore,
      historyStore: options.remoteControlHistoryStore,
      channelToolRegistry: options.sharedToolRegistry,
      replyClient: options.feishuOpenApiClient,
      agentsPromptStore: options.agentsPromptStore,
      memorySummaryStore: options.memorySummaryStore,
      skillPromptBuilder: options.skillPromptBuilder,
      memoryStore: options.memoryStore,
      longTermMemoryRecallService: options.longTermMemoryRecallService,
      remoteHookRegistry: options.remoteHookRegistry,
      remoteHookBlockBuilder: options.remoteHookBlockBuilder,
      edgeTextToSpeechService: options.edgeTextToSpeechService,
      defaultWorkplacePath: options.defaultWorkplacePath,
      queueFlushDelayMs: options.queueFlushDelayMs
    });
  }
}
