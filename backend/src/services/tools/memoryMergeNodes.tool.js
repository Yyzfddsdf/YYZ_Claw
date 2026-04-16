import {
  getMemoryStore,
  normalizeId,
  normalizeKeywordGroupArray,
} from "./memoryToolShared.js";

export default {
  name: "memory_merge_nodes",
  description:
    "Merge multiple long-term memory nodes into one new node, then optionally delete the source nodes. If the merged node should live elsewhere, provide an existing contentId only; do not create new topic/content structure through this tool.",
  parameters: {
    type: "object",
    properties: {
      nodeIds: {
        type: "array",
        items: {
          type: "string"
        },
        description: "At least two source node ids."
      },
      contentId: {
        type: "string",
        description:
          "Optional existing target content id. If omitted, all source nodes must already belong to the same content."
      },
      name: {
        type: "string",
        description: "Merged memory node name."
      },
      coreMemory: {
        type: "string",
        description: "Merged core memory. Prefer a clear summary of the stable fact, but it may be moderately detailed when needed."
      },
      explanation: {
        type: "string",
        description: "Merged explanation for background, boundaries, nuance, or reasons. This may be longer when useful."
      },
      specificKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "Merged specific recall keywords. Prefer exact entities such as project names, APIs, module names, feature names, or error texts."
      },
      generalKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "Merged general recall keywords. Prefer categories, themes, intents, abstractions, or scenario-level labels."
      },
      deleteSource: {
        type: "boolean",
        description: "Whether to hard-delete the source nodes after merge.",
        default: true
      }
    },
    required: ["nodeIds", "name", "coreMemory", "explanation", "specificKeywords", "generalKeywords"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);

    return {
      action: "merged",
      ...memoryStore.mergeNodes({
        nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds : [],
        contentId: normalizeId(args.contentId),
        name: args.name,
        coreMemory: args.coreMemory,
        explanation: args.explanation,
        specificKeywords: normalizeKeywordGroupArray(
          args.specificKeywords,
          "specificKeywords"
        ),
        generalKeywords: normalizeKeywordGroupArray(
          args.generalKeywords,
          "generalKeywords"
        ),
        deleteSource: typeof args.deleteSource === "boolean" ? args.deleteSource : true
      })
    };
  }
};
