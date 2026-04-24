import { z } from "zod";

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return Math.trunc(parsed);
}

export const sttTranscribeRequestSchema = z.object({
  language: z.string().trim().max(20).default("zh"),
  task: z.enum(["transcribe", "translate"]).default("transcribe"),
  timeoutMs: z.preprocess(parseOptionalInteger, z.number().int().min(5000).max(1800000).optional())
});
