import {
  getMemoryStore,
  normalizeId,
  normalizeKeywordGroupArray,
} from "./memoryToolShared.js";

export default {
  name: "memory_update_node",
  description:
    "Update one existing third-layer long-term memory node. If you move it, provide an existing contentId only; do not create new topic/content structure through this tool.",
  parameters: {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "Existing memory node id."
      },
      contentId: {
        type: "string",
        description:
          "Optional existing new parent content id. Use only after memory_find_candidates or memory_browse confirmed the target content."
      },
      name: {
        type: "string",
        description: "Updated memory node name."
      },
      coreMemory: {
        type: "string",
        description: "Updated core memory. Prefer a clear summary of the stable fact, but it may be moderately detailed when needed."
      },
      explanation: {
        type: "string",
        description: "Updated explanation for background, boundaries, nuance, or reasons. This may be longer when useful."
      },
      specificKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "Updated specific recall keywords. Prefer exact entities such as project names, APIs, module names, feature names, or error texts."
      },
      generalKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "Updated general recall keywords. Prefer categories, themes, intents, abstractions, or scenario-level labels."
      }
    },
    required: ["nodeId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const nodeId = normalizeId(args.nodeId);
    const hasAnyUpdateField =
      typeof args.name !== "undefined" ||
      typeof args.coreMemory !== "undefined" ||
      typeof args.explanation !== "undefined" ||
      typeof args.specificKeywords !== "undefined" ||
      typeof args.generalKeywords !== "undefined" ||
      Boolean(normalizeId(args.contentId));

    if (!nodeId) {
      throw new Error("updating memory node requires nodeId");
    }

    if (!hasAnyUpdateField) {
      throw new Error(
        "updating memory node requires at least one of: name, coreMemory, explanation, specificKeywords, generalKeywords, contentId"
      );
    }

    return {
      action: "updated",
      node: memoryStore.updateNode({
        nodeId,
        contentId: normalizeId(args.contentId),
        name: args.name,
        coreMemory: args.coreMemory,
        explanation: args.explanation,
        specificKeywords:
          typeof args.specificKeywords === "undefined"
            ? undefined
            : normalizeKeywordGroupArray(args.specificKeywords, "specificKeywords"),
        generalKeywords:
          typeof args.generalKeywords === "undefined"
            ? undefined
            : normalizeKeywordGroupArray(args.generalKeywords, "generalKeywords")
      })
    };
  }
};
