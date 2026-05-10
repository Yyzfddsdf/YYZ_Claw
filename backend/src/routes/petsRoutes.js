import { Router } from "express";
import multer from "multer";

import { createPetsController } from "../controllers/petsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createPetsRoutes(services) {
  const router = Router();
  const controller = createPetsController(services);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 64
    }
  });

  router.get("/pets", asyncHandler(controller.listPets));
  router.post("/pets/settings", asyncHandler(controller.saveSettings));
  router.post("/pets/manifest", asyncHandler(controller.saveManifest));
  router.post("/pets/upload", upload.array("files", 64), asyncHandler(controller.uploadPetPackage));
  router.get("/pets/assets/:fileName/:assetName", asyncHandler(controller.getPetAsset));
  router.get("/pets/assets/:fileName", asyncHandler(controller.getPetAsset));

  return router;
}
