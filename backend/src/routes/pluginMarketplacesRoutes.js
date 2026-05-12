import { Router } from "express";

import { createPluginMarketplacesController } from "../controllers/pluginMarketplacesController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createPluginMarketplacesRoutes(services) {
  const router = Router();
  const controller = createPluginMarketplacesController(services);

  router.get("/plugin-marketplaces", asyncHandler(controller.listMarketplaces));
  router.post("/plugin-marketplaces", asyncHandler(controller.addMarketplace));
  router.delete("/plugin-marketplaces/:marketplaceId", asyncHandler(controller.removeMarketplace));
  router.get("/plugin-marketplaces/plugins", asyncHandler(controller.listMarketplacePlugins));
  router.post("/plugin-marketplaces/plugins/install", asyncHandler(controller.installMarketplacePlugin));

  return router;
}
