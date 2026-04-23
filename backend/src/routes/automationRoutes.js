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
  router.post("/automation/tasks/:taskId/run", asyncHandler(controller.runTaskNowById));
  router.get("/automation/histories", asyncHandler(controller.listAutomationHistories));
  router.delete(
    "/automation/histories/:conversationId",
    asyncHandler(controller.deleteAutomationHistoryById)
  );

  return router;
}
