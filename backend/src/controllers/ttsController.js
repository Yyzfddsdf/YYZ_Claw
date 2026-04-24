import { once } from "node:events";

import { ttsStreamRequestSchema } from "../schemas/ttsSchema.js";

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createTtsController({ edgeTextToSpeechService }) {
  function parseRequest(query) {
    const parseResult = ttsStreamRequestSchema.safeParse(query ?? {});
    if (!parseResult.success) {
      const detail = parseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ");
      throw createValidationError(detail || "invalid tts request");
    }
    return parseResult.data;
  }

  return {
    stream: async (req, res) => {
      if (!edgeTextToSpeechService || typeof edgeTextToSpeechService.streamSynthesize !== "function") {
        throw createValidationError("edgeTextToSpeechService is not available");
      }

      const payload = parseRequest(req.query ?? {});
      let clientClosed = false;
      req.on("close", () => {
        clientClosed = true;
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Transfer-Encoding", "chunked");
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      try {
        for await (const audioChunk of edgeTextToSpeechService.streamSynthesize(payload)) {
          if (clientClosed || res.writableEnded || res.destroyed) {
            return;
          }

          const shouldContinue = res.write(audioChunk);
          if (!shouldContinue) {
            await once(res, "drain");
          }
        }

        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      } catch (error) {
        if (clientClosed || res.writableEnded || res.destroyed) {
          return;
        }

        if (res.headersSent) {
          res.destroy(error);
          return;
        }

        throw error;
      }
    }
  };
}

