import {
  memoryContentCreateSchema,
  memoryContentUpdateSchema,
  memoryNodeCreateSchema,
  memoryNodeRelationCreateSchema,
  memoryNodeUpdateSchema,
  memoryTopicCreateSchema,
  memoryTopicUpdateSchema
} from "../schemas/memorySchema.js";

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export function createMemoryController({ memoryStore }) {
  if (!memoryStore) {
    throw new Error("memoryStore is required");
  }

  return {
    listTopics: async (_req, res) => {
      res.json({
        topics: memoryStore.listTopics()
      });
    },

    getTopicById: async (req, res) => {
      const topicId = String(req.params.topicId ?? "").trim();
      if (!topicId) {
        throw createValidationError("topicId is required");
      }

      const topic = memoryStore.getTopicTree({
        topicId,
        includeNodes: false
      });

      if (!topic) {
        const error = createValidationError("topic not found");
        error.statusCode = 404;
        throw error;
      }

      res.json({ topic });
    },

    createTopic: async (req, res) => {
      const validation = memoryTopicCreateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const topic = memoryStore.createTopic(validation.data);
      res.status(201).json({ topic });
    },

    updateTopicById: async (req, res) => {
      const topicId = String(req.params.topicId ?? "").trim();
      if (!topicId) {
        throw createValidationError("topicId is required");
      }

      const validation = memoryTopicUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const topic = memoryStore.updateTopic({
        topicId,
        ...validation.data
      });
      res.json({ topic });
    },

    deleteTopicById: async (req, res) => {
      const topicId = String(req.params.topicId ?? "").trim();
      if (!topicId) {
        throw createValidationError("topicId is required");
      }

      const topic = memoryStore.deleteTopic(topicId);
      res.json({ topic, deleted: true });
    },

    getContentById: async (req, res) => {
      const contentId = String(req.params.contentId ?? "").trim();
      if (!contentId) {
        throw createValidationError("contentId is required");
      }

      const content = memoryStore.getContentTree(contentId);
      if (!content) {
        const error = createValidationError("content not found");
        error.statusCode = 404;
        throw error;
      }

      res.json({ content });
    },

    createContent: async (req, res) => {
      const validation = memoryContentCreateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const topic = memoryStore.getTopicById(validation.data.topicId);
      if (!topic) {
        throw createValidationError(`topic not found: ${validation.data.topicId}`);
      }

      const content = memoryStore.createContent({
        topicId: topic.id,
        name: validation.data.name,
        description: validation.data.description
      });

      res.status(201).json({
        content: memoryStore.getContentTree(content.id)
      });
    },

    updateContentById: async (req, res) => {
      const contentId = String(req.params.contentId ?? "").trim();
      if (!contentId) {
        throw createValidationError("contentId is required");
      }

      const validation = memoryContentUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const content = memoryStore.updateContent({
        contentId,
        ...validation.data
      });
      res.json({ content: memoryStore.getContentTree(content.id) });
    },

    deleteContentById: async (req, res) => {
      const contentId = String(req.params.contentId ?? "").trim();
      if (!contentId) {
        throw createValidationError("contentId is required");
      }

      const content = memoryStore.deleteContent(contentId);
      res.json({ content, deleted: true });
    },

    createNode: async (req, res) => {
      const validation = memoryNodeCreateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const content = memoryStore.getContentById(validation.data.contentId);
      if (!content) {
        throw createValidationError(`content not found: ${validation.data.contentId}`);
      }

      const node = memoryStore.createNode({
        contentId: content.id,
        name: validation.data.name,
        coreMemory: validation.data.coreMemory,
        explanation: validation.data.explanation,
        specificKeywords: validation.data.specificKeywords,
        generalKeywords: validation.data.generalKeywords
      });

      res.status(201).json({
        node
      });
    },

    updateNodeById: async (req, res) => {
      const nodeId = String(req.params.nodeId ?? "").trim();
      if (!nodeId) {
        throw createValidationError("nodeId is required");
      }

      const validation = memoryNodeUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const node = memoryStore.updateNode({
        nodeId,
        ...validation.data
      });

      res.json({ node });
    },

    deleteNodeById: async (req, res) => {
      const nodeId = String(req.params.nodeId ?? "").trim();
      if (!nodeId) {
        throw createValidationError("nodeId is required");
      }

      const node = memoryStore.deleteNode(nodeId);
      res.json({ node, deleted: true });
    },

    createNodeRelation: async (req, res) => {
      const validation = memoryNodeRelationCreateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const result = memoryStore.createNodeRelation(validation.data);
      res.status(result.action === "created" ? 201 : 200).json(result);
    }
  };
}
