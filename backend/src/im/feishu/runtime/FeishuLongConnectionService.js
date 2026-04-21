import * as lark from "@larksuiteoapi/node-sdk";

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildWsEventEnvelope(payload = {}) {
  const source = normalizeObject(payload);
  if (source.header && source.event) {
    return {
      schema: String(source.schema ?? "2.0").trim() || "2.0",
      header: normalizeObject(source.header),
      event: normalizeObject(source.event)
    };
  }

  const eventType = String(source.event_type ?? source.type ?? "").trim();
  if (!eventType) {
    return null;
  }

  const event = normalizeObject(source.event);
  const mergedEvent =
    Object.keys(event).length > 0
      ? event
      : {
          ...(source.message && typeof source.message === "object" && !Array.isArray(source.message)
            ? { message: source.message }
            : {}),
          ...(source.sender && typeof source.sender === "object" && !Array.isArray(source.sender)
            ? { sender: source.sender }
            : {})
        };

  return {
    schema: "2.0",
    header: {
      event_type: eventType,
      event_id: String(source.event_id ?? source.uuid ?? "").trim()
    },
    event: mergedEvent
  };
}

function normalizeCredentials(config = {}) {
  const source = normalizeObject(config);
  return {
    appId: String(source.appId ?? "").trim(),
    appSecret: String(source.appSecret ?? "").trim()
  };
}

function normalizeErrorMessage(error, fallback = "unknown error") {
  const message = String(error?.message ?? "").trim();
  return message || fallback;
}

export class FeishuLongConnectionService {
  constructor(options = {}) {
    this.configStore = options.configStore ?? null;
    this.eventIngestService = options.eventIngestService ?? null;

    this.wsClient = null;
    this.active = false;
    this.credentialsFingerprint = "";
    this.operationQueue = Promise.resolve();

    this.status = {
      active: false,
      running: false,
      lastError: "",
      lastStartedAt: 0,
      lastStoppedAt: 0,
      lastEventAt: 0,
      acceptedEvents: 0,
      acceptedMessages: 0
    };
  }

  getStatus() {
    const reconnectInfo =
      this.wsClient && typeof this.wsClient.getReconnectInfo === "function"
        ? this.wsClient.getReconnectInfo()
        : null;
    return {
      ...this.status,
      reconnectInfo:
        reconnectInfo && typeof reconnectInfo === "object"
          ? {
              lastConnectTime: Number(reconnectInfo.lastConnectTime ?? 0),
              nextConnectTime: Number(reconnectInfo.nextConnectTime ?? 0)
            }
          : {
              lastConnectTime: 0,
              nextConnectTime: 0
            }
    };
  }

  async setActive(active, options = {}) {
    const enabled = Boolean(active);
    const forceRestart = Boolean(options.forceRestart ?? options.forceRefresh);

    return this.enqueueOperation(async () => {
      this.active = enabled;
      this.status.active = enabled;

      if (!enabled) {
        this.stopClient();
        this.status.lastError = "";
        return this.getStatus();
      }

      if (this.wsClient && !forceRestart && this.credentialsFingerprint) {
        return this.getStatus();
      }

      const credentials = await this.readCredentials();
      if (!credentials.appId || !credentials.appSecret) {
        this.stopClient();
        this.status.lastError = "飞书长连接未启动：缺少 appId 或 appSecret";
        return this.getStatus();
      }

      const nextFingerprint = `${credentials.appId}:${credentials.appSecret}`;
      const shouldRestart =
        forceRestart || !this.wsClient || nextFingerprint !== this.credentialsFingerprint;
      if (!shouldRestart) {
        return this.getStatus();
      }

      this.stopClient();
      this.startClient(credentials);
      this.credentialsFingerprint = nextFingerprint;
      this.status.running = true;
      this.status.lastStartedAt = Date.now();
      this.status.lastError = "";
      return this.getStatus();
    });
  }

  enqueueOperation(task) {
    const runner = async () => {
      try {
        return await task();
      } catch (error) {
        this.status.lastError = `飞书长连接异常: ${normalizeErrorMessage(error)}`;
        return this.getStatus();
      }
    };

    this.operationQueue = this.operationQueue.then(runner, runner);
    return this.operationQueue;
  }

  async readCredentials() {
    if (!this.configStore || typeof this.configStore.read !== "function") {
      return normalizeCredentials({});
    }

    const config = await this.configStore.read();
    return normalizeCredentials(config);
  }

  startClient(credentials) {
    if (!this.eventIngestService || typeof this.eventIngestService.handleCallback !== "function") {
      throw new Error("feishu event ingest service is unavailable");
    }

    const eventDispatcher = new lark.EventDispatcher({});
    eventDispatcher.register({
      "im.message.receive_v1": async (eventPayload) => this.handleIncomingEvent(eventPayload)
    });

    const wsClient = new lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret
    });
    wsClient.start({ eventDispatcher }).catch((error) => {
      this.status.lastError = `飞书长连接启动失败: ${normalizeErrorMessage(error)}`;
    });

    this.wsClient = wsClient;
  }

  stopClient() {
    if (this.wsClient && typeof this.wsClient.close === "function") {
      try {
        this.wsClient.close({
          force: true
        });
      } catch (error) {
        this.status.lastError = `飞书长连接关闭失败: ${normalizeErrorMessage(error)}`;
      }
    }

    if (this.status.running) {
      this.status.lastStoppedAt = Date.now();
    }

    this.wsClient = null;
    this.credentialsFingerprint = "";
    this.status.running = false;
  }

  async handleIncomingEvent(eventPayload = {}) {
    this.status.lastEventAt = Date.now();

    const envelope = buildWsEventEnvelope(eventPayload);
    if (!envelope) {
      return {
        kind: "ignored",
        reason: "unsupported_event_shape"
      };
    }

    try {
      const result = await this.eventIngestService.handleCallback(envelope);
      if (String(result?.kind ?? "").trim() === "accepted") {
        this.status.acceptedEvents += 1;
        this.status.acceptedMessages += Array.isArray(result?.messageIds)
          ? result.messageIds.length
          : 0;
      }
      return {
        kind: String(result?.kind ?? "ignored").trim() || "ignored",
        reason: String(result?.reason ?? "").trim()
      };
    } catch (error) {
      this.status.lastError = `飞书事件处理失败: ${normalizeErrorMessage(error)}`;
      return {
        kind: "ignored",
        reason: "handler_failed"
      };
    }
  }
}
