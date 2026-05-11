import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { GLOBAL_HOOKS_FILE } from "../../config/paths.js";

const SUPPORTED_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmitted",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop"
]);

const MATCHER_EVENTS = new Set(["PreToolUse", "PermissionRequest", "PostToolUse"]);
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;

function createId(prefix = "hook") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeHooksConfig(parsed) {
  if (!isPlainObject(parsed)) {
    return {};
  }
  return isPlainObject(parsed.hooks) ? parsed.hooks : {};
}

function compileMatcherPattern(rawMatcher) {
  const normalized = normalizeText(rawMatcher);
  if (!normalized || normalized === "*") {
    return null;
  }
  const parts = normalized
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `^${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
  if (parts.length === 0) {
    return null;
  }
  return new RegExp(parts.join("|"));
}

function matchesToolName(matcher, toolName) {
  const compiled = compileMatcherPattern(matcher);
  if (!compiled) {
    return true;
  }
  return compiled.test(normalizeText(toolName));
}

function normalizeHandler(handler, eventName, groupIndex, handlerIndex, scopeLabel) {
  if (!isPlainObject(handler)) {
    return null;
  }
  const type = normalizeText(handler.type).toLowerCase();
  if (type !== "command" && type !== "prompt") {
    return null;
  }
  const command = type === "command" ? normalizeText(handler.command) : "";
  const prompt = type === "prompt" ? String(handler.prompt ?? "") : "";
  if (type === "command" && !command) {
    return null;
  }
  if (type === "prompt" && !prompt.trim()) {
    return null;
  }
  const timeout = Number(handler.timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS);
  return {
    id: `${scopeLabel}:${eventName}:${groupIndex}:${handlerIndex}`,
    type,
    command,
    prompt,
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_COMMAND_TIMEOUT_SECONDS,
    statusMessage: normalizeText(handler.statusMessage),
    raw: handler
  };
}

function normalizeEventGroups(eventName, entries, scopeLabel) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const supportsMatcher = MATCHER_EVENTS.has(eventName);
  return entries
    .map((entry, groupIndex) => {
      if (!isPlainObject(entry)) {
        return null;
      }
      const matcher = Object.prototype.hasOwnProperty.call(entry, "matcher")
        ? String(entry.matcher ?? "")
        : "";
      if (!supportsMatcher && matcher.trim()) {
        return null;
      }
      const handlers = Array.isArray(entry.hooks)
        ? entry.hooks
            .map((handler, handlerIndex) =>
              normalizeHandler(handler, eventName, groupIndex, handlerIndex, scopeLabel)
            )
            .filter(Boolean)
        : [];
      if (handlers.length === 0) {
        return null;
      }
      return {
        matcher: supportsMatcher ? matcher : "",
        handlers
      };
    })
    .filter(Boolean);
}

function renderTemplate(template, input = {}) {
  const source = String(template ?? "");
  if (!source) {
    return "";
  }
  return source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, token) => {
    const pathSegments = String(token ?? "")
      .split(".")
      .map((item) => item.trim())
      .filter(Boolean);
    let current = input;
    for (const segment of pathSegments) {
      if (!isPlainObject(current) && !Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = current?.[segment];
    }
    return current == null ? "" : String(current);
  });
}

function createHookPromptMessage({ content, hookEventName, scope = "hook", metadata = {} } = {}) {
  const text = String(content ?? "").trim();
  if (!text) {
    return null;
  }
  return {
    id: createId("hook_prompt"),
    role: "user",
    timestamp: Date.now(),
    content: text,
    meta: {
      kind: "hook_prompt",
      hookEventName: normalizeText(hookEventName),
      source: normalizeText(scope) || "hook",
      ...metadata
    }
  };
}

function createHookStatusMessage({ content, hookEventName, scope = "hook", metadata = {} } = {}) {
  const text = String(content ?? "").trim();
  if (!text) {
    return null;
  }
  return {
    id: createId("hook_status"),
    role: "user",
    timestamp: Date.now(),
    content: text,
    meta: {
      kind: "hook_status",
      hookEventName: normalizeText(hookEventName),
      statusMessage: text,
      source: normalizeText(scope) || "hook",
      ...metadata
    }
  };
}

async function readHookConfigFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeHooksConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

function buildScopeSources(globalHooks, pluginHooks = []) {
  const sources = [];
  if (Object.keys(globalHooks).length > 0) {
    sources.push({
      scopeType: "global",
      scopeName: "global",
      hooks: globalHooks
    });
  }
  for (const pluginHook of pluginHooks) {
    if (!pluginHook || !isPlainObject(pluginHook.hooks) || Object.keys(pluginHook.hooks).length === 0) {
      continue;
    }
    sources.push({
      scopeType: "plugin",
      scopeName: normalizeText(pluginHook.pluginName) || "plugin",
      hooks: pluginHook.hooks
    });
  }
  return sources;
}

async function runCommandHandler(command, input, timeoutSeconds, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finalize = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finalize({
        ok: false,
        code: -1,
        stdout,
        stderr: stderr || `hook command timed out after ${timeoutSeconds}s`
      });
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk ?? "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
    });
    child.on("error", (error) => {
      finalize({
        ok: false,
        code: -1,
        stdout,
        stderr: error?.message || "hook command failed"
      });
    });
    child.on("close", (code) => {
      finalize({
        ok: code === 0,
        code: Number(code ?? -1),
        stdout,
        stderr
      });
    });
    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch (error) {
      finalize({
        ok: false,
        code: -1,
        stdout,
        stderr: error?.message || "failed to write hook stdin"
      });
    }
  });
}

function parseHookStdout(stdout) {
  const text = String(stdout ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      kind: "empty",
      text: ""
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      return {
        kind: "json",
        value: parsed,
        text: trimmed
      };
    }
  } catch {}
  return {
    kind: "text",
    text: trimmed
  };
}

function buildBaseInput(eventName, executionContext = {}, payload = {}) {
  return {
    session_id: normalizeText(executionContext.sessionId || executionContext.conversationId),
    transcript_path: null,
    cwd:
      normalizeText(executionContext.workplacePath)
      || normalizeText(executionContext.workingDirectory)
      || process.cwd(),
    hook_event_name: eventName,
    model: normalizeText(executionContext?.runtimeConfig?.model),
    ...payload
  };
}

export class HookExecutionService {
  constructor(options = {}) {
    this.pluginCatalog = options.pluginCatalog ?? null;
    this.globalHooksFile = normalizeText(options.globalHooksFile) || GLOBAL_HOOKS_FILE;
    this.hookSettingsStore = options.hookSettingsStore ?? null;
  }

  async readGlobalEventSettings() {
    if (!this.hookSettingsStore || typeof this.hookSettingsStore.read !== "function") {
      return {};
    }
    try {
      const settings = await this.hookSettingsStore.read();
      return isPlainObject(settings?.events) ? settings.events : {};
    } catch {
      return {};
    }
  }

  async loadSources(activePluginNames = []) {
    const normalizedPluginNames = new Set(
      (Array.isArray(activePluginNames) ? activePluginNames : [])
        .map((item) => normalizeText(item).toLowerCase())
        .filter(Boolean)
    );
    const globalHooks = await readHookConfigFile(this.globalHooksFile);
    const globalEventSettings = await this.readGlobalEventSettings();
    const pluginHooks = [];
    if (
      this.pluginCatalog &&
      typeof this.pluginCatalog.read === "function" &&
      normalizedPluginNames.size > 0
    ) {
      const catalog = await this.pluginCatalog.read();
      for (const plugin of Array.isArray(catalog?.plugins) ? catalog.plugins : []) {
        const pluginName = normalizeText(plugin?.name).toLowerCase();
        if (!pluginName || !normalizedPluginNames.has(pluginName)) {
          continue;
        }
        const hooksPath = normalizeText(plugin?.hooksPath);
        if (!hooksPath) {
          continue;
        }
        const hooks = await readHookConfigFile(hooksPath);
        pluginHooks.push({
          pluginName: plugin.name,
          hooks
        });
      }
    }
    return buildScopeSources(globalHooks, pluginHooks).map((source) => ({
      ...source,
      eventSettings: source.scopeType === "global" ? globalEventSettings : {}
    }));
  }

  async resolveEventHandlers(eventName, executionContext = {}, toolName = "") {
    if (!SUPPORTED_EVENTS.has(eventName)) {
      return [];
    }
    const sources = await this.loadSources(executionContext.activePluginNames);
    const handlers = [];
    for (const source of sources) {
      const eventEntries = normalizeEventGroups(
        eventName,
        source.hooks?.[eventName],
        `${source.scopeType}:${source.scopeName}`
      );
      if (source.scopeType === "global") {
        const enabled = source.eventSettings?.[eventName]?.enabled;
        if (enabled === false) {
          continue;
        }
      }
      for (const group of eventEntries) {
        if (!MATCHER_EVENTS.has(eventName) || matchesToolName(group.matcher, toolName)) {
          for (const handler of group.handlers) {
            handlers.push({
              ...handler,
              scopeType: source.scopeType,
              scopeName: source.scopeName,
              matcher: group.matcher
            });
          }
        }
      }
    }
    return handlers;
  }

  async executeEvent(eventName, payload = {}, executionContext = {}) {
    const toolName = normalizeText(payload.tool_name);
    const handlers = await this.resolveEventHandlers(eventName, executionContext, toolName);
    const input = buildBaseInput(eventName, executionContext, payload);
    const messages = [];
    const result = {
      messages,
      permissionDecision: null,
      permissionDecisionReason: "",
      postToolDecision: null,
      postToolReason: "",
      stopContinue: true,
      stopReason: "",
      errors: []
    };

    for (const handler of handlers) {
      if (handler.statusMessage) {
        const statusMessage = createHookStatusMessage({
          content: handler.statusMessage,
          hookEventName: eventName,
          scope: `${handler.scopeType}:${handler.scopeName}`,
          metadata: {
            handlerType: handler.type,
            matcher: handler.matcher
          }
        });
        if (statusMessage) {
          messages.push(statusMessage);
        }
      }

      if (handler.type === "prompt") {
        const content = renderTemplate(handler.prompt, input);
        const message = createHookPromptMessage({
          content,
          hookEventName: eventName,
          scope: `${handler.scopeType}:${handler.scopeName}`
        });
        if (message) {
          messages.push(message);
        }
        continue;
      }

      const commandResult = await runCommandHandler(
        handler.command,
        input,
        handler.timeoutSeconds,
        normalizeText(input.cwd)
      );
      const parsedStdout = parseHookStdout(commandResult.stdout);
      if (parsedStdout.kind === "json") {
        const runtimeSystemMessage = String(parsedStdout.value?.systemMessage ?? "").trim();
        if (runtimeSystemMessage) {
          const statusMessage = createHookStatusMessage({
            content: runtimeSystemMessage,
            hookEventName: eventName,
            scope: `${handler.scopeType}:${handler.scopeName}`,
            metadata: {
              handlerType: handler.type,
              matcher: handler.matcher
            }
          });
          if (statusMessage) {
            messages.push(statusMessage);
          }
        }
      }
      if (!commandResult.ok && parsedStdout.kind !== "json") {
        const exitCode = commandResult.code;
        const stderrText = normalizeText(commandResult.stderr);
        if (exitCode === 2 && stderrText) {
          // exit code 2: 快捷阻止/续跑路径 (兼容 OpenAI Codex 规范)
          if (eventName === "PreToolUse") {
            result.permissionDecision = "deny";
            result.permissionDecisionReason = stderrText;
          } else if (eventName === "PostToolUse") {
            result.postToolDecision = "block";
            result.postToolReason = stderrText;
          } else if (eventName === "Stop") {
            result.stopContinue = false;
            result.stopReason = stderrText;
          } else if (eventName === "UserPromptSubmitted") {
            const message = createHookPromptMessage({
              content: stderrText,
              hookEventName: eventName,
              scope: `${handler.scopeType}:${handler.scopeName}`
            });
            if (message) {
              messages.push(message);
            }
          }
        } else {
          result.errors.push({
            handlerId: handler.id,
            message: stderrText || `hook command failed with code ${exitCode}`
          });
        }
      }

      if (eventName === "SessionStart" || eventName === "UserPromptSubmitted") {
        if (parsedStdout.kind === "text") {
          const message = createHookPromptMessage({
            content: parsedStdout.text,
            hookEventName: eventName,
            scope: `${handler.scopeType}:${handler.scopeName}`
          });
          if (message) {
            messages.push(message);
          }
        } else if (parsedStdout.kind === "json") {
          const additionalContext = String(
            parsedStdout.value?.hookSpecificOutput?.additionalContext ?? ""
          ).trim();
          if (additionalContext) {
            const message = createHookPromptMessage({
              content: additionalContext,
              hookEventName: eventName,
              scope: `${handler.scopeType}:${handler.scopeName}`
            });
            if (message) {
              messages.push(message);
            }
          }
        }
        continue;
      }

      if (eventName === "PreToolUse" && parsedStdout.kind === "json") {
        let decision = normalizeText(parsedStdout.value?.hookSpecificOutput?.permissionDecision).toLowerCase();
        let reason = String(
          parsedStdout.value?.hookSpecificOutput?.permissionDecisionReason ?? ""
        ).trim();
        // 兼容旧格式: 顶层 decision: "block"/"deny" + reason (OpenAI Codex 兼容格式)
        if (!decision) {
          const topDecision = normalizeText(parsedStdout.value?.decision).toLowerCase();
          if (topDecision === "block" || topDecision === "deny") {
            decision = "deny";
            reason = String(parsedStdout.value?.reason ?? "").trim();
          }
        }
        if (decision === "deny" || decision === "allow") {
          result.permissionDecision = decision;
          result.permissionDecisionReason = reason;
        }
        continue;
      }

      if (eventName === "PermissionRequest" && parsedStdout.kind === "json") {
        const behavior = normalizeText(
          parsedStdout.value?.hookSpecificOutput?.decision?.behavior
        ).toLowerCase();
        const reason = String(parsedStdout.value?.hookSpecificOutput?.decision?.message ?? "").trim();
        if (behavior === "deny" || behavior === "allow") {
          result.permissionDecision = behavior;
          result.permissionDecisionReason = reason;
        }
        continue;
      }

      if (eventName === "PostToolUse" && parsedStdout.kind === "json") {
        const decision = normalizeText(parsedStdout.value?.hookSpecificOutput?.decision).toLowerCase();
        const reason = String(parsedStdout.value?.hookSpecificOutput?.reason ?? "").trim();
        const additionalContext = String(
          parsedStdout.value?.hookSpecificOutput?.additionalContext ?? ""
        ).trim();
        if (decision === "block") {
          result.postToolDecision = "block";
          result.postToolReason = reason;
        }
        if (additionalContext) {
          const message = createHookPromptMessage({
            content: additionalContext,
            hookEventName: eventName,
            scope: `${handler.scopeType}:${handler.scopeName}`
          });
          if (message) {
            messages.push(message);
          }
        }
        continue;
      }

      if (eventName === "Stop" && parsedStdout.kind === "json") {
        // 标准格式: continue: false + stopReason
        if (parsedStdout.value?.continue === false) {
          result.stopContinue = false;
          result.stopReason = String(parsedStdout.value?.stopReason ?? "").trim();
        }
        // 兼容格式: decision: "block" + reason (OpenAI Codex 兼容格式)
        if (result.stopContinue !== false) {
          const topDecision = normalizeText(parsedStdout.value?.decision).toLowerCase();
          if (topDecision === "block") {
            const reason = String(parsedStdout.value?.reason ?? "").trim();
            if (reason) {
              result.stopContinue = false;
              result.stopReason = reason;
            }
          }
        }
      }
    }

    return result;
  }
}

export function createHookContinuationMessage(stopReason, metadata = {}) {
  return createHookPromptMessage({
    content: stopReason,
    hookEventName: "Stop",
    scope: "hook:continuation",
    metadata
  });
}

export function createHookAppendedMessagesPayload(messages = [], checkpoint = "hook") {
  return {
    type: "conversation_messages_appended",
    messages: Array.isArray(messages) ? messages.filter(Boolean) : [],
    checkpoint
  };
}
