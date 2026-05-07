import { Router } from "express";

import { createSubagentsController } from "../controllers/subagentsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createSubagentsRoutes(services) {
  const router = Router();
  const controller = createSubagentsController(services);

  router.get("/subagents", asyncHandler(controller.listSubagents));
  router.post("/subagents", asyncHandler(controller.createSubagent));
  router.put("/subagents/:agentType", asyncHandler(controller.updateSubagentById));
  router.delete("/subagents/:agentType", asyncHandler(controller.deleteSubagentById));

  return router;
}
