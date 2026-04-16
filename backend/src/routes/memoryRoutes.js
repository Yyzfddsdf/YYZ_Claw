import { Router } from "express";

import { createMemoryController } from "../controllers/memoryController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createMemoryRoutes(services) {
  const router = Router();
  const controller = createMemoryController(services);

  router.get("/memory/topics", asyncHandler(controller.listTopics));
  router.get("/memory/topics/:topicId", asyncHandler(controller.getTopicById));
  router.post("/memory/topics", asyncHandler(controller.createTopic));
  router.put("/memory/topics/:topicId", asyncHandler(controller.updateTopicById));
  router.patch("/memory/topics/:topicId", asyncHandler(controller.updateTopicById));
  router.delete("/memory/topics/:topicId", asyncHandler(controller.deleteTopicById));

  router.get("/memory/contents/:contentId", asyncHandler(controller.getContentById));
  router.post("/memory/contents", asyncHandler(controller.createContent));
  router.put("/memory/contents/:contentId", asyncHandler(controller.updateContentById));
  router.patch("/memory/contents/:contentId", asyncHandler(controller.updateContentById));
  router.delete("/memory/contents/:contentId", asyncHandler(controller.deleteContentById));

  router.post("/memory/nodes", asyncHandler(controller.createNode));
  router.post("/memory/node-relations", asyncHandler(controller.createNodeRelation));
  router.put("/memory/nodes/:nodeId", asyncHandler(controller.updateNodeById));
  router.patch("/memory/nodes/:nodeId", asyncHandler(controller.updateNodeById));
  router.delete("/memory/nodes/:nodeId", asyncHandler(controller.deleteNodeById));

  return router;
}
