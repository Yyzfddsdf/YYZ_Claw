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

function buildAutomationMessageContent(task, trigger) {
  const templateName = normalizeText(task?.templateName) || "未命名任务";
  const normalizedTrigger = normalizeText(trigger) || "schedule";
  const triggerLabel = normalizedTrigger === "manual" ? "手动执行" : "定时调度";
  const content = String(task?.templatePrompt ?? "").trim();
  return `[自动化:${templateName}|${triggerLabel}]\n${content}`;
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
    return this.taskStore.createTask({
      id,
      name: normalizeText(options.name),
      prompt: String(options.prompt ?? "").trim()
    });
  }

  updateTask(taskId, patch = {}) {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) {
      return null;
    }

    return this.taskStore.updateTask(taskId, {
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      updatedAt: Date.now()
    });
  }

  deleteTask(taskId) {
    return this.taskStore.deleteTask(taskId);
  }

  listBindings() {
    return this.taskStore?.listBindings?.() ?? [];
  }

  upsertBinding(options = {}) {
    const timeOfDay = normalizeTimeOfDay(options.timeOfDay);
    const enabled = options.enabled !== false;
    return this.taskStore.upsertBinding({
      templateId: normalizeText(options.templateId),
      conversationId: normalizeText(options.conversationId),
      enabled,
      timeOfDay,
      timezone: normalizeText(options.timezone) || "Asia/Shanghai",
      nextRunAt: enabled ? computeNextDailyRunAt(timeOfDay) : 0
    });
  }

  updateBinding(bindingId, patch = {}) {
    const existing = this.taskStore.getBinding(bindingId);
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

    return this.taskStore.updateBinding(bindingId, {
      templateId: patch.templateId ?? existing.templateId,
      enabled: nextEnabled,
      timeOfDay: nextTimeOfDay,
      timezone: patch.timezone ?? existing.timezone,
      nextRunAt: shouldResetNextRun ? (nextEnabled ? computeNextDailyRunAt(nextTimeOfDay) : 0) : existing.nextRunAt,
      updatedAt: Date.now()
    });
  }

  deleteBinding(bindingId) {
    return this.taskStore.deleteBinding(bindingId);
  }

  deleteBindingByConversationId(conversationId) {
    return this.taskStore.deleteBindingByConversationId(conversationId);
  }

  runBindingNow(bindingId) {
    const binding = this.taskStore.getBinding(bindingId);
    if (!binding) {
      return null;
    }

    if (binding.status === "running") {
      const error = new Error("automation task is already running");
      error.statusCode = 409;
      throw error;
    }

    const claimed = this.taskStore.markTaskRunning(binding.id, {
      now: Date.now(),
      nextRunAt: binding.enabled ? computeNextDailyRunAt(binding.timeOfDay) : binding.nextRunAt,
      force: true
    });

    if (!claimed) {
      const error = new Error("automation task is already running");
      error.statusCode = 409;
      throw error;
    }

    void this.executeTask(binding.id, {
      trigger: "manual"
    });

    return this.taskStore.getBinding(binding.id);
  }

  async executeTask(taskId, options = {}) {
    const now = Date.now();
    const task = this.taskStore.getBinding(taskId);

    if (!task) {
      return;
    }

    let success = false;
    let errorMessage = "";
    let foregroundStatus = "idle";
    let foregroundRun = null;
    let detachConversationBroadcast = () => {};

    try {
      const conversationId = normalizeText(task?.conversationId);
      const conversation = conversationId
        ? this.historyStore?.getConversation?.(conversationId)
        : null;
      if (!conversation) {
        throw new Error("automation bound conversation not found");
      }
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
      const trigger = normalizeText(options.trigger) || "schedule";
      const message = buildUserMessage(buildAutomationMessageContent(task, trigger), {
        kind: "automation_trigger",
        automationBindingId: task.id,
        automationTemplateId: task.templateId,
        automationTemplateName: task.templateName,
        trigger,
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
