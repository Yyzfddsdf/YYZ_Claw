import { z } from "zod";

const envSchema = z.record(z.string(), z.string()).optional().default({});
const headersSchema = z.record(z.string(), z.string()).optional().default({});

const mcpServerSchema = z.object({
  name: z.string().trim().min(1, "server name is required"),
  transport: z.enum(["stdio", "http"]).optional().default("stdio"),
  command: z.string().trim().optional().default(""),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().trim().optional().default(""),
  env: envSchema,
  url: z.string().trim().optional().default(""),
  httpHeaders: headersSchema,
  enabled: z.boolean().optional().default(true),
  startupTimeoutMs: z.number().int().positive().max(120000).optional().default(10000),
  requestTimeoutMs: z.number().int().positive().max(120000).optional().default(30000)
}).superRefine((server, ctx) => {
  if (server.transport === "stdio" && !String(server.command ?? "").trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "server command is required for stdio transport"
    });
  }

  if (server.transport === "http" && !String(server.url ?? "").trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "server url is required for http transport"
    });
  }

  if (server.transport === "http" && String(server.url ?? "").trim()) {
    try {
      new URL(String(server.url).trim());
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "server url must be a valid URL"
      });
    }
  }
});

export const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).optional().default([])
});
