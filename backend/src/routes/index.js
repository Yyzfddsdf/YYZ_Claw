import { Router } from "express";

import { createChatRoutes } from "./chatRoutes.js";
import { createConfigRoutes } from "./configRoutes.js";
import { createAutomationRoutes } from "./automationRoutes.js";
import { createRemoteControlRoutes } from "../integrations/remote-control/api/remoteControlRoutes.js";
import { createMemoryRoutes } from "./memoryRoutes.js";
import { createMcpRoutes } from "./mcpRoutes.js";
import { createSkillsRoutes } from "./skillsRoutes.js";

export function createApiRouter(services) {
  const router = Router();

  router.use(createConfigRoutes(services));
  router.use(createMcpRoutes(services));
  router.use(createMemoryRoutes(services));
  router.use(createSkillsRoutes(services));
  router.use(createRemoteControlRoutes(services));
  router.use(createAutomationRoutes(services));
  router.use(createChatRoutes(services));

  return router;
}
