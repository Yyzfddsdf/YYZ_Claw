import { randomUUID } from "node:crypto";
import { isAbortError } from "../runs/runAbort.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeTimeOfDay(value) {
  const normalized = normalizeText(value);
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return "09:00";
  }
  return normalized;
}

function buildUserMessage(content, meta = {}) {
  const now = Date.now();
  return {
    id: `msg_${randomUUID()}`,
    role: "user",
    content: String(content ?? ""),
    timestamp: now,
    meta: {
      ...meta
    }
  };
}

export function computeNextDailyRunAt(timeOfDay, now = Date.now()) {
  const normalized = normalizeTimeOfDay(timeOfDay);
  const [hourText, minuteText] = normalized.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  const current = new Date(Number(now));
  const target = new Date(Number(now));
  target.setHours(hour, minute, 0, 0);

  if (target.getTime() <= current.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}

export class AutomationSchedulerService {
  constructor(options = {}) {
    this.taskStore = options.taskStore ?? null;
    this.historyStore = options.historyStore ?? null;
    this.runtimeService = options.runtimeService ?? null;
    this.wakeDispatcher = options.wakeDispatcher ?? null;
    this.conversationRunCoordinator = options.conversationRunCoordinator ?? null;
    this.orchestratorSupervisorService = options.orchestratorSupervisorService ?? null;
    this.defaultWorkplacePath = normalizeText(options.defaultWorkplacePath);
    this.tickIntervalMs = Number.isFinite(options.tickIntervalMs)
      ? Math.max(5000, Math.trunc(options.tickIntervalMs))
      : 15000;
    this.maxDueTasksPerTick = Number.isFinite(options.maxDueTasksPerTick)
      ? Math.max(1, Math.trunc(options.maxDueTasksPerTick))
      : 10;

    this.timerId = null;
    this.ticking = false;
  }

  start() {
    if (this.timerId) {
      return;
    }

    this.timerId = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    void this.tick();
  }

  stop() {
    if (!this.timerId) {
      return;
    }

    clearInterval(this.timerId);
    this.timerId = null;
  }

  async tick() {
    if (this.ticking || !this.taskStore) {
      return;
    }

    this.ticking = true;
    try {
      const now = Date.now();
      const dueTasks = this.taskStore.listDueTasks(now, this.maxDueTasksPerTick);

      for (const task of dueTasks) {
        const nextRunAt = computeNextDailyRunAt(task.timeOfDay, now + 1000);
        const claimed = this.taskStore.markTaskRunning(task.id, {
          now,
          nextRunAt
        });

        if (!claimed) {
          continue;
        }

        void this.executeTask(task.id, {
          trigger: "schedule"
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  listTasks() {
    return this.taskStore?.listTasks?.() ?? [];
  }

  getTask(taskId) {
    return this.taskStore?.getTask?.(taskId) ?? null;
  }

  createTask(options = {}) {
    const id = normalizeText(options.id) || `auto_${randomUUID()}`;
    const enabled = options.enabled !== false;
    const timeOfDay = normalizeTimeOfDay(options.timeOfDay);
    const nextRunAt = enabled ? computeNextDailyRunAt(timeOfDay) : 0;

    return this.taskStore.createTask({
      id,
      name: normalizeText(options.name),
      prompt: String(options.prompt ?? "").trim(),
      conversationId: normalizeText(options.conversationId),
      workplacePath: normalizeText(options.workplacePath),
      enabled,
      timeOfDay,
      timezone: normalizeText(options.timezone) || "Asia/Shanghai",
      nextRunAt
    });
  }

  updateTask(taskId, patch = {}) {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) {
      return null;
    }

    const nextEnabled = Object.prototype.hasOwnProperty.call(patch, "enabled")
      ? Boolean(patch.enabled)
      : existing.enabled;
    const nextTimeOfDay = Object.prototype.hasOwnProperty.call(patch, "timeOfDay")
      ? normalizeTimeOfDay(patch.timeOfDay)
      : existing.timeOfDay;
    const shouldResetNextRun =
      Object.prototype.hasOwnProperty.call(patch, "enabled")
      || Object.prototype.hasOwnProperty.call(patch, "timeOfDay");

    return this.taskStore.updateTask(taskId, {
      ...patch,
      enabled: nextEnabled,
      timeOfDay: nextTimeOfDay,
      status: nextEnabled ? "idle" : "disabled",
      runningSince: 0,
      nextRunAt: shouldResetNextRun ? (nextEnabled ? computeNextDailyRunAt(nextTimeOfDay) : 0) : existing.nextRunAt,
      updatedAt: Date.now()
    });
  }

  deleteTask(taskId) {
    return this.taskStore.deleteTask(taskId);
  }

  runTaskNow(taskId) {
    const task = this.taskStore.getTask(taskId);
    if (!task) {
      return null;
    }

    if (task.status === "running") {
      const error = new Error("automation task is already running");
      error.statusCode = 409;
      throw error;
    }

    const claimed = this.taskStore.markTaskRunning(task.id, {
      now: Date.now(),
      nextRunAt: task.enabled ? computeNextDailyRunAt(task.timeOfDay) : task.nextRunAt
    });

    if (!claimed) {
      const error = new Error("automation task is already running");
      error.statusCode = 409;
      throw error;
    }

    void this.executeTask(task.id, {
      trigger: "manual"
    });

    return this.taskStore.getTask(task.id);
  }

  ensureConversationForTask(task) {
    const currentConversationId = normalizeText(task?.conversationId);
    const existingConversation = currentConversationId
      ? this.historyStore?.getConversation?.(currentConversationId)
      : null;

    if (existingConversation) {
      return existingConversation;
    }

    const conversationId = currentConversationId || `conv_auto_${randomUUID()}`;
    const now = Date.now();

    const conversation = this.historyStore.upsertConversation({
      conversationId,
      title: `[自动化] ${normalizeText(task?.name) || "未命名任务"}`,
      workplacePath:
        normalizeText(task?.workplacePath) ||
        normalizeText(existingConversation?.workplacePath) ||
        this.defaultWorkplacePath ||
        process.cwd(),
      source: "automation",
      approvalMode: "auto",
      messages: []
    });

    if (!conversation) {
      throw new Error("failed to create automation conversation");
    }

    if (conversationId !== currentConversationId) {
      this.taskStore.updateTask(task.id, {
        conversationId,
        updatedAt: now
      });
    }

    return conversation;
  }

  async executeTask(taskId, options = {}) {
    const now = Date.now();
    const task = this.taskStore.getTask(taskId);

    if (!task) {
      return;
    }

    let success = false;
    let errorMessage = "";
    let foregroundStatus = "idle";
    let foregroundRun = null;
    let detachConversationBroadcast = () => {};

    try {
      const conversation = this.ensureConversationForTask(task);
      this.orchestratorSupervisorService?.ensureSession?.(conversation.id);
      const resolvedRuntime = await this.runtimeService.resolveConversationRuntime(conversation.id);
      foregroundRun = this.wakeDispatcher?.beginForegroundRun?.({
        sessionId: resolvedRuntime?.sessionId,
        agentId: resolvedRuntime?.agentId,
        conversationId: conversation.id
      }) ?? null;
      if (foregroundRun?.busy) {
        throw new Error("conversation agent is already running");
      }
      detachConversationBroadcast =
        this.conversationRunCoordinator?.attachConversationBroadcast?.(foregroundRun, {
          listenerId: `automation_broadcast_${String(task.id ?? "").trim()}_${Date.now()}`
        }) ?? (() => {});
      const message = buildUserMessage(task.prompt, {
        kind: "automation_trigger",
        automationTaskId: task.id,
        automationTaskName: task.name,
        trigger: normalizeText(options.trigger) || "schedule",
        scheduledAt: now
      });

      this.historyStore.appendMessages(conversation.id, [message], {
        updatedAt: now
      });
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "conversation_messages_appended",
        messages: [message]
      });
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "session_start",
        mode: "background",
        source: "automation"
      });

      const runResult = await this.runtimeService.runConversationById({
        conversationId: conversation.id,
        runId: foregroundRun?.runId,
        currentAtomicStepId: foregroundRun?.stepId,
        abortSignal: foregroundRun?.signal ?? null,
        onEvent: (payload) => {
          this.conversationRunCoordinator?.emitEvent?.(foregroundRun, payload);
        }
      });

      if (String(runResult?.status ?? "").trim() === "pending_approval") {
        foregroundStatus = "waiting_approval";
        this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
          type: "session_pause",
          mode: "background",
          source: "automation",
          pendingApprovalId: runResult?.approvalId,
          toolCallId: runResult?.toolCallId,
          toolName: runResult?.toolName,
          history: runResult?.history ?? null
        });
      } else {
        foregroundStatus = "idle";
        this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
          type: "session_end",
          mode: "background",
          source: "automation",
          history: runResult?.history ?? null
        });
      }

      if (runResult?.subagentCompletionRequest) {
        await this.orchestratorSupervisorService?.dispatchCompletionToPrimary?.(
          runResult.subagentCompletionRequest
        );
      }
      success = true;
    } catch (error) {
      const aborted = isAbortError(error);
      foregroundStatus = aborted ? "idle" : "error";
      success = false;
      errorMessage = String(error?.message ?? "automation run failed").trim();
      if (!aborted) {
        this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
          type: "error",
          mode: "background",
          source: "automation",
          message: errorMessage
        });
      }
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "session_end",
        mode: "background",
        source: "automation",
        status: aborted ? "aborted" : "error"
      });
    } finally {
      detachConversationBroadcast?.();
      if (foregroundRun) {
        await this.wakeDispatcher?.finishForegroundRun?.({
          sessionId: foregroundRun.sessionId,
          agentId: foregroundRun.agentId,
          status: foregroundStatus
        });
      }
      this.taskStore.finishTaskRun(taskId, {
        success,
        errorMessage,
        now: Date.now()
      });
    }
  }
}
