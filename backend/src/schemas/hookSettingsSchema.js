import { z } from "zod";

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmitted",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop"
];

const eventSettingsSchema = z.object({
  enabled: z.boolean().default(true)
});

export const hookSettingsSchema = z.object({
  events: z.object(
    Object.fromEntries(
      HOOK_EVENT_NAMES.map((eventName) => [eventName, eventSettingsSchema.default({ enabled: true })])
    )
  )
});

export function createDefaultHookSettings() {
  return {
    events: Object.fromEntries(HOOK_EVENT_NAMES.map((eventName) => [eventName, { enabled: true }]))
  };
}
