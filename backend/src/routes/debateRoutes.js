import { Router } from "express";

import { createDebateController } from "../controllers/debateController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createDebateRoutes(services) {
  const router = Router();
  const controller = createDebateController(services);

  router.get("/debates", asyncHandler(controller.listDebates));
  router.get("/debates/:debateId", asyncHandler(controller.getDebateById));
  router.post("/debates", asyncHandler(controller.createDebate));
  router.delete("/debates/:debateId", asyncHandler(controller.deleteDebateById));

  return router;
}
