import { Router } from "express";

import { createWorkspaceController } from "../controllers/workspaceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createWorkspaceRoutes() {
  const router = Router();
  const controller = createWorkspaceController();

  router.get("/workspace", asyncHandler(controller.getWorkspaceInfo));
  router.get("/workspace/tree", asyncHandler(controller.listTree));
  router.get("/workspace/files", asyncHandler(controller.readFile));
  router.put("/workspace/files", asyncHandler(controller.writeFile));

  return router;
}
