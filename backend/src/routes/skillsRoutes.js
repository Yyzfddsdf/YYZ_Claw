import { Router } from "express";

import { createSkillsController } from "../controllers/skillsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createSkillsRoutes(services) {
  const router = Router();
  const controller = createSkillsController(services);

  router.post("/skills/refresh", asyncHandler(controller.refreshSkills));
  router.get("/skills", asyncHandler(controller.listSkills));
  router.get("/skills/:skillName/assets", asyncHandler(controller.getSkillAsset));
  router.get("/skills/:skillName", asyncHandler(controller.getSkillByName));
  router.get("/skills/:skillName/validate", asyncHandler(controller.validateSkillByName));

  return router;
}
