import { Router } from "express";

import { createAutomationController } from "../controllers/automationController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createAutomationRoutes(services) {
  const router = Router();
  const controller = createAutomationController(services);

  router.get("/automation/tasks", asyncHandler(controller.listTasks));
  router.post("/automation/tasks", asyncHandler(controller.createTask));
  router.put("/automation/tasks/:taskId", asyncHandler(controller.updateTaskById));
  router.delete("/automation/tasks/:taskId", asyncHandler(controller.deleteTaskById));
  router.get("/automation/bindings", asyncHandler(controller.listBindings));
  router.post("/automation/bindings", asyncHandler(controller.upsertBinding));
  router.put("/automation/bindings/:bindingId", asyncHandler(controller.updateBindingById));
  router.delete("/automation/bindings/:bindingId", asyncHandler(controller.deleteBindingById));
  router.post("/automation/bindings/:bindingId/run", asyncHandler(controller.runBindingNowById));

  return router;
}
