import { getMemoryStore, normalizeId, normalizeName } from "./memoryToolShared.js";

export default {
  name: "memory_create_content",
  description:
    "Create a new second-layer content block under one existing topic only. Use this only after memory_find_candidates or memory_browse has confirmed there is no suitable existing content and you already have a valid topicId.",
  parameters: {
    type: "object",
    properties: {
      topicId: {
        type: "string",
        description:
          "Required existing parent topic id. Do not invent a new topic here; search first and reuse an existing topicId."
      },
      name: {
        type: "string",
        description: "Content block name."
      },
      description: {
        type: "string",
        description: "Optional short description or boundary for this content block."
      }
    },
    required: ["topicId", "name"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const topicId = normalizeId(args.topicId);
    const name = normalizeName(args.name);

    if (!topicId || !name) {
      throw new Error("creating content requires existing topicId and name");
    }

    const topic = memoryStore.getTopicById(topicId);
    if (!topic) {
      throw new Error(
        `topic not found: ${topicId}. Use memory_find_candidates or memory_browse first and provide an existing topicId.`
      );
    }

    return {
      action: "created",
      content: memoryStore.createContent({
        topicId: topic.id,
        name,
        description: args.description
      })
    };
  }
};
