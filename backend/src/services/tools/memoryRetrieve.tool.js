import { getMemoryStore, normalizeId } from "./memoryToolShared.js";
import { createToolResultHook, withToolResultHooks } from "./toolResultHooks.js";

function buildMemoryNodeRelationHint() {
  return createToolResultHook({
    type: "memory_relation_hint",
    level: "hint",
    message:
      "如果这个记忆节点与当前上下文中的其他记忆节点存在稳定长期关系，可以考虑记录关联；没有把握就忽略。"
  });
}

export default {
  name: "memory_retrieve",
  description:
    "Retrieve description text for one specific long-term memory node. Use topicId for topic description placeholder, contentId for content description, or memoryNodeId for one memory node's explanation only.",
  parameters: {
    type: "object",
    properties: {
      memoryNodeId: {
        type: "string",
        description: "Selected memory node id."
      },
      contentId: {
        type: "string",
        description: "Selected content id."
      },
      topicId: {
        type: "string",
        description: "Selected topic id."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const memoryNodeId = normalizeId(args.memoryNodeId);

    if (memoryNodeId) {
      const node = memoryStore.getNodeById(memoryNodeId);
      if (!node) {
        throw new Error(`memory node not found: ${memoryNodeId}`);
      }

      return withToolResultHooks({
        view: "memory_node_description",
        memoryNode: {
          memoryNodeId: node.id,
          memoryNodeName: node.name,
          contentId: node.contentId,
          contentName: node.contentName,
          topicId: node.topicId,
          topicName: node.topicName,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          explanation: node.explanation
        }
      }, [buildMemoryNodeRelationHint()]);
    }

    const contentId = normalizeId(args.contentId);
    if (contentId) {
      const content = memoryStore.getContentTree(contentId);
      if (!content) {
        throw new Error(`content node not found: ${contentId}`);
      }

      return {
        view: "content_description",
        content: {
          contentId: content.id,
          contentName: content.name,
          topicId: content.topicId,
          topicName: content.topicName,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
          contentDescription: content.description
        }
      };
    }

    const topicId = normalizeId(args.topicId);
    if (topicId) {
      const topic = memoryStore.getTopicById(topicId);
      if (!topic) {
        throw new Error(`topic node not found: ${topicId}`);
      }

      return {
        view: "topic_description",
        topic: {
          topicId: topic.id,
          topicName: topic.name,
          createdAt: topic.createdAt,
          updatedAt: topic.updatedAt,
          topicDescription: null
        }
      };
    }

    throw new Error("topicId, contentId, or memoryNodeId is required");
  }
};
