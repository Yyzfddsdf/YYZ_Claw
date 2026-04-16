import { getMemoryStore, normalizeId } from "./memoryToolShared.js";

export default {
  name: "memory_update_content",
  description:
    "Update one existing second-layer content block in long-term memory. If you move it, provide an existing topicId only; do not create new topics through this tool.",
  parameters: {
    type: "object",
    properties: {
      contentId: {
        type: "string",
        description: "Existing content id."
      },
      topicId: {
        type: "string",
        description:
          "Optional existing new parent topic id. Use only after memory_find_candidates or memory_browse confirmed the target topic."
      },
      name: {
        type: "string",
        description: "Updated content block name."
      },
      description: {
        type: "string",
        description: "Updated content description."
      }
    },
    required: ["contentId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const contentId = normalizeId(args.contentId);
    const hasAnyUpdateField =
      typeof args.name !== "undefined" ||
      typeof args.description !== "undefined" ||
      Boolean(normalizeId(args.topicId));

    if (!contentId) {
      throw new Error("updating content requires contentId");
    }

    if (!hasAnyUpdateField) {
      throw new Error(
        "updating content requires at least one of: name, description, topicId"
      );
    }

    return {
      action: "updated",
      content: memoryStore.updateContent({
        contentId,
        topicId: normalizeId(args.topicId),
        name: args.name,
        description: args.description
      })
    };
  }
};
