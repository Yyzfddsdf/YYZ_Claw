import { Router } from "express";

import { asyncHandler } from "../../../middleware/asyncHandler.js";
import { createRemoteControlController } from "./remoteControlController.js";

export function createRemoteControlRoutes(services) {
  const router = Router();
  const controller = createRemoteControlController(services);

  router.get("/remote-control/config", asyncHandler(controller.getConfig));
  router.post("/remote-control/config", asyncHandler(controller.saveConfig));
  router.post("/remote-control/events", asyncHandler(controller.receiveEvent));
  router.get("/remote-control/records", asyncHandler(controller.listRecords));
  router.delete("/remote-control/records", asyncHandler(controller.clearRecords));
  router.post("/remote-control/messages", asyncHandler(controller.enqueueMessages));
  router.get("/remote-control/status", asyncHandler(controller.getStatus));
  router.post("/remote-control/flush", asyncHandler(controller.flushQueue));

  return router;
}
