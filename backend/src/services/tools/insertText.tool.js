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

  return FILE_TOOL_STATE.trackers.get(taskKey);
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
  const anchorText = typeof entry.anchorText === "string" ? entry.anchorText : "";
  const content = typeof entry.content === "string" ? entry.content : "";

  if (!filePath) {
    throw new Error(`operations[${index}].filePath is required`);
  }

  if (!anchorText) {
    throw new Error(`operations[${index}].anchorText is required`);
  }

  return {
    filePath,
    anchorText,
    content,
    cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
    position: entry.position === "after" ? "after" : "before",
    occurrence:
      Number.isFinite(entry.occurrence) && entry.occurrence > 0
        ? Math.trunc(entry.occurrence)
        : 1
  };
}

function findNthIndex(text, needle, occurrence = 1) {
  let fromIndex = 0;
  let hitIndex = -1;

  for (let count = 0; count < occurrence; count += 1) {
    hitIndex = text.indexOf(needle, fromIndex);

    if (hitIndex < 0) {
      return -1;
    }

    fromIndex = hitIndex + needle.length;
  }

  return hitIndex;
}

function insertTextInContent(content, anchorText, insertText, position, occurrence = 1) {
  const anchorIndex = findNthIndex(content, anchorText, occurrence);

  if (anchorIndex < 0) {
    throw new Error("anchorText not found");
  }

  const insertIndex = position === "after" ? anchorIndex + anchorText.length : anchorIndex;

  return {
    content: content.slice(0, insertIndex) + insertText + content.slice(insertIndex),
    anchorIndex,
    insertIndex
  };
}

async function insertOne(entry, index, executionContext) {
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
  const result = insertTextInContent(
    currentContent,
    entry.anchorText,
    entry.content,
    entry.position,
    entry.occurrence
  );

  await fs.writeFile(resolvedFilePath, result.content, { encoding: "utf8" });
  await updateReadTimestamp(resolvedFilePath, taskKey);

  return {
    filePath: resolvedFilePath,
    cwd,
    position: entry.position,
    occurrence: entry.occurrence,
    insertIndex: result.insertIndex,
    ...(staleWarning ? { _warning: staleWarning } : {})
  };
}

export default {
  name: "insert_text",
  description:
    "Insert text around an exact anchor in UTF-8 files. Supports a single insertion via top-level fields or a batch via operations array.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target file path. Supports absolute path or relative path."
      },
      anchorText: {
        type: "string",
        description: "Exact anchor text to insert around."
      },
      content: {
        type: "string",
        description: "Text content to insert."
      },
      position: {
        type: "string",
        enum: ["before", "after"],
        description: "Insert before or after the anchor."
      },
      occurrence: {
        type: "integer",
        description: "1-based occurrence of the anchor to target."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      operations: {
        type: "array",
        description:
          "Optional batch of insert operations. Each item can use the same fields as the single-file form.",
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
      const result = await insertOne(normalizedEntries[index], index, executionContext);
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
