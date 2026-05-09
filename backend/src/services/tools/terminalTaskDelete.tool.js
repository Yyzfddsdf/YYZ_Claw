import {
  getBackgroundTaskService,
  getRequiredConversationId
} from "./terminalTaskToolShared.js";

export default {
  name: "terminal_task_delete",
  description:
    "Delete one persisted background terminal task record and its local files for the current conversation.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task id returned by terminal_task_start or terminal_task_overview."
      }
    },
    required: ["taskId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const service = getBackgroundTaskService(executionContext);
    const conversationId = getRequiredConversationId(executionContext);
    return service.deleteTask(conversationId, args.taskId);
  }
};
