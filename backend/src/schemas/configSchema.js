import { z } from "zod";

function createOptionalUrlWithBlankSchema(fieldName) {
  return z
    .string()
    .trim()
    .refine((value) => value.length === 0 || z.string().url().safeParse(value).success, {
      message: `${fieldName} must be a valid URL`
    })
    .optional();
}

export const configSchema = z.object({
  model: z.string().trim().min(1, "model is required"),
  baseURL: z.string().trim().url("baseURL must be a valid URL"),
  apiKey: z.string().trim().min(1, "apiKey is required"),
  webProvider: z.string().trim().optional(),
  tavilyApiKey: z.string().trim().optional(),
  subagentModel: z.string().trim().optional(),
  subagentBaseURL: createOptionalUrlWithBlankSchema("subagentBaseURL"),
  subagentApiKey: z.string().trim().optional(),
  maxContextWindow: z.number().int().positive().optional(),
  compressionModel: z.string().trim().optional(),
  compressionBaseURL: createOptionalUrlWithBlankSchema("compressionBaseURL"),
  compressionApiKey: z.string().trim().optional(),
  compressionMaxOutputTokens: z.number().int().positive().optional(),
  sttProvider: z.enum(["local", "cloudflare"]).optional(),
  sttCloudflareApiToken: z.string().trim().optional(),
  sttCloudflareAccountId: z.string().trim().optional(),
  sttCloudflareModel: z.string().trim().optional()
});
