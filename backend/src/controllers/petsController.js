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
  enabled: z.boolean().optional().default(true),
  selectedPet: z.string().trim().max(180).optional().default(""),
  detached: z.boolean().optional().default(false),
  detachedPosition: z
    .object({
      x: z.number().int().min(-10000).max(10000).optional().default(80),
      y: z.number().int().min(-10000).max(10000).optional().default(80)
    })
    .optional()
    .default({ x: 80, y: 80 })
});

const manifestSchema = z.object({
  version: z.number().int().min(1).max(99).optional().default(1),
  description: z.string().trim().max(240).optional().default(""),
  sprite: z.object({
    columns: z.number().int().min(1).max(16).optional().default(8),
    rows: z.number().int().min(1).max(16).optional().default(9),
    totalFrames: z.number().int().min(1).max(256).optional().default(72),
    frameWidth: z.number().int().min(0).max(8192).optional().default(128),
    frameHeight: z.number().int().min(0).max(8192).optional().default(128),
    rowStates: z
      .array(
        z.object({
          row: z.number().int().min(0).max(15),
          state: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(40),
          frames: z.array(z.number().int().min(0).max(255)).min(1).max(8),
          durations: z.array(z.number().int().min(1).max(10000)).min(1).max(32).optional(),
          fps: z.number().int().min(1).max(24).optional()
        })
      )
      .min(1)
      .max(9)
  })
});

export function createPetsController({ petStore }) {
  return {
    listPets: async (_req, res) => {
      res.json({
        pets: await petStore.listPets(),
        settings: await petStore.readSettings(),
        manifest: await petStore.readManifest()
      });
    },

    saveSettings: async (req, res) => {
      const validation = settingsSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      res.json({
        settings: await petStore.saveSettings(validation.data),
        pets: await petStore.listPets(),
        manifest: await petStore.readManifest()
      });
    },

    saveManifest: async (req, res) => {
      const validation = manifestSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      res.json({
        manifest: await petStore.saveManifest(validation.data)
      });
    },

    uploadPetPackage: async (req, res) => {
      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
      if (uploadedFiles.length === 0) {
        throw createHttpError("pet package folder is required");
      }

      const pet = await petStore.saveUploadedPetPackage(uploadedFiles);
      res.status(201).json({
        pet,
        pets: await petStore.listPets(),
        settings: await petStore.readSettings(),
        manifest: await petStore.readManifest()
      });
    },

    getPetAsset: async (req, res) => {
      const fileName = String(req.params.fileName ?? "").trim();
      const assetName = String(req.params.assetName ?? "").trim();
      if (!fileName) {
        throw createHttpError("fileName is required");
      }

      const asset = await petStore.getAsset(fileName, assetName);
      if (!asset) {
        throw createHttpError("pet not found", 404);
      }

      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(asset.buffer);
    }
  };
}
