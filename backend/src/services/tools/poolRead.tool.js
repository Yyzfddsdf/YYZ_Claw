import {
  getConversationId,
  getOrchestratorSupervisor,
  readOptionalText
} from "./orchestrationToolShared.js";

export default {
  name: "pool_read",
  description: "Read one public shared-message-pool entry in full detail.",
  parameters: {
    type: "object",
    properties: {
      poolEntryId: {
        type: "string",
        description: "Pool entry id to read."
      }
    },
    required: ["poolEntryId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    const entry = supervisor.readPoolEntry(conversationId, readOptionalText(args.poolEntryId));
    if (!entry) {
      throw new Error("pool entry not found");
    }
    return {
      entry
    };
  }
};
