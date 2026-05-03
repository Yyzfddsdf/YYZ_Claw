import fs from "node:fs/promises";
import path from "node:path";

const FILE_TOOL_STATE = (globalThis.__yyzFileToolState ??= {
  trackers: new Map()
});

function getTaskKey(executionContext = {}) {
  return String(executionContext.conversationId ?? "default").trim() || "default";
}

function getTracker(taskKey) {
  if (!FILE_TOOL_STATE.trackers.has(taskKey)) {
    FILE_TOOL_STATE.trackers.set(taskKey, {
      readTimestamps: new Map()
    });
  }

  const tracker = FILE_TOOL_STATE.trackers.get(taskKey);
  if (!tracker || typeof tracker !== "object") {
    const nextTracker = {
      readTimestamps: new Map()
    };
    FILE_TOOL_STATE.trackers.set(taskKey, nextTracker);
    return nextTracker;
  }

  if (!(tracker.readTimestamps instanceof Map)) {
    tracker.readTimestamps = new Map();
  }

  return tracker;
}
function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";

  return candidate ? path.resolve(candidate) : process.cwd();
}

function resolveTargetPath(rawFilePath, cwd) {
  const candidate = typeof rawFilePath === "string" ? rawFilePath.trim() : "";

  if (!candidate) {
    throw new Error("filePath is required");
  }

  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }

  return path.resolve(cwd, candidate);
}

async function ensureDirectory(dirPath) {
  const stats = await fs.stat(dirPath);

  if (!stats.isDirectory()) {
    throw new Error("path must be a directory");
  }
}

async function getStatsOrNull(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

function checkFileStaleness(filePath, taskKey) {
  const tracker = getTracker(taskKey);
  const resolved = String(path.resolve(filePath));
  const readMtime = tracker.readTimestamps.get(resolved);

  if (readMtime === undefined) {
    return Promise.resolve(null);
  }

  return fs.stat(resolved)
    .then((stats) => {
      if (stats.mtimeMs !== readMtime) {
        return `Warning: ${resolved} was modified since you last read it.`;
      }

      return null;
    })
    .catch(() => null);
}

async function updateReadTimestamp(filePath, taskKey) {
  try {
    const resolved = String(path.resolve(filePath));
    const stats = await fs.stat(resolved);
    getTracker(taskKey).readTimestamps.set(resolved, stats.mtimeMs);
  } catch {
    // ignore
  }
}

function normalizeEntries(args) {
  if (Array.isArray(args.operations) && args.operations.length > 0) {
    return args.operations;
  }

  if (typeof args.filePath === "string" && args.filePath.trim()) {
    return [args];
  }

  return [];
}

function normalizeEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`operations[${index}] must be an object`);
  }

  const filePath = typeof entry.filePath === "string" ? entry.filePath.trim() : "";
  const findText = typeof entry.findText === "string" ? entry.findText : "";
  const replaceText = typeof entry.replaceText === "string" ? entry.replaceText : "";

  if (!filePath) {
    throw new Error(`operations[${index}].filePath is required`);
  }

  if (!findText) {
    throw new Error(`operations[${index}].findText is required`);
  }

  return {
    filePath,
    findText,
    replaceText,
    cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
    replaceAll: Boolean(entry.replaceAll)
  };
}

function replaceTextInContent(content, findText, replaceText, replaceAll = false) {
  if (replaceAll) {
    const parts = content.split(findText);
    if (parts.length === 1) {
      return { content, changedCount: 0 };
    }

    return {
      content: parts.join(replaceText),
      changedCount: parts.length - 1
    };
  }

  const index = content.indexOf(findText);
  if (index < 0) {
    return { content, changedCount: 0 };
  }

  return {
    content: content.slice(0, index) + replaceText + content.slice(index + findText.length),
    changedCount: 1
  };
}

async function replaceOne(entry, index, executionContext) {
  const cwdInput = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
  const contextCwd = resolveContextWorkingDirectory(executionContext);
  const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;
  const taskKey = getTaskKey(executionContext);

  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }

  await ensureDirectory(cwd);

  const resolvedFilePath = resolveTargetPath(entry.filePath, cwd);

  const stats = await getStatsOrNull(resolvedFilePath);

  if (!stats) {
    throw new Error(`operations[${index}].file not found`);
  }

  if (stats.isDirectory()) {
    throw new Error(`operations[${index}].filePath points to a directory`);
  }

  const currentContent = await fs.readFile(resolvedFilePath, "utf8");
  const staleWarning = await checkFileStaleness(resolvedFilePath, taskKey);
  const result = replaceTextInContent(
    currentContent,
    entry.findText,
    entry.replaceText,
    entry.replaceAll
  );

  if (result.changedCount === 0) {
    throw new Error(`operations[${index}].findText not found`);
  }

  await fs.writeFile(resolvedFilePath, result.content, { encoding: "utf8" });
  await updateReadTimestamp(resolvedFilePath, taskKey);

  return {
    filePath: resolvedFilePath,
    cwd,
    replaceAll: entry.replaceAll,
    changedCount: result.changedCount,
    ...(staleWarning ? { _warning: staleWarning } : {})
  };
}

export default {
  name: "replace_text",
  description:
    "Replace text in UTF-8 files. Supports a single replacement via top-level fields or a batch via operations array.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target file path. Supports absolute path or relative path."
      },
      findText: {
        type: "string",
        description: "Exact text to replace."
      },
      replaceText: {
        type: "string",
        description: "Replacement text."
      },
      replaceAll: {
        type: "boolean",
        description: "When true, replace every occurrence instead of the first match."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      operations: {
        type: "array",
        description:
          "Optional batch of replace operations. Each item can use the same fields as the single-file form.",
        items: {
          type: "object"
        }
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const entries = normalizeEntries(args);

    if (entries.length === 0) {
      throw new Error("filePath is required");
    }

    const normalizedEntries = entries.map((entry, index) => normalizeEntry(entry, index));
    const results = [];

    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const result = await replaceOne(normalizedEntries[index], index, executionContext);
      results.push({
        index,
        ...result
      });
    }

    return {
      operationCount: results.length,
      results
    };
  }
};
