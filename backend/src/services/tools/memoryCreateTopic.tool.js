import { getMemoryStore, normalizeName } from "./memoryToolShared.js";

export default {
  name: "memory_create_topic",
  description:
    "Create a new topic node in long-term memory only as a last resort. Before using this, inspect existing topics with memory_find_candidates or memory_browse and create a new topic only when no suitable existing topic can hold the memory.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Topic name."
      }
    },
    required: ["name"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const name = normalizeName(args.name);

    if (!name) {
      throw new Error("creating topic requires name");
    }

    return {
      action: "created",
      topic: memoryStore.createTopic({ name })
    };
  }
};
