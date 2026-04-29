import { z } from "zod";

export const automationTaskPayloadSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  prompt: z.string().trim().min(1, "prompt is required").max(50000)
});

export const automationTaskUpdateSchema = automationTaskPayloadSchema.partial();

export const automationBindingPayloadSchema = z.object({
  templateId: z.string().trim().min(1, "templateId is required").max(160),
  conversationId: z.string().trim().min(1, "conversationId is required").max(160),
  timeOfDay: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "timeOfDay must be HH:mm"),
  enabled: z.boolean().optional(),
  timezone: z.string().trim().max(120).optional()
});

export const automationBindingUpdateSchema = automationBindingPayloadSchema
  .omit({ conversationId: true })
  .partial();
