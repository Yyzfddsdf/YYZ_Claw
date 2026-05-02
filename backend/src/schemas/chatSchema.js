import { z } from "zod";

const toolCallFunctionSchema = z.object({
  name: z.string().trim().min(1, "tool call function.name is required"),
  arguments: z.string().optional().default("{}")
});

const toolCallSchema = z.object({
  id: z.string().trim().min(1, "tool call id is required"),
  type: z.literal("function").optional().default("function"),
  function: toolCallFunctionSchema
});

const tokenUsageSchema = z.object({
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  totalTokens: z.number().positive(),
  promptTokensDetails: z.unknown().nullable().optional(),
  completionTokensDetails: z.unknown().nullable().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  model: z.string().trim().optional()
});

const chatMessageSchema = z.object({
  id: z.string().trim().min(1).optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  reasoningContent: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
  toolCallId: z.string().trim().optional(),
  toolName: z.string().trim().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  meta: z.object({}).passthrough().optional(),
  tokenUsage: tokenUsageSchema.optional()
});

export const approvalModeSchema = z.enum(["confirm", "auto"]);

export const compressionTriggerSchema = z.enum(["manual", "auto"]);
export const reasoningEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
export const thinkingModeSchema = z.enum(["off", "default", "low", "medium", "high", "xhigh", "max"]);

export const chatRequestSchema = z.object({
  conversationId: z.string().trim().min(1, "conversationId is required").optional(),
  messages: z.array(chatMessageSchema).min(1, "at least one message is required"),
  approvalMode: approvalModeSchema.optional(),
  developerPrompt: z.string().max(20000).optional(),
  personaId: z.string().trim().max(120).optional(),
  enableDeepThinking: z.boolean().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  thinkingMode: thinkingModeSchema.optional()
});

export const conversationApprovalModeSchema = z.object({
  approvalMode: approvalModeSchema
});

export const conversationCompressionSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, "at least one message is required"),
  trigger: compressionTriggerSchema.default("manual")
});
