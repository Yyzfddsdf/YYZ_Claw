import { z } from "zod";

export const automationTaskPayloadSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  prompt: z.string().trim().min(1, "prompt is required").max(50000),
  workplacePath: z.string().trim().min(1, "workplacePath is required"),
  timeOfDay: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "timeOfDay must be HH:mm"),
  enabled: z.boolean().optional(),
  timezone: z.string().trim().max(120).optional()
});

export const automationTaskUpdateSchema = automationTaskPayloadSchema.partial();
