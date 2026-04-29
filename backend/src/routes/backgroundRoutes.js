import { Router } from "express";
import multer from "multer";

import { createBackgroundsController } from "../controllers/backgroundsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createBackgroundRoutes(services) {
  const router = Router();
  const controller = createBackgroundsController(services);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1
    }
  });

  router.get("/backgrounds", asyncHandler(controller.listBackgrounds));
  router.post("/backgrounds/settings", asyncHandler(controller.saveSettings));
  router.post(
    "/backgrounds/upload",
    upload.single("background"),
    asyncHandler(controller.uploadBackground)
  );
  router.delete("/backgrounds/:fileName", asyncHandler(controller.deleteBackgroundByName));
  router.get("/backgrounds/assets/:fileName", asyncHandler(controller.getBackgroundAsset));

  return router;
}
