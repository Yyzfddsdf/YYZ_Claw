const DEFAULT_MAX_HOOKS = 3;
const DEFAULT_MAX_BLOCK_CHARS = 1800;

export const REMOTE_RUNTIME_HOOK_BLOCK_WRAPPER = {
  open: "<remote-runtime-hooks>",
  close: "</remote-runtime-hooks>"
};

export const REMOTE_RUNTIME_HOOK_BLOCK_HEADER =
  "[System note: The following are remote runtime hooks, not user input.]";

function createHookId(prefix = "remote_runtime_hook") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeHookLevel(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "strong" || normalized === "warning" || normalized === "info") {
    return normalized;
  }
  return "info";
}

function normalizeHookScope(value) {
  return String(value ?? "").trim().toLowerCase() === "turn" ? "turn" : "global";
}

function normalizeHookSource(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["message", "tool", "memory", "runtime"].includes(normalized)) {
    return normalized;
  }
  return "runtime";
}

function levelWeight(level) {
  if (level === "strong") {
    return 3;
  }
  if (level === "warning") {
    return 2;
  }
  return 1;
}

function normalizeHookResult(rawHook, definition) {
  if (!rawHook || typeof rawHook !== "object" || Array.isArray(rawHook)) {
    return null;
  }

  const message = String(rawHook.message ?? "").trim();
  if (!message) {
    return null;
  }

  const tags = Array.isArray(rawHook.tags)
    ? rawHook.tags.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const metadata =
    rawHook.metadata && typeof rawHook.metadata === "object" && !Array.isArray(rawHook.metadata)
      ? rawHook.metadata
      : {};
  const priority = Number.isFinite(Number(rawHook.priority))
    ? Number(rawHook.priority)
    : Number(definition?.priority ?? 100);

  return {
    id:
      String(rawHook.id ?? createHookId(definition?.name ?? "remote_runtime_hook")).trim()
      || createHookId(definition?.name ?? "remote_runtime_hook"),
    name: String(definition?.name ?? "remote_runtime_hook").trim() || "remote_runtime_hook",
    type: String(rawHook.type ?? definition?.name ?? "remote_runtime_hook").trim()
      || "remote_runtime_hook",
    source: normalizeHookSource(rawHook.source),
    scope: normalizeHookScope(rawHook.scope),
    level: normalizeHookLevel(rawHook.level),
    priority,
    shouldInject: rawHook.shouldInject !== false,
    oncePerTurn: rawHook.oncePerTurn !== false,
    message,
    tags,
    metadata
  };
}

function normalizeHookResults(rawResults, definition) {
  const list = Array.isArray(rawResults) ? rawResults : [rawResults];
  return list.map((item) => normalizeHookResult(item, definition)).filter(Boolean);
}

function dedupeHooks(hooks = []) {
  const seen = new Set();
  const deduped = [];

  for (const hook of hooks) {
    const tagKey = hook.tags.length > 0 ? hook.tags.join("|") : "";
    const key = `${hook.type}|${hook.message}|${tagKey}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(hook);
  }

  return deduped;
}

function selectHooksForInjection(hooks = [], maxHooks, maxChars) {
  const selected = [];
  let currentChars = 0;

  for (const hook of hooks) {
    if (selected.length >= maxHooks) {
      break;
    }

    const nextChars = currentChars + hook.message.length;
    if (selected.length > 0 && nextChars > maxChars) {
      continue;
    }

    selected.push(hook);
    currentChars = nextChars;
  }

  return selected;
}

function buildBodyLines(hooks = []) {
  return hooks.map((hook) => `- [${hook.level}] ${hook.message}`);
}

export class RemoteHookBlockBuilder {
  constructor(options = {}) {
    this.hookRegistry = options.hookRegistry ?? null;
    this.maxHooks = Number.isInteger(options.maxHooks) ? options.maxHooks : DEFAULT_MAX_HOOKS;
    this.maxBlockChars = Number.isInteger(options.maxBlockChars)
      ? options.maxBlockChars
      : DEFAULT_MAX_BLOCK_CHARS;
  }

  build(scope, executionContext = {}) {
    if (!this.hookRegistry || typeof this.hookRegistry.listHooks !== "function") {
      return {
        hooks: [],
        level: "info",
        wrapper: REMOTE_RUNTIME_HOOK_BLOCK_WRAPPER,
        header: REMOTE_RUNTIME_HOOK_BLOCK_HEADER,
        bodyLines: []
      };
    }

    const collectedHooks = [];
    for (const definition of this.hookRegistry.listHooks()) {
      const rawResult = definition.evaluate(scope, executionContext);
      const normalizedResults = normalizeHookResults(rawResult, definition);
      collectedHooks.push(...normalizedResults);
    }

    const hooks = selectHooksForInjection(
      dedupeHooks(
        collectedHooks
          .filter((hook) => hook.shouldInject)
          .sort((left, right) => {
            if (right.priority !== left.priority) {
              return right.priority - left.priority;
            }
            return levelWeight(right.level) - levelWeight(left.level);
          })
      ),
      this.maxHooks,
      this.maxBlockChars
    );

    const level = hooks.reduce((current, hook) => {
      if (levelWeight(hook.level) > levelWeight(current)) {
        return hook.level;
      }
      return current;
    }, "info");

    return {
      hooks,
      level,
      wrapper: REMOTE_RUNTIME_HOOK_BLOCK_WRAPPER,
      header: REMOTE_RUNTIME_HOOK_BLOCK_HEADER,
      bodyLines: buildBodyLines(hooks)
    };
  }
}

