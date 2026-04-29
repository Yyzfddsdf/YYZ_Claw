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

const settingsSchema = z.object({
  selectedFile: z.string().trim().max(180).optional().default(""),
  surfaceOpacity: z.number().min(0.18).max(0.98).optional().default(0.68)
});

export function createBackgroundsController({ backgroundStore }) {
  return {
    listBackgrounds: async (_req, res) => {
      res.json({
        backgrounds: await backgroundStore.listBackgrounds(),
        settings: await backgroundStore.readSettings()
      });
    },

    saveSettings: async (req, res) => {
      const validation = settingsSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      res.json({
        settings: await backgroundStore.saveSettings(validation.data),
        backgrounds: await backgroundStore.listBackgrounds()
      });
    },

    uploadBackground: async (req, res) => {
      if (!req.file) {
        throw createHttpError("background file is required");
      }

      const background = await backgroundStore.saveUploadedBackground(req.file);
      const settings = await backgroundStore.saveSettings({
        ...(await backgroundStore.readSettings()),
        selectedFile: background?.name ?? ""
      });
      res.status(201).json({
        background,
        backgrounds: await backgroundStore.listBackgrounds(),
        settings
      });
    },

    deleteBackgroundByName: async (req, res) => {
      const fileName = String(req.params.fileName ?? "").trim();
      if (!fileName) {
        throw createHttpError("fileName is required");
      }

      const deleted = await backgroundStore.deleteBackground(fileName);
      if (!deleted) {
        throw createHttpError("background not found", 404);
      }

      res.json({
        deleted: true,
        backgrounds: await backgroundStore.listBackgrounds(),
        settings: await backgroundStore.readSettings()
      });
    },

    getBackgroundAsset: async (req, res) => {
      const fileName = String(req.params.fileName ?? "").trim();
      if (!fileName) {
        throw createHttpError("fileName is required");
      }

      const asset = await backgroundStore.getAsset(fileName);
      if (!asset) {
        throw createHttpError("background not found", 404);
      }

      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(asset.buffer);
    }
  };
}
