import { z } from "zod";

import { MODEL_PROVIDERS } from "../services/modelProviders/modelProviderDefinitions.js";

const modelProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  provider: z.enum([
    MODEL_PROVIDERS.OPENAI_COMPLETION,
    MODEL_PROVIDERS.DASHSCOPE_COMPLETION,
    MODEL_PROVIDERS.ANTHROPIC_MESSAGES
  ]),
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1),
  baseURL: z.string().trim().url("baseURL must be a valid URL"),
  apiKey: z.string().trim().min(1),
  maxContextWindow: z.number().int().positive().optional(),
  supportsVision: z.boolean().optional()
});

export const configSchema = z
  .object({
    modelProfiles: z.array(modelProfileSchema).min(1, "at least one model profile is required"),
    defaultMainModelProfileId: z.string().trim().min(1),
    defaultSubagentModelProfileId: z.string().trim().min(1),
    defaultCompressionModelProfileId: z.string().trim().min(1),
    webProvider: z.string().trim().optional(),
    tavilyApiKey: z.string().trim().optional(),
    compressionMaxOutputTokens: z.number().int().positive().optional(),
    sttProvider: z.literal("cloudflare").optional(),
    sttCloudflareApiToken: z.string().trim().optional(),
    sttCloudflareAccountId: z.string().trim().optional(),
    sttCloudflareModel: z.string().trim().optional()
  })
  .superRefine((value, context) => {
    const ids = new Set(value.modelProfiles.map((profile) => profile.id));
    for (const field of [
      "defaultMainModelProfileId",
      "defaultSubagentModelProfileId",
      "defaultCompressionModelProfileId"
    ]) {
      if (!ids.has(value[field])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "must reference an existing model profile"
        });
      }
    }
  });
