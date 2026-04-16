import { getMemoryStore, normalizeId, normalizeName } from "./memoryToolShared.js";

export default {
  name: "memory_update_topic",
  description: "Update one existing topic node in long-term memory.",
  parameters: {
    type: "object",
    properties: {
      topicId: {
        type: "string",
        description: "Existing topic id."
      },
      name: {
        type: "string",
        description: "Updated topic name."
      }
    },
    required: ["topicId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const topicId = normalizeId(args.topicId);
    const name = normalizeName(args.name);

    if (!topicId) {
      throw new Error("updating topic requires topicId");
    }

    if (!name) {
      throw new Error("updating topic requires name");
    }

    return {
      action: "updated",
      topic: memoryStore.updateTopic({
        topicId,
        name
      })
    };
  }
};
