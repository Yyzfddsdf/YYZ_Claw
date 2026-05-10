import { Router } from "express";

import { createHookSettingsController } from "../controllers/hookSettingsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createHookSettingsRoutes(services) {
  const router = Router();
  const controller = createHookSettingsController(services);

  router.get("/hook-settings", asyncHandler(controller.getHookSettings));
  router.post("/hook-settings", asyncHandler(controller.saveHookSettings));

  return router;
}
