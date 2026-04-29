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

const personaPayloadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional().default(""),
  prompt: z.string().trim().min(1).max(20000),
  accentColor: z.string().trim().max(32).optional().default("#2563eb")
});

export function createPersonasController({ personaStore, historyStore, remoteControlConfigStore }) {
  return {
    listPersonas: async (_req, res) => {
      res.json({ personas: await personaStore.listPersonas() });
    },

    createPersona: async (req, res) => {
      const validation = personaPayloadSchema.safeParse(req.body);
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      res.status(201).json({ persona: await personaStore.createPersona(validation.data) });
    },

    updatePersonaById: async (req, res) => {
      const personaId = String(req.params.personaId ?? "").trim();
      const validation = personaPayloadSchema.safeParse(req.body);
      if (!personaId) {
        throw createHttpError("personaId is required");
      }
      if (!validation.success) {
        throw createHttpError(formatZodError(validation.error));
      }

      const persona = await personaStore.updatePersona(personaId, validation.data);
      if (!persona) {
        throw createHttpError("persona not found", 404);
      }
      historyStore?.replaceConversationPersonaId?.(personaId, persona.id);
      await remoteControlConfigStore?.replacePersonaId?.(personaId, persona.id);
      res.json({ persona });
    },

    deletePersonaById: async (req, res) => {
      const personaId = String(req.params.personaId ?? "").trim();
      if (!personaId) {
        throw createHttpError("personaId is required");
      }

      const deleted = await personaStore.deletePersona(personaId);
      if (!deleted) {
        throw createHttpError("persona not found", 404);
      }
      historyStore?.replaceConversationPersonaId?.(personaId, "");
      await remoteControlConfigStore?.replacePersonaId?.(personaId, "");
      res.json({ deleted: true });
    },

    uploadAvatarById: async (req, res) => {
      const personaId = String(req.params.personaId ?? "").trim();
      if (!personaId) {
        throw createHttpError("personaId is required");
      }
      if (!req.file) {
        throw createHttpError("avatar file is required");
      }

      const persona = await personaStore.saveAvatar(personaId, req.file);
      if (!persona) {
        throw createHttpError("persona not found", 404);
      }
      res.json({ persona });
    },

    getAvatarById: async (req, res) => {
      const personaId = String(req.params.personaId ?? "").trim();
      if (!personaId) {
        throw createHttpError("personaId is required");
      }

      const asset = await personaStore.getAvatarAsset(personaId);
      if (!asset) {
        throw createHttpError("avatar not found", 404);
      }
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(asset.buffer);
    }
  };
}
