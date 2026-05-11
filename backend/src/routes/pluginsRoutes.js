import { Router } from "express";

import { createPluginsController } from "../controllers/pluginsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createPluginsRoutes(services) {
  const router = Router();
  const controller = createPluginsController(services);

  router.get("/plugins", asyncHandler(controller.listPlugins));
  router.get("/plugins/:pluginName/assets", asyncHandler(controller.getPluginAsset));
  router.post("/plugins/refresh", asyncHandler(controller.refreshPlugins));

  return router;
}
