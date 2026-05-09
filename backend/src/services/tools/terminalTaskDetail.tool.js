import {
  getBackgroundTaskService,
  getRequiredConversationId,
  readOptionalPositiveInteger
} from "./terminalTaskToolShared.js";

export default {
  name: "terminal_task_detail",
  description:
    "Read one background terminal task in detail, including its persisted command result with middle truncation when too long.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task id returned by terminal_task_start or terminal_task_overview."
      },
      maxChars: {
        type: "integer",
        description: "Optional maximum result length to return."
      }
    },
    required: ["taskId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const service = getBackgroundTaskService(executionContext);
    const conversationId = getRequiredConversationId(executionContext);
    return service.readTaskDetail(conversationId, args.taskId, {
      resultChars: readOptionalPositiveInteger(args.maxChars)
    });
  }
};
