import { Router } from "express";

import { createConfigController } from "../controllers/configController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createConfigRoutes(services) {
  const router = Router();
  const controller = createConfigController(services);

  router.get("/config", asyncHandler(controller.getConfig));
  router.post("/config", asyncHandler(controller.saveConfig));

  return router;
}
