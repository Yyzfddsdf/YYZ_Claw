import { Router } from "express";

import { createTtsController } from "../controllers/ttsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createTtsRoutes(services) {
  const router = Router();
  const controller = createTtsController(services);

  router.get("/tts/stream", asyncHandler(controller.stream));

  return router;
}

