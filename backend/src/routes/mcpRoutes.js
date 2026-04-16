import { Router } from "express";

import { createMcpConfigController } from "../controllers/mcpConfigController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createMcpRoutes(services) {
  const router = Router();
  const controller = createMcpConfigController(services);

  router.get("/mcp-config", asyncHandler(controller.getMcpConfig));
  router.post("/mcp-config", asyncHandler(controller.saveMcpConfig));

  return router;
}
