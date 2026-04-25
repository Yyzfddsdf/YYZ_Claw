import { z } from "zod";

const debateMaterialSchema = z.object({
  name: z.string().trim().max(160).optional(),
  content: z.string().trim().max(600000)
});

export const debateCreateSchema = z.object({
  title: z.string().trim().max(160).optional(),
  topic: z.string().trim().min(1, "topic is required").max(12000),
  description: z.string().trim().max(2000).optional(),
  objective: z.string().trim().max(2000).optional(),
  materials: z.array(debateMaterialSchema).max(8).optional(),
  materialsText: z.string().trim().max(600000).optional(),
  maxRounds: z.number().int().min(1).max(20).optional()
});
