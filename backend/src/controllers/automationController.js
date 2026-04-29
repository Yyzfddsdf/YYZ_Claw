import {
  automationBindingPayloadSchema,
  automationBindingUpdateSchema,
  automationTaskPayloadSchema,
  automationTaskUpdateSchema
} from "../schemas/automationSchema.js";
import { createValidationError } from "../services/chat/conversationRuntimeShared.js";

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function mapHistorySummary(history) {
  return {
    id: history.id,
    title: history.title,
    preview: history.preview,
    updatedAt: history.updatedAt,
    messageCount: history.messageCount,
    workplacePath: history.workplacePath,
    source: history.source,
    parentConversationId: history.parentConversationId,
    agentDisplayName: history.agentDisplayName,
    agentType: history.agentType,
    agentBusy: Boolean(history.agentBusy)
  };
}

function mapBinding(binding, historyStore) {
  if (!binding) {
    return null;
  }

  const conversation = historyStore?.getConversation?.(binding.conversationId) ?? null;
  return {
    ...binding,
    conversation: conversation ? mapHistorySummary(conversation) : null
  };
}

export function createAutomationController({
  automationSchedulerService,
  historyStore
}) {
  return {
    listTasks: async (_req, res) => {
      const tasks = automationSchedulerService?.listTasks?.() ?? [];
      res.json({ tasks });
    },

    createTask: async (req, res) => {
      const validation = automationTaskPayloadSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const task = automationSchedulerService.createTask(validation.data);
      res.status(201).json({ task });
    },

    updateTaskById: async (req, res) => {
      const taskId = String(req.params.taskId ?? "").trim();
      if (!taskId) {
        throw createValidationError("taskId is required");
      }

      const validation = automationTaskUpdateSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const task = automationSchedulerService.updateTask(taskId, validation.data);
      if (!task) {
        const notFoundError = createValidationError("automation task not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ task });
    },

    deleteTaskById: async (req, res) => {
      const taskId = String(req.params.taskId ?? "").trim();
      if (!taskId) {
        throw createValidationError("taskId is required");
      }

      const deleted = automationSchedulerService.deleteTask(taskId);
      if (!deleted) {
        const notFoundError = createValidationError("automation task not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ success: true, taskId });
    },

    listBindings: async (_req, res) => {
      const bindings = automationSchedulerService?.listBindings?.() ?? [];
      res.json({
        bindings: bindings.map((binding) => mapBinding(binding, historyStore)).filter(Boolean)
      });
    },

    upsertBinding: async (req, res) => {
      const validation = automationBindingPayloadSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const conversation = historyStore.getConversation(validation.data.conversationId);
      if (!conversation) {
        const notFoundError = createValidationError("conversation not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      if (String(conversation.source ?? "").trim() === "subagent") {
        throw createValidationError("subagent conversation cannot bind automation");
      }

      const binding = automationSchedulerService.upsertBinding(validation.data);
      if (!binding) {
        const notFoundError = createValidationError("automation template not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.status(201).json({ binding: mapBinding(binding, historyStore) });
    },

    updateBindingById: async (req, res) => {
      const bindingId = String(req.params.bindingId ?? "").trim();
      if (!bindingId) {
        throw createValidationError("bindingId is required");
      }

      const validation = automationBindingUpdateSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const binding = automationSchedulerService.updateBinding(bindingId, validation.data);
      if (!binding) {
        const notFoundError = createValidationError("automation binding not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ binding: mapBinding(binding, historyStore) });
    },

    deleteBindingById: async (req, res) => {
      const bindingId = String(req.params.bindingId ?? "").trim();
      if (!bindingId) {
        throw createValidationError("bindingId is required");
      }

      const deleted = automationSchedulerService.deleteBinding(bindingId);
      if (!deleted) {
        const notFoundError = createValidationError("automation binding not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ success: true, bindingId });
    },

    runBindingNowById: async (req, res) => {
      const bindingId = String(req.params.bindingId ?? "").trim();
      if (!bindingId) {
        throw createValidationError("bindingId is required");
      }

      const binding = automationSchedulerService.runBindingNow(bindingId);
      if (!binding) {
        const notFoundError = createValidationError("automation binding not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.status(202).json({ accepted: true, binding: mapBinding(binding, historyStore) });
    }
  };
}
