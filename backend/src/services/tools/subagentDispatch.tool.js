import {
  getAgentId,
  getConversationId,
  getOrchestratorSupervisor,
  readOptionalText
} from "./orchestrationToolShared.js";

export default {
  name: "subagent_dispatch",
  description:
    "Dispatch a structured task message to a specific subagent. The message is queued and injected after its current atomic run if it is busy.",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Target subagent id."
      },
      title: {
        type: "string",
        description: "Short dispatch title."
      },
      message: {
        type: "string",
        description: "Detailed task body."
      }
    },
    required: ["agentId", "message"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    const sourceAgentId = getAgentId(executionContext);

    return supervisor.dispatchToAgent({
      conversationId,
      sourceAgentId,
      targetAgentId: readOptionalText(args.agentId),
      subtype: "agent_dispatch",
      title: readOptionalText(args.title),
      detailLines: [readOptionalText(args.message)]
    });
  }
};
