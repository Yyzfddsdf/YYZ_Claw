import { randomUUID } from "node:crypto";

import { normalizeRemoteToolResultHooks } from "../tools/remoteToolResultHooks.js";

function normalizePlatformKey(value) {
  return String(value ?? "").trim().toLowerCase() || "remote";
}

function normalizeToolName(value) {
  return String(value ?? "").trim() || "unknown_tool";
}

function normalizeToolCallId(value) {
  return String(value ?? "").trim();
}

function dedupeHooks(hooks = []) {
  const seen = new Set();
  const deduped = [];

  for (const hook of hooks) {
    const key = `${String(hook.type ?? "").trim()}|${String(hook.level ?? "").trim()}|${String(
      hook.message ?? ""
    ).trim()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hook);
  }

  return deduped;
}

export class RemoteToolResultHookManager {
  constructor(options = {}) {
    this.maxHooksPerResult = Number.isInteger(options.maxHooksPerResult)
      ? Math.max(1, options.maxHooksPerResult)
      : 8;
  }

  normalizeHooks(hooks = []) {
    return dedupeHooks(normalizeRemoteToolResultHooks(hooks)).slice(0, this.maxHooksPerResult);
  }

  createRuntimeHookMessages({ event = {}, platformKey = "remote", providerKey = "" } = {}) {
    const normalizedHooks = this.normalizeHooks(event?.hooks);
    if (normalizedHooks.length === 0) {
      return [];
    }

    const resolvedPlatformKey = normalizePlatformKey(platformKey);
    const resolvedProviderKey = normalizePlatformKey(providerKey || platformKey);
    const toolName = normalizeToolName(event?.toolName);
    const toolCallId = normalizeToolCallId(event?.toolCallId);
    const timestamp = Date.now();

    return normalizedHooks.map((hook) => ({
      id: `${resolvedPlatformKey}_runtime_hook_${randomUUID()}`,
      role: "system",
      source: "runtime_hook",
      providerKey: resolvedProviderKey,
      content: String(hook.message ?? "").trim(),
      timestamp,
      meta: {
        kind: "runtime_hook",
        subtype: "tool_result_hook",
        level: String(hook.level ?? "hint").trim() || "hint",
        hookType: String(hook.type ?? "tool_result").trim() || "tool_result",
        hookId: String(hook.id ?? "").trim(),
        toolName,
        toolCallId,
        metadata:
          hook.metadata && typeof hook.metadata === "object" && !Array.isArray(hook.metadata)
            ? hook.metadata
            : {}
      }
    }));
  }
}

