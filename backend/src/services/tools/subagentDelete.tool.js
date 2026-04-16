import {
  getConversationId,
  getOrchestratorSupervisor,
  readOptionalText
} from "./orchestrationToolShared.js";

export default {
  name: "subagent_delete",
  description:
    "Delete a subagent and its conversation history. Pool entries previously written by that subagent are kept.",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Target subagent id."
      }
    },
    required: ["agentId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    const deleted = supervisor.deleteSubagent({
      conversationId,
      agentId: readOptionalText(args.agentId)
    });

    return {
      deleted
    };
  }
};
