import { Router } from "express";
import multer from "multer";

import { createChatController } from "../controllers/chatController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export function createChatRoutes(services) {
  const router = Router();
  const controller = createChatController(services);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 8,
      fields: 12,
      fieldSize: 32 * 1024 * 1024
    }
  });

  router.post("/chat/workplace/select", asyncHandler(controller.selectWorkplaceBySystemDialog));
  router.post("/chat/files/parse", upload.array("files", 8), asyncHandler(controller.parseUploadedFiles));
  router.get("/chat/events/subscribe", asyncHandler(controller.subscribeConversationEvents));
  router.post(
    "/chat/histories/:conversationId/stop",
    asyncHandler(controller.stopRunByConversationId)
  );
  router.get("/chat/histories", asyncHandler(controller.listHistories));
  router.get("/chat/histories/:conversationId", asyncHandler(controller.getHistoryById));
  router.post("/chat/histories/:conversationId/fork", asyncHandler(controller.forkHistoryById));
  router.put(
    "/chat/histories/:conversationId/workplace",
    asyncHandler(controller.updateWorkplaceById)
  );
  router.put(
    "/chat/histories/:conversationId/approval-mode",
    asyncHandler(controller.updateApprovalModeById)
  );
  router.put("/chat/histories/:conversationId/skills", asyncHandler(controller.updateSkillsById));
  router.put(
    "/chat/histories/:conversationId/developer-prompt",
    asyncHandler(controller.updateDeveloperPromptById)
  );
  router.post(
    "/chat/histories/:conversationId/compress",
    asyncHandler(controller.compressHistoryById)
  );
  router.put("/chat/histories/:conversationId", asyncHandler(controller.upsertHistoryById));
  router.delete(
    "/chat/histories/:conversationId/messages/:messageId",
    asyncHandler(controller.deleteHistoryMessageById)
  );
  router.post(
    "/chat/histories/:conversationId/clear",
    asyncHandler(controller.clearHistoryMessagesById)
  );
  router.delete("/chat/histories/:conversationId", asyncHandler(controller.deleteHistoryById));
  router.post(
    "/chat/tool-approvals/:approvalId/confirm",
    asyncHandler(controller.confirmToolApprovalById)
  );
  router.post(
    "/chat/tool-approvals/:approvalId/reject",
    asyncHandler(controller.rejectToolApprovalById)
  );
  router.post("/chat/stream", asyncHandler(controller.streamChat));

  return router;
}
