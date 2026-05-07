import { Router } from "express";

import { createWorkspaceController } from "../controllers/workspaceController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createWorkspaceRoutes(services) {
  const router = Router();
  const controller = createWorkspaceController(services);

  router.get("/workspace", asyncHandler(controller.getWorkspaceInfo));
  router.get("/workspace/tree", asyncHandler(controller.listTree));
  router.get("/workspace/search", asyncHandler(controller.searchFiles));
  router.get("/workspace/assets", asyncHandler(controller.streamAsset));
  router.get("/workspace/files", asyncHandler(controller.readFile));
  router.put("/workspace/files", asyncHandler(controller.writeFile));
  router.get("/workspace/git/state", asyncHandler(controller.getGitState));
  router.get("/workspace/git/diff", asyncHandler(controller.getGitDiff));
  router.post("/workspace/git/init", asyncHandler(controller.initGit));
  router.post("/workspace/git/stage", asyncHandler(controller.stageGitFiles));
  router.post("/workspace/git/commit", asyncHandler(controller.commitGitChanges));
  router.post("/workspace/git/push", asyncHandler(controller.pushGitChanges));
  router.post("/workspace/git/revert", asyncHandler(controller.revertGitFiles));
  router.post("/workspace/git/commit-message", asyncHandler(controller.streamGitCommitMessage));

  return router;
}
