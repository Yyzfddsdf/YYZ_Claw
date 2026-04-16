import {
  getMemoryStore,
  normalizeKeywordArray,
  normalizeName
} from "./memoryToolShared.js";
import { createToolResultHook, withToolResultHooks } from "./toolResultHooks.js";

function normalizeLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 5;
  }

  return Math.min(10, Math.max(1, Math.trunc(numeric)));
}

function buildCandidateHooks(result) {
  const recommendedAction = String(result?.recommendedAction ?? "").trim();

  if (recommendedAction === "update_or_merge_existing_node") {
    return [
      createToolResultHook({
        type: "memory_candidate_warning",
        level: "warning",
        message:
          "已发现高度相近的现有记忆节点。优先更新或合并现有节点，不要再新建 topic、content 或 node。"
      })
    ];
  }

  if (recommendedAction === "create_node_in_existing_content") {
    return [
      createToolResultHook({
        type: "memory_candidate_hint",
        level: "hint",
        message:
          "已发现适合复用的现有 content。优先在现有 contentId 下创建 node，不要新建 topic。"
      })
    ];
  }

  if (recommendedAction === "create_content_in_existing_topic") {
    return [
      createToolResultHook({
        type: "memory_candidate_hint",
        level: "hint",
        message:
          "已发现适合复用的现有 topic。优先在现有 topicId 下创建 content，不要直接新建 topic。"
      })
    ];
  }

  return [
    createToolResultHook({
      type: "memory_candidate_hint",
      level: "hint",
      message:
        "只有在确认现有 topic、content、node 都不合适时，才应继续创建新结构。"
    })
  ];
}

export default {
  name: "memory_find_candidates",
  description:
    "Find the best existing topic/content/node candidates before any long-term memory write. Use this first when you are deciding whether to update, merge, or create memory.",
  parameters: {
    type: "object",
    properties: {
      topicName: {
        type: "string",
        description: "Optional proposed topic name to compare against existing topics."
      },
      contentName: {
        type: "string",
        description: "Optional proposed content name to compare against existing contents."
      },
      name: {
        type: "string",
        description: "Optional proposed memory node name."
      },
      coreMemory: {
        type: "string",
        description: "Optional proposed core memory text."
      },
      explanation: {
        type: "string",
        description: "Optional proposed explanation text."
      },
      specificKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Optional proposed specific recall keywords."
      },
      generalKeywords: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Optional proposed general recall keywords."
      },
      limit: {
        type: "integer",
        description: "Optional max number of candidates per layer. Default 5, max 10."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const topicName = normalizeName(args.topicName);
    const contentName = normalizeName(args.contentName);
    const name = normalizeName(args.name);
    const coreMemory = normalizeName(args.coreMemory);
    const explanation = normalizeName(args.explanation);
    const specificKeywords = normalizeKeywordArray(args.specificKeywords);
    const generalKeywords = normalizeKeywordArray(args.generalKeywords);
    const hasAnySearchInput = Boolean(
      topicName ||
        contentName ||
        name ||
        coreMemory ||
        explanation ||
        specificKeywords.length > 0 ||
        generalKeywords.length > 0
    );

    if (!hasAnySearchInput) {
      throw new Error(
        "memory_find_candidates requires at least one of: topicName, contentName, name, coreMemory, explanation, specificKeywords, generalKeywords"
      );
    }

    const result = memoryStore.findMemoryWriteCandidates({
      topicName,
      contentName,
      name,
      coreMemory,
      explanation,
      specificKeywords,
      generalKeywords,
      limit: normalizeLimit(args.limit)
    });

    return withToolResultHooks(result, buildCandidateHooks(result));
  }
};
