import {
  getBackgroundTaskService,
  getContextWorkingDirectory,
  getRequesterName,
  getRequiredConversationId
} from "./terminalTaskToolShared.js";

export default {
  name: "terminal_task_start",
  description:
    "Start a background terminal command for the current conversation. Output is persisted to local files under .yyz/tasks and the call returns immediately.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Terminal command to run in the background."
      },
      cwd: {
        type: "string",
        description: "Optional working directory override. Defaults to current conversation working directory."
      }
    },
    required: ["command"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const service = getBackgroundTaskService(executionContext);
    const conversationId = getRequiredConversationId(executionContext);

    return service.startTerminalTask({
      conversationId,
      command: args.command,
      cwd: getContextWorkingDirectory(executionContext, args.cwd),
      requestedBy: getRequesterName(executionContext)
    });
  }
};
