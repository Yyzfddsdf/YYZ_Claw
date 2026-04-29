import { RemoteControlRuntimeService } from "../../../integrations/remote-control/runtime/RemoteControlRuntimeService.js";

export class FeishuRuntimeService extends RemoteControlRuntimeService {
  constructor(options = {}) {
    super({
      platformKey: "feishu",
      platformLabel: "飞书",
      controlConfigStore: options.remoteControlConfigStore,
      historyStore: options.historyStore,
      runtimeService: options.runtimeService,
      wakeDispatcher: options.wakeDispatcher,
      conversationRunCoordinator: options.conversationRunCoordinator,
      orchestratorSupervisorService: options.orchestratorSupervisorService,
      replyClient: options.feishuOpenApiClient,
      edgeTextToSpeechService: options.edgeTextToSpeechService,
      defaultWorkplacePath: options.defaultWorkplacePath,
      queueFlushDelayMs: options.queueFlushDelayMs
    });
  }
}
