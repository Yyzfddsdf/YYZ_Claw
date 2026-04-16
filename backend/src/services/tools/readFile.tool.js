import fs from "node:fs/promises";
import path from "node:path";

const MAX_READ_CHARS = 100_000;
const LARGE_FILE_HINT_BYTES = 512_000;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".bin"
]);
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2"
]);
const FILE_TOOL_STATE = (globalThis.__yyzFileToolState ??= {
  trackers: new Map()
});

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

function isBlockedDevicePath(filePath) {
  const normalized = path.posix.normalize(String(filePath ?? "").replace(/\\/g, "/"));

  if (BLOCKED_DEVICE_PATHS.has(normalized)) {
    return true;
  }

  if (/^\/proc\/.+\/fd\/[012]$/.test(normalized)) {
    return true;
  }

  return false;
}

function isBinaryFilePath(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

async function getStatsOrNull(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

function getTaskKey(executionContext = {}) {
  return String(executionContext.conversationId ?? "default").trim() || "default";
}

function getTrackerEntry(taskKey) {
  if (!FILE_TOOL_STATE.trackers.has(taskKey)) {
    FILE_TOOL_STATE.trackers.set(taskKey, {
      lastKey: "",
      consecutive: 0,
      dedup: new Map(),
      readTimestamps: new Map()
    });
  }

  return FILE_TOOL_STATE.trackers.get(taskKey);
}

async function updateReadTimestamp(filePath, taskKey) {
  try {
    const stats = await fs.stat(filePath);
    getTrackerEntry(taskKey).readTimestamps.set(String(path.resolve(filePath)), stats.mtimeMs);
  } catch {
    // ignore
  }
}

function toInteger(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value);
  return normalized;
}

function normalizeRange(args, totalLines) {
  const startCandidate = toInteger(args.startLine);
  const endCandidate = toInteger(args.endLine);
  const includeAll = Boolean(args.includeAll);

  if (includeAll || (startCandidate === null && endCandidate === null)) {
    return {
      startLine: totalLines === 0 ? 0 : 1,
      endLine: totalLines,
      isPartial: false
    };
  }

  let startLine = startCandidate ?? 1;
  let endLine = endCandidate ?? startLine;

  if (startLine < 1 || endLine < 1) {
    throw new Error("startLine and endLine must be >= 1");
  }

  if (endLine < startLine) {
    throw new Error("endLine must be greater than or equal to startLine");
  }

  if (totalLines === 0) {
    return {
      startLine: 0,
      endLine: 0,
      isPartial: false
    };
  }

  const safeStart = Math.min(startLine, totalLines);
  const safeEnd = Math.min(endLine, totalLines);

  return {
    startLine: safeStart,
    endLine: safeEnd,
    isPartial: safeStart !== 1 || safeEnd !== totalLines
  };
}

export default {
  name: "read_file",
  description:
    "Read text file content. Relative paths resolve from cwd/current workplace. Supports full content or 1-based line ranges.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target file path. Supports absolute path or relative path."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      startLine: {
        type: "integer",
        description: "Optional 1-based start line."
      },
      endLine: {
        type: "integer",
        description: "Optional 1-based end line (inclusive)."
      },
      includeAll: {
        type: "boolean",
        description: "When true, return full file content and ignore line range."
      }
    },
    required: ["filePath"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    const resolvedPath = resolveTargetPath(args.filePath, cwd);
    if (isBlockedDevicePath(resolvedPath)) {
      throw new Error(`Cannot read device file: ${resolvedPath}`);
    }

    if (isBinaryFilePath(resolvedPath)) {
      throw new Error(`Cannot read binary file: ${resolvedPath}`);
    }

    const stats = await getStatsOrNull(resolvedPath);
    if (!stats) {
      throw new Error("file not found");
    }

    if (!stats.isFile()) {
      throw new Error("path points to a directory");
    }

    const taskKey = getTaskKey(executionContext);
    const tracker = getTrackerEntry(taskKey);
    const rawContent = await fs.readFile(resolvedPath, "utf8");

    const isEmptyFile = rawContent.length === 0;
    const lines = isEmptyFile ? [] : rawContent.split(/\r?\n/);
    const totalLines = lines.length;

    const range = normalizeRange(args, totalLines);
    const dedupKey = `${resolvedPath}|${range.startLine}|${range.endLine}`;
    const cachedMtime = tracker.dedup.get(dedupKey);

    if (cachedMtime !== undefined) {
      try {
        const currentStats = await fs.stat(resolvedPath);
        if (currentStats.mtimeMs === cachedMtime) {
          tracker.consecutive = tracker.lastKey === dedupKey ? tracker.consecutive + 1 : 1;
          tracker.lastKey = dedupKey;

          if (tracker.consecutive >= 4) {
            throw new Error(
              `BLOCKED: You have read this exact file region ${tracker.consecutive} times in a row. The content has NOT changed. STOP re-reading and proceed with your task.`
            );
          }

          const dedupResult = {
            filePath: resolvedPath,
            cwd,
            totalLines,
            startLine: range.startLine,
            endLine: range.endLine,
            isPartial: range.isPartial,
            dedup: true,
            content:
              "File unchanged since last read. The earlier read_file result in this conversation is still current."
          };

          if (tracker.consecutive >= 3) {
            dedupResult._warning =
              `You have read this exact file region ${tracker.consecutive} times consecutively. The content has not changed since your last read.`;
          }

          return dedupResult;
        }
      } catch {
        // fall through
      }
    }

    if (totalLines === 0) {
      await updateReadTimestamp(resolvedPath, taskKey);
      return {
        filePath: resolvedPath,
        cwd,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        isPartial: false,
        content: ""
      };
    }

    const content = lines
      .slice(range.startLine - 1, range.endLine)
      .join("\n");

    if (content.length > MAX_READ_CHARS) {
      throw new Error(
        `Read content is too large (${content.length} chars). Use startLine/endLine to read a smaller range.`
      );
    }

    tracker.consecutive = tracker.lastKey === dedupKey ? tracker.consecutive + 1 : 1;
    tracker.lastKey = dedupKey;
    tracker.dedup.set(dedupKey, stats.mtimeMs);
    await updateReadTimestamp(resolvedPath, taskKey);

    const result = {
      filePath: resolvedPath,
      cwd,
      totalLines,
      startLine: range.startLine,
      endLine: range.endLine,
      isPartial: range.isPartial,
      content
    };

    if (stats.size > LARGE_FILE_HINT_BYTES && range.isPartial) {
      result._hint =
        "This file is large. Consider reading a smaller line range to keep context compact.";
    }

    if (tracker.consecutive >= 3) {
      result._warning =
        `You have read this exact file region ${tracker.consecutive} times consecutively. The content has not changed since your last read.`;
    }

    return result;
  }
};
