import {
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

function collectDescendantConversations(historyStore, rootConversationId) {
  const rootId = String(rootConversationId ?? "").trim();
  if (!rootId) {
    return [];
  }

  const queue = [rootId];
  const visited = new Set();
  const collected = [];

  while (queue.length > 0) {
    const currentId = String(queue.shift() ?? "").trim();
    if (!currentId || visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    collected.push(currentId);

    const children = historyStore?.listChildConversations?.(currentId) ?? [];
    for (const child of children) {
      const childId = String(child?.id ?? "").trim();
      if (childId && !visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return collected;
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

    runTaskNowById: async (req, res) => {
      const taskId = String(req.params.taskId ?? "").trim();
      if (!taskId) {
        throw createValidationError("taskId is required");
      }

      const task = automationSchedulerService.runTaskNow(taskId);
      if (!task) {
        const notFoundError = createValidationError("automation task not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.status(202).json({ accepted: true, task });
    },

    listAutomationHistories: async (_req, res) => {
      const rootHistories = historyStore
        .listConversations({
          includeSources: ["automation"],
          includeChildren: false
        })
        .map((history) => mapHistorySummary(history));

      const historyMap = new Map(rootHistories.map((item) => [item.id, item]));
      for (const rootHistory of rootHistories) {
        const descendants = collectDescendantConversations(historyStore, rootHistory.id);
        for (const conversationId of descendants) {
          if (historyMap.has(conversationId)) {
            continue;
          }
          const conversation = historyStore.getConversation(conversationId);
          if (!conversation) {
            continue;
          }
          historyMap.set(conversationId, mapHistorySummary(conversation));
        }
      }

      const histories = Array.from(historyMap.values()).sort(
        (left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
      );

      res.json({ histories });
    },

    deleteAutomationHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId ?? "").trim();
      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const conversation = historyStore.getConversation(conversationId);
      if (!conversation) {
        const notFoundError = createValidationError("automation history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const rootConversationId =
        String(conversation.source ?? "").trim() === "subagent"
          ? String(conversation.parentConversationId ?? "").trim() || conversationId
          : conversationId;
      const lineage = collectDescendantConversations(historyStore, rootConversationId);
      const orderedForDelete = lineage
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .reverse();

      for (const id of orderedForDelete) {
        historyStore.deleteConversation(id);
      }

      const tasks = automationSchedulerService?.listTasks?.() ?? [];
      for (const task of tasks) {
        const taskConversationId = String(task?.conversationId ?? "").trim();
        if (taskConversationId && lineage.includes(taskConversationId)) {
          automationSchedulerService?.updateTask?.(task.id, {
            conversationId: "",
            updatedAt: Date.now()
          });
        }
      }

      res.json({
        success: true,
        deletedConversationIds: orderedForDelete,
        rootConversationId
      });
    }
  };
}
