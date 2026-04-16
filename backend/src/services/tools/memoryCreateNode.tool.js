import {
  getMemoryStore,
  normalizeId,
  normalizeKeywordGroupArray,
  normalizeName
} from "./memoryToolShared.js";

export default {
  name: "memory_create_node",
  description:
    "Create a new third-layer long-term memory node under one existing content block only. Use this only after memory_find_candidates or memory_browse has confirmed there is no suitable existing node and you already have a valid contentId.",
  parameters: {
    type: "object",
    properties: {
      contentId: {
        type: "string",
        description:
          "Required existing parent content id. Do not invent a new content block here; search first and reuse an existing contentId."
      },
      name: {
        type: "string",
        description: "Memory node name."
      },
      coreMemory: {
        type: "string",
        description: "Core memory. Prefer a clear summary of the stable fact, but it may be moderately detailed when needed."
      },
      explanation: {
        type: "string",
        description: "Explanation for background, boundaries, nuance, or reasons. This may be longer when useful."
      },
      specificKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "Specific recall keywords. Include exact project names, module names, product names, error texts, API names, or other precise expressions."
      },
      generalKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description:
          "General recall keywords. Include categories, themes, intents, abstractions, or scenario-level labels that broaden recall coverage."
      }
    },
    required: [
      "contentId",
      "name",
      "coreMemory",
      "explanation",
      "specificKeywords",
      "generalKeywords"
    ],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const contentId = normalizeId(args.contentId);
    const name = normalizeName(args.name);
    const coreMemory = normalizeName(args.coreMemory);
    const explanation = normalizeName(args.explanation);
    const specificKeywords = normalizeKeywordGroupArray(
      args.specificKeywords,
      "specificKeywords"
    );
    const generalKeywords = normalizeKeywordGroupArray(
      args.generalKeywords,
      "generalKeywords"
    );

    if (!contentId || !name || !coreMemory || !explanation) {
      throw new Error(
        "creating memory node requires existing contentId, name, coreMemory, explanation, specificKeywords, and generalKeywords"
      );
    }

    const existingContent = memoryStore.getContentById(contentId);
    if (!existingContent) {
      throw new Error(
        `content not found: ${contentId}. Use memory_find_candidates or memory_browse first and provide an existing contentId.`
      );
    }

    return {
      action: "created",
      node: memoryStore.createNode({
        contentId: existingContent.id,
        name,
        coreMemory,
        explanation,
        specificKeywords,
        generalKeywords
      })
    };
  }
};
