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

  if (recommendedAction === "review_existing_node_candidates_before_create") {
    return [
      createToolResultHook({
        type: "memory_candidate_hint",
        level: "hint",
        message:
          "已发现中高相似的现有记忆节点。先认真检查 nodeCandidates，确认不能 update 或 merge 再创建新节点。"
      })
    ];
  }

  return [
      createToolResultHook({
        type: "memory_candidate_hint",
        level: "hint",
        message:
          "只有在确认现有相似记忆节点都不合适时，才应继续创建新节点。父级挂载位置请用 memory_browse 单独确认。"
      })
    ];
}

export default {
  name: "memory_find_candidates",
  description:
    "Find the best existing memory node candidates before any long-term memory write. Use this first when you are deciding whether to update, merge, or create a new memory node.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Optional proposed memory node name. Used as a fallback label only; node similarity mainly relies on memory content."
      },
      coreMemory: {
        type: "string",
        description: "Optional proposed core memory text. This is the main field for similarity search."
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
        description: "Optional max number of node candidates. Default 5, max 10."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const name = normalizeName(args.name);
    const coreMemory = normalizeName(args.coreMemory);
    const explanation = normalizeName(args.explanation);
    const specificKeywords = normalizeKeywordArray(args.specificKeywords);
    const generalKeywords = normalizeKeywordArray(args.generalKeywords);
    const hasAnySearchInput = Boolean(
      name ||
        coreMemory ||
        explanation ||
        specificKeywords.length > 0 ||
        generalKeywords.length > 0
    );

    if (!hasAnySearchInput) {
      throw new Error(
        "memory_find_candidates requires at least one of: name, coreMemory, explanation, specificKeywords, generalKeywords"
      );
    }

    const result = memoryStore.findMemoryWriteCandidates({
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
