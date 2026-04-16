import { configSchema } from "../schemas/configSchema.js";

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

export function createConfigController({ configStore }) {
  return {
    getConfig: async (_req, res) => {
      const config = await configStore.read();
      res.json({ config });
    },

    saveConfig: async (req, res) => {
      const validation = configSchema.safeParse(req.body);

      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const saved = await configStore.save(validation.data);
      res.status(200).json({ config: saved });
    }
  };
}
