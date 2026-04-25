import { debateCreateSchema } from "../schemas/debateSchema.js";

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

export function createDebateController({ debateStore, debateService }) {
  if (!debateStore || !debateService) {
    throw new Error("debateStore and debateService are required");
  }

  return {
    listDebates: async (_req, res) => {
      const debates = debateStore.listDebates().map((debate) => ({
        ...debate,
        turns: undefined,
        messagesA: undefined,
        messagesB: undefined
      }));
      res.json({ debates });
    },

    getDebateById: async (req, res) => {
      const debateId = String(req.params.debateId || "").trim();
      if (!debateId) {
        throw createValidationError("debateId is required");
      }

      const debate = debateStore.getDebate(debateId);
      if (!debate) {
        const notFoundError = createValidationError("debate not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({
        debate: {
          ...debate,
          messagesA: undefined,
          messagesB: undefined
        }
      });
    },

    createDebate: async (req, res) => {
      const validation = debateCreateSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const debate = await debateService.createAndRunDebate(validation.data);
      res.status(201).json({ debate });
    },

    deleteDebateById: async (req, res) => {
      const debateId = String(req.params.debateId || "").trim();
      if (!debateId) {
        throw createValidationError("debateId is required");
      }

      const debate = debateStore.deleteDebate(debateId);
      if (!debate) {
        const notFoundError = createValidationError("debate not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ debate });
    }
  };
}
