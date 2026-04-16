import {
  getConversationId,
  getOrchestratorSupervisor
} from "./orchestrationToolShared.js";

export default {
  name: "subagent_list",
  description: "List which subagents currently exist under the current conversation.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(_args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    return {
      subagents: supervisor.listSubagents(conversationId)
    };
  }
};
