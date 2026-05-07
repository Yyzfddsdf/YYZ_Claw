import { z } from "zod";

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

const subagentPayloadSchema = z.object({
  agentType: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(20000),
  metadata: z.record(z.string().trim().max(500)).optional().default({})
});

const subagentUpdateSchema = subagentPayloadSchema.omit({ agentType: true });

export function createSubagentsController({ subagentAssetStore, subagentDefinitionRegistry }) {
  async function reloadRegistry() {
    if (typeof subagentDefinitionRegistry?.load === "function") {
      await subagentDefinitionRegistry.load();
    }
  }

  return {
    listSubagents: async (_req, res) => {
      res.json({ subagents: await subagentAssetStore.listSubagents() });
    },

    createSubagent: async (req, res) => {
      const validation = subagentPayloadSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      const subagent = await subagentAssetStore.createSubagent(validation.data);
      await reloadRegistry();
      res.status(201).json({ subagent });
    },

    updateSubagentById: async (req, res) => {
      const agentType = String(req.params.agentType ?? "").trim();
      if (!agentType) {
        throw createHttpError("agentType is required");
      }

      const validation = subagentUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      const subagent = await subagentAssetStore.updateSubagent(agentType, validation.data);
      if (!subagent) {
        throw createHttpError("subagent not found", 404);
      }

      await reloadRegistry();
      res.json({ subagent });
    },

    deleteSubagentById: async (req, res) => {
      const agentType = String(req.params.agentType ?? "").trim();
      if (!agentType) {
        throw createHttpError("agentType is required");
      }

      const deleted = await subagentAssetStore.deleteSubagent(agentType);
      if (!deleted) {
        throw createHttpError("subagent not found", 404);
      }

      await reloadRegistry();
      res.json({ deleted: true });
    }
  };
}
