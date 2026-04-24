import express, { Router } from "express";
import multer from "multer";

import { createSttController } from "../controllers/sttController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createSttRoutes(services) {
  const router = Router();
  const controller = createSttController(services);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: 25 * 1024 * 1024,
      fields: 8,
      fieldSize: 512 * 1024
    }
  });

  router.post(
    "/stt/transcribe",
    express.raw({
      type: ["audio/*", "application/octet-stream"],
      limit: "25mb"
    }),
    asyncHandler(controller.transcribeRaw)
  );
  router.post("/stt/transcribe", upload.single("file"), asyncHandler(controller.transcribe));

  return router;
}
