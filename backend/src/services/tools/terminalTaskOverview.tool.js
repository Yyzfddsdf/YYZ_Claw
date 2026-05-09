import {
  getBackgroundTaskService,
  getRequiredConversationId,
  readOptionalPositiveInteger
} from "./terminalTaskToolShared.js";

export default {
  name: "terminal_task_overview",
  description:
    "List recent background terminal tasks for the current conversation with compact status and result previews.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Optional maximum number of tasks to return."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const service = getBackgroundTaskService(executionContext);
    const conversationId = getRequiredConversationId(executionContext);
    return service.listConversationTasks(conversationId, {
      limit: readOptionalPositiveInteger(args.limit)
    });
  }
};
