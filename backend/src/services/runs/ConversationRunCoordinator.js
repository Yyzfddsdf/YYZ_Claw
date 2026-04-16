import { randomUUID } from "node:crypto";

import { writeSseEvent } from "../stream/SseChannel.js";
import { createAbortError } from "./runAbort.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function buildRunPayload(run, payload = {}) {
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : { type: "message", value: payload };

  if (!normalizedPayload.runId) {
    normalizedPayload.runId = run.runId;
  }

  if (!normalizedPayload.conversationId && run.conversationId) {
    normalizedPayload.conversationId = run.conversationId;
  }

  if (!normalizedPayload.sessionId && run.sessionId) {
    normalizedPayload.sessionId = run.sessionId;
  }

  if (!normalizedPayload.agentId && run.agentId) {
    normalizedPayload.agentId = run.agentId;
  }

  if (!normalizedPayload.mode) {
    normalizedPayload.mode = run.mode;
  }

  return normalizedPayload;
}

export class ConversationRunCoordinator {
  constructor(options = {}) {
    this.conversationEventBroadcaster = options.conversationEventBroadcaster ?? null;
    this.runsById = new Map();
    this.runIdsByAgentKey = new Map();
    this.runIdsByConversationId = new Map();
    this.sequence = 0;
  }

  getRunKey(sessionId, agentId) {
    return `${normalizeText(sessionId)}::${normalizeText(agentId)}`;
  }

  createRunId() {
    return `run_${Date.now()}_${this.sequence += 1}_${randomUUID().slice(0, 8)}`;
  }

  getRunById(runId) {
    const normalizedRunId = normalizeText(runId);
    return normalizedRunId ? this.runsById.get(normalizedRunId) ?? null : null;
  }

  getRunByAgent(sessionId, agentId) {
    const runId = this.runIdsByAgentKey.get(this.getRunKey(sessionId, agentId));
    return runId ? this.getRunById(runId) : null;
  }

  getRunByConversationId(conversationId) {
    const normalizedConversationId = normalizeText(conversationId);
    const runId = normalizedConversationId
      ? this.runIdsByConversationId.get(normalizedConversationId)
      : "";
    return runId ? this.getRunById(runId) : null;
  }

  beginRun(options = {}) {
    const sessionId = normalizeText(options.sessionId);
    const agentId = normalizeText(options.agentId);
    const conversationId = normalizeText(options.conversationId);

    if (!sessionId || !agentId) {
      return null;
    }

    const existingRun = this.getRunByAgent(sessionId, agentId);
    if (existingRun) {
      return existingRun;
    }

    const abortController =
      options.abortController instanceof AbortController
        ? options.abortController
        : new AbortController();
    const runId = normalizeText(options.runId) || this.createRunId();
    const run = {
      runId,
      sessionId,
      agentId,
      conversationId,
      stepId: normalizeText(options.stepId),
      mode: normalizeText(options.mode) || "foreground",
      restored: Boolean(options.restored),
      status: normalizeText(options.status) || "running",
      createdAt: Date.now(),
      lastEventAt: 0,
      listeners: new Map(),
      abortController,
      signal: abortController.signal
    };

    this.runsById.set(runId, run);
    this.runIdsByAgentKey.set(this.getRunKey(sessionId, agentId), runId);
    if (conversationId) {
      this.runIdsByConversationId.set(conversationId, runId);
    }

    return run;
  }

  attachListener(target, listener, options = {}) {
    const run = this.resolveRun(target);
    if (!run || typeof listener !== "function") {
      return () => {};
    }

    const listenerId =
      normalizeText(options.listenerId) ||
      `listener_${Date.now()}_${this.sequence += 1}`;
    run.listeners.set(listenerId, listener);

    return () => {
      run.listeners.delete(listenerId);
    };
  }

  attachSseResponse(target, res, options = {}) {
    return this.attachListener(
      target,
      (payload) => {
        if (!res?.writableEnded) {
          writeSseEvent(res, normalizeText(options.eventName) || "agent", payload);
        }
      },
      options
    );
  }

  attachConversationBroadcast(target, options = {}) {
    const run = this.resolveRun(target);
    if (!run || !run.conversationId) {
      return () => {};
    }

    return this.attachListener(
      run,
      (payload) => {
        this.conversationEventBroadcaster?.publishAgentEvent?.(
          run.conversationId,
          payload
        );
      },
      {
        listenerId: normalizeText(options.listenerId) || "conversation_broadcast"
      }
    );
  }

  emitEvent(target, payload = {}) {
    const run = this.resolveRun(target);
    if (!run) {
      return false;
    }

    const nextPayload = buildRunPayload(run, payload);
    run.lastEventAt = Date.now();

    for (const listener of run.listeners.values()) {
      listener(nextPayload, run);
    }

    return true;
  }

  abortRun(target, reason = "") {
    const run = this.resolveRun(target);
    if (!run || run.signal?.aborted) {
      return false;
    }

    run.status = "aborting";
    run.abortController.abort(createAbortError(reason));
    return true;
  }

  finishRun(target, options = {}) {
    const run = this.resolveRun(target);
    if (!run) {
      return null;
    }

    run.status = normalizeText(options.status) || run.status || "completed";
    run.lastEventAt = Date.now();

    this.runsById.delete(run.runId);

    const runKey = this.getRunKey(run.sessionId, run.agentId);
    if (this.runIdsByAgentKey.get(runKey) === run.runId) {
      this.runIdsByAgentKey.delete(runKey);
    }

    if (
      run.conversationId &&
      this.runIdsByConversationId.get(run.conversationId) === run.runId
    ) {
      this.runIdsByConversationId.delete(run.conversationId);
    }

    run.listeners.clear();
    return run;
  }

  resolveRun(target) {
    if (!target) {
      return null;
    }

    if (typeof target === "string") {
      return this.getRunById(target);
    }

    if (typeof target === "object" && !Array.isArray(target)) {
      if (normalizeText(target.runId)) {
        return this.getRunById(target.runId) ?? target;
      }

      const sessionId = normalizeText(target.sessionId);
      const agentId = normalizeText(target.agentId);
      if (sessionId && agentId) {
        return this.getRunByAgent(sessionId, agentId);
      }
    }

    return null;
  }
}
