import { Router } from "express";

import { createChatRoutes } from "./chatRoutes.js";
import { createConfigRoutes } from "./configRoutes.js";
import { createAutomationRoutes } from "./automationRoutes.js";
import { createBackgroundRoutes } from "./backgroundRoutes.js";
import { createDebateRoutes } from "./debateRoutes.js";
import { createRemoteControlRoutes } from "../integrations/remote-control/api/remoteControlRoutes.js";
import { createMemoryRoutes } from "./memoryRoutes.js";
import { createMcpRoutes } from "./mcpRoutes.js";
import { createPersonasRoutes } from "./personasRoutes.js";
import { createSkillsRoutes } from "./skillsRoutes.js";
import { createSttRoutes } from "./sttRoutes.js";
import { createTtsRoutes } from "./ttsRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";

export function createApiRouter(services) {
  const router = Router();

  router.use(createConfigRoutes(services));
  router.use(createBackgroundRoutes(services));
  router.use(createMcpRoutes(services));
  router.use(createMemoryRoutes(services));
  router.use(createPersonasRoutes(services));
  router.use(createSkillsRoutes(services));
  router.use(createSttRoutes(services));
  router.use(createTtsRoutes(services));
  router.use(createWorkspaceRoutes(services));
  router.use(createRemoteControlRoutes(services));
  router.use(createAutomationRoutes(services));
  router.use(createDebateRoutes(services));
  router.use(createChatRoutes(services));

  return router;
}
