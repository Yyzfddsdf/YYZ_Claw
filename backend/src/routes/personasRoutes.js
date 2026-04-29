import { Router } from "express";
import multer from "multer";

import { createPersonasController } from "../controllers/personasController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createPersonasRoutes(services) {
  const router = Router();
  const controller = createPersonasController(services);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 1
    }
  });

  router.get("/personas", asyncHandler(controller.listPersonas));
  router.post("/personas", asyncHandler(controller.createPersona));
  router.put("/personas/:personaId", asyncHandler(controller.updatePersonaById));
  router.delete("/personas/:personaId", asyncHandler(controller.deletePersonaById));
  router.get("/personas/:personaId/avatar", asyncHandler(controller.getAvatarById));
  router.post(
    "/personas/:personaId/avatar",
    upload.single("avatar"),
    asyncHandler(controller.uploadAvatarById)
  );

  return router;
}
