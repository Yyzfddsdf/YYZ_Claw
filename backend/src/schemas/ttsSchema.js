import { z } from "zod";

export const ttsStreamRequestSchema = z.object({
  text: z.string().trim().min(1).max(3000),
  voice: z.string().trim().min(1).max(80).optional(),
  rate: z.string().trim().max(24).optional(),
  volume: z.string().trim().max(24).optional(),
  pitch: z.string().trim().max(24).optional()
});

