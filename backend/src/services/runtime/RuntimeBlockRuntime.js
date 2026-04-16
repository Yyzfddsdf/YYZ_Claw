const DEFAULT_MAX_SYSTEM_BLOCKS = 3;
const DEFAULT_MAX_SYSTEM_CHARS = 2400;
const DEFAULT_MAX_CURRENT_USER_BLOCKS = 2;
const DEFAULT_MAX_CURRENT_USER_CHARS = 12000;

function createRuntimeBlockId(prefix = "runtime_block") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeChannel(channel) {
  return String(channel ?? "").trim().toLowerCase() === "current_user" ? "current_user" : "system";
}

function normalizeLevel(level) {
  const normalized = String(level ?? "").trim().toLowerCase();
  if (normalized === "strong" || normalized === "warning" || normalized === "info") {
    return normalized;
  }
  return "info";
}

function normalizeSource(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (["hook", "memory", "files", "approval", "runtime", "tool", "message"].includes(normalized)) {
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

function buildRuntimeBlockContent(rawBlock) {
  const directContent = String(rawBlock?.content ?? "").trim();
  if (directContent) {
    return directContent;
  }

  const wrapperOpen = String(rawBlock?.wrapper?.open ?? "").trim();
  const wrapperClose = String(rawBlock?.wrapper?.close ?? "").trim();
  const header = String(rawBlock?.header ?? "").trim();
  const body = String(rawBlock?.body ?? "").trim();
  const bodyLines = Array.isArray(rawBlock?.bodyLines)
    ? rawBlock.bodyLines
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    : [];

  const innerParts = [];
  if (header) {
    innerParts.push(header);
  }
  if (body) {
    innerParts.push(body);
  }
  if (bodyLines.length > 0) {
    innerParts.push(bodyLines.join("\n"));
  }

  const innerText = innerParts.join("\n\n").trim();
  if (!wrapperOpen && !wrapperClose) {
    return innerText;
  }

  const outerParts = [];
  if (wrapperOpen) {
    outerParts.push(wrapperOpen);
  }
  if (innerText) {
    outerParts.push(innerText);
  }
  if (wrapperClose) {
    outerParts.push(wrapperClose);
  }

  return outerParts.join("\n").trim();
}

function normalizeRuntimeBlock(rawBlock, provider) {
  if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
    return null;
  }

  const content = buildRuntimeBlockContent(rawBlock);
  if (!content) {
    return null;
  }

  const tags = Array.isArray(rawBlock.tags)
    ? rawBlock.tags
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    : [];

  const metadata =
    rawBlock.metadata && typeof rawBlock.metadata === "object" && !Array.isArray(rawBlock.metadata)
      ? rawBlock.metadata
      : {};

  const priority = Number.isFinite(Number(rawBlock.priority))
    ? Number(rawBlock.priority)
    : Number(provider?.priority ?? 100);

  return {
    id: String(rawBlock.id ?? createRuntimeBlockId(provider?.name ?? "runtime_block")).trim()
      || createRuntimeBlockId(provider?.name ?? "runtime_block"),
    name: String(provider?.name ?? "runtime_block").trim() || "runtime_block",
    type: String(rawBlock.type ?? provider?.name ?? "runtime_block").trim() || "runtime_block",
    source: normalizeSource(rawBlock.source),
    channel: normalizeChannel(rawBlock.channel),
    level: normalizeLevel(rawBlock.level),
    priority,
    shouldInject: rawBlock.shouldInject !== false,
    oncePerTurn: rawBlock.oncePerTurn !== false,
    tags,
    metadata,
    content
  };
}

function normalizeRuntimeBlocks(rawBlocks, provider) {
  const list = Array.isArray(rawBlocks) ? rawBlocks : [rawBlocks];
  return list.map((item) => normalizeRuntimeBlock(item, provider)).filter(Boolean);
}

function dedupeRuntimeBlocks(blocks = []) {
  const seen = new Set();
  const deduped = [];

  for (const block of blocks) {
    const tagKey = block.tags.length > 0 ? block.tags.join("|") : "";
    const key = `${block.channel}|${block.type}|${block.content}|${tagKey}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(block);
  }

  return deduped;
}

function selectBlocksForChannel(blocks = [], maxBlocks, maxChars) {
  const selected = [];
  let currentChars = 0;

  for (const block of blocks) {
    if (selected.length >= maxBlocks) {
      break;
    }

    const nextChars = currentChars + block.content.length;
    if (selected.length > 0 && nextChars > maxChars) {
      continue;
    }

    selected.push(block);
    currentChars = nextChars;
  }

  return selected;
}

function buildScopeRevision(scope) {
  const lastMessage = scope.scopedMessages[scope.scopedMessages.length - 1];
  const lastToolEvent = scope.recentToolEvents[scope.recentToolEvents.length - 1];

  return JSON.stringify({
    systemCount: scope.systemMessages.length,
    scopedMessageCount: scope.scopedMessages.length,
    lastMessageId: String(lastMessage?.id ?? ""),
    lastMessageTimestamp: Number(lastMessage?.timestamp ?? 0),
    recentToolEventCount: scope.recentToolEvents.length,
    lastToolEventId: String(lastToolEvent?.id ?? ""),
    lastToolEventTimestamp: Number(lastToolEvent?.timestamp ?? 0),
    recallBlockLength: String(scope.longTermMemoryRecall?.memoryContextBlock ?? "").length,
    approvalMode: String(scope.approvalMode ?? "")
  });
}

export class RuntimeBlockRuntime {
  constructor(options = {}) {
    this.blockRegistry = options.blockRegistry ?? null;
    this.scopeBuilder = options.scopeBuilder ?? null;
    this.services = options.services ?? {};
    this.maxSystemBlocks = Number.isInteger(options.maxSystemBlocks)
      ? options.maxSystemBlocks
      : DEFAULT_MAX_SYSTEM_BLOCKS;
    this.maxSystemChars = Number.isInteger(options.maxSystemChars)
      ? options.maxSystemChars
      : DEFAULT_MAX_SYSTEM_CHARS;
    this.maxCurrentUserBlocks = Number.isInteger(options.maxCurrentUserBlocks)
      ? options.maxCurrentUserBlocks
      : DEFAULT_MAX_CURRENT_USER_BLOCKS;
    this.maxCurrentUserChars = Number.isInteger(options.maxCurrentUserChars)
      ? options.maxCurrentUserChars
      : DEFAULT_MAX_CURRENT_USER_CHARS;
  }

  buildScope({ conversation = [], rawConversationMessages = [], executionContext = {} } = {}) {
    if (!this.scopeBuilder || typeof this.scopeBuilder.build !== "function") {
      return null;
    }

    return this.scopeBuilder.build({
      conversation,
      rawConversationMessages,
      executionContext
    });
  }

  resolve({ conversation = [], rawConversationMessages = [], executionContext = {} } = {}) {
    if (
      !this.blockRegistry ||
      typeof this.blockRegistry.listProviders !== "function" ||
      !this.scopeBuilder ||
      typeof this.scopeBuilder.build !== "function"
    ) {
      return {
        scope: null,
        revision: "",
        blocks: [],
        blocksByChannel: {
          system: [],
          current_user: []
        }
      };
    }

    const scope = this.buildScope({
      conversation,
      rawConversationMessages,
      executionContext
    });
    if (!scope) {
      return {
        scope: null,
        revision: "",
        blocks: [],
        blocksByChannel: {
          system: [],
          current_user: []
        }
      };
    }

    const revision = buildScopeRevision(scope);
    const turnRuntime =
      executionContext.turnRuntime && typeof executionContext.turnRuntime === "object"
        ? executionContext.turnRuntime
        : {};
    executionContext.turnRuntime = turnRuntime;

    const cached = turnRuntime.runtimeBlockRuntime;
    if (cached?.revision === revision && cached?.result) {
      return cached.result;
    }

    const collectedBlocks = [];
    for (const provider of this.blockRegistry.listProviders()) {
      const rawResult = provider.resolve(scope, {
        executionContext,
        services: this.services
      });
      const normalizedBlocks = normalizeRuntimeBlocks(rawResult, provider);
      collectedBlocks.push(...normalizedBlocks);
    }

    const sortedBlocks = dedupeRuntimeBlocks(
      collectedBlocks
        .filter((block) => block.shouldInject)
        .sort((left, right) => {
          if (right.priority !== left.priority) {
            return right.priority - left.priority;
          }

          return levelWeight(right.level) - levelWeight(left.level);
        })
    );

    const systemBlocks = selectBlocksForChannel(
      sortedBlocks.filter((block) => block.channel === "system"),
      this.maxSystemBlocks,
      this.maxSystemChars
    );
    const currentUserBlocks = selectBlocksForChannel(
      sortedBlocks.filter((block) => block.channel === "current_user"),
      this.maxCurrentUserBlocks,
      this.maxCurrentUserChars
    );

    const result = {
      scope,
      revision,
      blocks: [...systemBlocks, ...currentUserBlocks],
      blocksByChannel: {
        system: systemBlocks,
        current_user: currentUserBlocks
      }
    };

    turnRuntime.runtimeBlockRuntime = {
      revision,
      result
    };

    return result;
  }
}
