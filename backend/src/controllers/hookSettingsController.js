import { hookSettingsSchema } from "../schemas/hookSettingsSchema.js";

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

export function createHookSettingsController({ hookSettingsStore }) {
  return {
    getHookSettings: async (_req, res) => {
      const settings = await hookSettingsStore.read();
      res.json({ settings });
    },

    saveHookSettings: async (req, res) => {
      const validation = hookSettingsSchema.safeParse(req.body);

      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const saved = await hookSettingsStore.save(validation.data);
      res.status(200).json({ settings: saved });
    }
  };
}
