import {
  getConversationId,
  getOrchestratorSupervisor,
  readOptionalText
} from "./orchestrationToolShared.js";

export default {
  name: "pool_list",
  description: "List recent public shared-message-pool entries for the current orchestration session.",
  parameters: {
    type: "object",
    properties: {
      sinceSequence: {
        type: "integer",
        description: "Only return entries with sequence greater than this value."
      },
      limit: {
        type: "integer",
        description: "Max number of entries to return."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    return {
      entries: supervisor.listPoolEntries(conversationId, {
        sinceSequence: Number(args.sinceSequence ?? 0),
        limit: Number(args.limit ?? 20)
      })
    };
  }
};
