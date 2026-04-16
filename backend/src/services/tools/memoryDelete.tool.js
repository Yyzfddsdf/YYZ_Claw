import { getMemoryStore, normalizeId } from "./memoryToolShared.js";

export default {
  name: "memory_delete",
  description:
    "Hard-delete a topic, content block, or memory node from long-term memory.",
  parameters: {
    type: "object",
    properties: {
      level: {
        type: "string",
        enum: ["topic", "content", "node"],
        description: "Which layer to delete."
      },
      id: {
        type: "string",
        description: "Target entity id."
      }
    },
    required: ["level", "id"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const id = normalizeId(args.id);

    if (args.level === "topic") {
      return {
        action: "deleted",
        level: "topic",
        topic: memoryStore.deleteTopic(id)
      };
    }

    if (args.level === "content") {
      return {
        action: "deleted",
        level: "content",
        content: memoryStore.deleteContent(id)
      };
    }

    return {
      action: "deleted",
      level: "node",
      node: memoryStore.deleteNode(id)
    };
  }
};
