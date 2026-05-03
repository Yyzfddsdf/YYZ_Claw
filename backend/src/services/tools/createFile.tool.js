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

function updateReadTimestamp(filePath, taskKey) {
  try {
    const resolved = String(path.resolve(filePath));
    const mtime = fs.stat(resolved).then((stats) => stats.mtimeMs).catch(() => null);
    return mtime.then((value) => {
      if (value === null) {
        return;
      }

      getTracker(taskKey).readTimestamps.set(resolved, value);
    });
  } catch {
    return Promise.resolve();
  }
}

function checkFileStaleness(filePath, taskKey) {
  const tracker = getTracker(taskKey);
  const resolved = String(path.resolve(filePath));
  const readMtime = tracker.readTimestamps.get(resolved);

  if (readMtime === undefined) {
    return null;
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
  if (!filePath) {
    throw new Error(`operations[${index}].filePath is required`);
  }

  return {
    filePath,
    content: typeof entry.content === "string" ? entry.content : "",
    cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
    overwrite: Boolean(entry.overwrite),
    append: Boolean(entry.append),
    createDirectories: entry.createDirectories !== false
  };
}

async function writeOne(entry, index, executionContext) {
  const cwdInput = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
  const contextCwd = resolveContextWorkingDirectory(executionContext);
  const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;
  const taskKey = getTaskKey(executionContext);

  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }

  await ensureDirectory(cwd);

  const resolvedFilePath = resolveTargetPath(entry.filePath, cwd);
  const createDirectories = entry.createDirectories !== false;
  const parentDir = path.dirname(resolvedFilePath);

  if (createDirectories) {
    await fs.mkdir(parentDir, { recursive: true });
  } else {
    await ensureDirectory(parentDir);
  }

  const existingStats = await getStatsOrNull(resolvedFilePath);
  const staleWarning = await checkFileStaleness(resolvedFilePath, taskKey);

  if (existingStats?.isDirectory()) {
    throw new Error(`operations[${index}].filePath points to a directory`);
  }

  if (entry.append && entry.overwrite) {
    throw new Error(`operations[${index}].append and overwrite cannot both be true`);
  }

  if (existingStats && !entry.append && !entry.overwrite) {
    throw new Error(`operations[${index}].file already exists; set overwrite=true to replace it`);
  }

  const content = entry.content;

  if (entry.append) {
    await fs.appendFile(resolvedFilePath, content, { encoding: "utf8" });
  } else {
    await fs.writeFile(resolvedFilePath, content, { encoding: "utf8" });
  }

  const finalStats = await fs.stat(resolvedFilePath);

  return {
    filePath: resolvedFilePath,
    cwd,
    encoding: "utf8",
    created: !existingStats,
    overwritten: Boolean(existingStats && !entry.append),
    appended: entry.append,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    totalBytes: Number(finalStats.size),
    ...(staleWarning ? { _warning: staleWarning } : {})
  };
}

export default {
  name: "create_file",
  description:
    "Create or update UTF-8 text files. Supports a single file via top-level fields or a batch via operations array.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target file path. Supports absolute path or relative path."
      },
      content: {
        type: "string",
        description: "Text content to write. Defaults to empty string when omitted."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      overwrite: {
        type: "boolean",
        description: "When true, overwrite existing file content."
      },
      append: {
        type: "boolean",
        description: "When true, append content to the file instead of replacing it."
      },
      createDirectories: {
        type: "boolean",
        description: "When true, create parent directories automatically. Defaults to true."
      },
      operations: {
        type: "array",
        description:
          "Optional batch of create/write operations. Each item can use the same fields as the single-file form.",
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
      const result = await writeOne(normalizedEntries[index], index, executionContext);
      await updateReadTimestamp(result.filePath, getTaskKey(executionContext));
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
