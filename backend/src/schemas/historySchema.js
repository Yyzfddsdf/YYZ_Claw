import { z } from "zod";
import { approvalModeSchema, thinkingModeSchema } from "./chatSchema.js";

const toolCallFunctionSchema = z.object({
  name: z.string().trim().min(1, "tool call function.name is required"),
  arguments: z.string().optional().default("{}")
});

const toolCallSchema = z.object({
  id: z.string().trim().min(1, "tool call id is required"),
  type: z.literal("function").optional().default("function"),
  function: toolCallFunctionSchema
});

const historyMessageMetaSchema = z.object({}).passthrough();

const tokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().positive(),
  promptTokensDetails: z.unknown().nullable().optional(),
  completionTokensDetails: z.unknown().nullable().optional(),
  model: z.string().trim().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  id: z.string().trim().optional(),
  conversationId: z.string().trim().optional()
});

export const historyMessageSchema = z.object({
  id: z.string().trim().min(1, "message.id is required"),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  reasoningContent: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
  toolCallId: z.string().trim().optional(),
  toolName: z.string().trim().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  meta: historyMessageMetaSchema.optional(),
  tokenUsage: tokenUsageSchema.optional()
});

export const conversationUpsertSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  workplacePath: z.string().trim().min(1, "workplacePath cannot be empty").optional(),
  approvalMode: approvalModeSchema.optional(),
  goal: z.string().optional(),
  skills: z.array(z.string().trim().min(1)).optional(),
  disabledTools: z.array(z.string().trim().min(1)).optional(),
  personaId: z.string().trim().max(120).optional(),
  modelProfileId: z.string().trim().max(120).optional(),
  thinkingMode: thinkingModeSchema.optional(),
  developerPrompt: z.string().max(20000).optional(),
  replaceMessages: z.boolean().optional().default(false),
  messages: z.array(historyMessageSchema)
});

export const conversationWorkplaceSchema = z.object({
  workplacePath: z.string().trim().min(1, "workplacePath is required")
});

export const conversationSkillsSchema = z.object({
  skills: z.array(z.string().trim().min(1))
});

export const conversationToolsSchema = z.object({
  disabledTools: z.array(z.string().trim().min(1)).default([])
});

export const conversationPersonaSchema = z.object({
  personaId: z.string().trim().max(120).optional().default("")
});

export const conversationModelProfileSchema = z.object({
  modelProfileId: z.string().trim().min(1).max(120)
});

export const conversationThinkingModeSchema = z.object({
  thinkingMode: thinkingModeSchema
});

export const conversationDeveloperPromptSchema = z.object({
  developerPrompt: z.string().max(20000)
});
