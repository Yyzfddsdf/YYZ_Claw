import {
  getConversationId,
  getOrchestratorSupervisor,
  readOptionalText
} from "./orchestrationToolShared.js";

export default {
  name: "subagent_create",
  description:
    "Create a subagent under the current main conversation. Use subagent_types_list first if you need to know which agentType values are currently available. You may optionally give the new subagent an initial task so it can start working immediately.",
  parameters: {
    type: "object",
    properties: {
      agentType: {
        type: "string",
        description:
          "Subagent type. Must be one of the agentType values returned by subagent_types_list."
      },
      displayName: {
        type: "string",
        description: "Optional display name override."
      },
      initialTask: {
        type: "string",
        description: "Optional first task to dispatch right after creation."
      }
    },
    required: ["agentType"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);

    return supervisor.createSubagent({
      conversationId,
      agentType: readOptionalText(args.agentType),
      displayName: readOptionalText(args.displayName),
      initialTask: readOptionalText(args.initialTask)
    });
  }
};
