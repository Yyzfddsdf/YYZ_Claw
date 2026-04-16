import { mcpConfigSchema } from "../schemas/mcpSchema.js";

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export function createMcpConfigController({ mcpConfigStore, mcpManager, toolRegistry }) {
  return {
    getMcpConfig: async (_req, res) => {
      const config = await mcpConfigStore.read();
      const status = mcpManager?.getStatus?.() ?? {
        servers: [],
        toolCount: 0,
        errorCount: 0,
        errors: []
      };

      res.json({
        config,
        status
      });
    },

    saveMcpConfig: async (req, res) => {
      const validation = mcpConfigSchema.safeParse(req.body);

      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const saved = await mcpConfigStore.save(validation.data);

      if (mcpManager && typeof mcpManager.reload === "function") {
        await mcpManager.reload(saved);
      }

      if (toolRegistry && typeof toolRegistry.refresh === "function") {
        await toolRegistry.refresh();
      }

      res.status(200).json({
        config: saved,
        status: mcpManager?.getStatus?.() ?? {
          servers: [],
          toolCount: 0,
          errorCount: 0,
          errors: []
        }
      });
    }
  };
}
