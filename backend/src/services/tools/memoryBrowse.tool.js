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
  name: "memory_browse",
  description:
    "Browse long-term memory in memory.sqlite by hierarchy. Use without args to list topic nodes. Use topicId to list content nodes. Use contentId to list memory nodes. Use memoryNodeId to inspect the final memory node detail.",
  parameters: {
    type: "object",
    properties: {
      topicId: {
        type: "string",
        description: "Optional topic id."
      },
      contentId: {
        type: "string",
        description: "Optional content id."
      },
      memoryNodeId: {
        type: "string",
        description: "Optional memory node id."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const memoryNodeId = normalizeId(args.memoryNodeId);

    if (memoryNodeId) {
      const nodeTree = memoryStore.getNodeContextTree(memoryNodeId);
      if (!nodeTree?.node) {
        throw new Error(`memory node not found: ${memoryNodeId}`);
      }
      const relatedMemoryNodes = memoryStore.listNodeRelations(memoryNodeId);

      return withToolResultHooks({
        view: "memory_node",
        memoryNode: {
          memoryNodeId: nodeTree.node.id,
          memoryNodeName: nodeTree.node.name,
          contentId: nodeTree.node.contentId,
          contentName: nodeTree.node.contentName,
          topicId: nodeTree.node.topicId,
          topicName: nodeTree.node.topicName,
          createdAt: nodeTree.node.createdAt,
          updatedAt: nodeTree.node.updatedAt,
          coreMemory: nodeTree.node.coreMemory,
          explanation: nodeTree.node.explanation,
          specificKeywords: nodeTree.node.specificKeywords,
          generalKeywords: nodeTree.node.generalKeywords
        },
        relatedMemoryNodes
      }, [buildMemoryNodeRelationHint()]);
    }

    const contentId = normalizeId(args.contentId);

    if (contentId) {
      const contentTree = memoryStore.getContentTree(contentId);
      if (!contentTree) {
        throw new Error(`content node not found: ${contentId}`);
      }

      return {
        view: "content",
        content: {
          contentId: contentTree.id,
          contentName: contentTree.name,
          topicId: contentTree.topicId,
          topicName: contentTree.topicName,
          createdAt: contentTree.createdAt,
          updatedAt: contentTree.updatedAt
        },
        memoryNodes: (contentTree.nodes ?? []).map((node) => ({
          memoryNodeId: node.id,
          memoryNodeName: node.name,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt
        }))
      };
    }

    const topicId = normalizeId(args.topicId);

    if (topicId) {
      const topic = memoryStore.getTopicById(topicId);
      if (!topic) {
        throw new Error(`topic node not found: ${topicId}`);
      }

      const topicTree = memoryStore.getTopicTree({
        topicId: topic.id,
        includeNodes: false
      });

      return {
        view: "topic",
        topic: {
          topicId: topic.id,
          topicName: topic.name,
          createdAt: topic.createdAt,
          updatedAt: topic.updatedAt
        },
        contents: (topicTree?.contents ?? []).map((content) => ({
          contentId: content.id,
          contentName: content.name,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt
        }))
      };
    }

    return {
      view: "topics",
      topics: memoryStore.listTopics().map((topic) => ({
        topicId: topic.id,
        topicName: topic.name,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt
      }))
    };
  }
};
