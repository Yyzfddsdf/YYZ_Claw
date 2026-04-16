import { z } from "zod";

const optionalIdSchema = z.string().trim().min(1).optional();
const requiredIdSchema = z.string().trim().min(1);
const optionalTextSchema = z.string().trim().optional();

function createKeywordArraySchema(fieldName) {
  return z
    .array(z.string().trim().min(1).max(60))
    .min(1, `${fieldName} is required`)
    .max(20, `${fieldName} cannot exceed 20 items`)
    .transform((keywords) =>
      Array.from(new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean)))
    );
}

const specificKeywordArraySchema = createKeywordArraySchema("specificKeywords");
const generalKeywordArraySchema = createKeywordArraySchema("generalKeywords");

export const memoryTopicCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80)
});

export const memoryTopicUpdateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80)
});

export const memoryContentCreateSchema = z.object({
  topicId: requiredIdSchema,
  name: z.string().trim().min(1, "name is required").max(120),
  description: z.string().max(500).optional().default("")
});

export const memoryContentUpdateSchema = z.object({
  topicId: optionalIdSchema,
  name: z.string().trim().min(1, "name is required").max(120).optional(),
  description: z.string().max(500).optional()
});

export const memoryNodeCreateSchema = z.object({
  contentId: requiredIdSchema,
  name: z.string().trim().min(1, "name is required").max(120),
  coreMemory: z.string().trim().min(1, "coreMemory is required").max(500),
  explanation: z.string().trim().min(1, "explanation is required").max(2000),
  specificKeywords: specificKeywordArraySchema,
  generalKeywords: generalKeywordArraySchema
});

export const memoryNodeUpdateSchema = z.object({
  contentId: optionalIdSchema,
  name: z.string().trim().min(1).max(120).optional(),
  coreMemory: z.string().trim().min(1).max(500).optional(),
  explanation: z.string().trim().min(1).max(2000).optional(),
  specificKeywords: specificKeywordArraySchema.optional(),
  generalKeywords: generalKeywordArraySchema.optional()
});

export const memoryNodeRelationCreateSchema = z.object({
  fromNodeId: z.string().trim().min(1, "fromNodeId is required"),
  toNodeId: z.string().trim().min(1, "toNodeId is required"),
  relationType: z.string().trim().min(1).max(80).optional().default("related_to"),
  reason: z.string().trim().max(500).optional().default("")
});
