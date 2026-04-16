import fs from "node:fs/promises";
import path from "node:path";

function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";

  return candidate ? path.resolve(candidate) : process.cwd();
}

function resolveTargetPath(rawPath, cwd) {
  const candidate = typeof rawPath === "string" ? rawPath.trim() : "";

  if (!candidate) {
    return cwd;
  }

  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }

  return path.resolve(cwd, candidate);
}

async function getStatsOrNull(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

function normalizeMaxEntries(value) {
  if (!Number.isFinite(value)) {
    return 500;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  return Math.min(normalized, 5000);
}

function buildEntrySummary(entry, fullPath, stats) {
  const type = entry.isDirectory()
    ? "directory"
    : entry.isFile()
      ? "file"
      : entry.isSymbolicLink()
        ? "symlink"
        : "other";

  return {
    name: entry.name,
    path: fullPath,
    type,
    size: Number(stats.size),
    modifiedAt: Number(stats.mtimeMs),
    hidden: entry.name.startsWith(".")
  };
}

export default {
  name: "list_dir",
  description:
    "List entries in a directory. Relative and absolute paths are supported; when omitted, the current conversation workplace is used.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Target directory path. Supports relative or absolute paths. Defaults to the current conversation workplace.",
        default: "."
      },
      cwd: {
        type: "string",
        description:
          "Optional working directory used to resolve relative paths. Supports relative or absolute paths and defaults to the current conversation workplace."
      },
      includeHidden: {
        type: "boolean",
        description: "When true, include dot-prefixed entries."
      },
      maxEntries: {
        type: "integer",
        description: "Maximum number of entries to return.",
        default: 500
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    const targetPath = resolveTargetPath(args.path, cwd);
    const stats = await getStatsOrNull(targetPath);

    if (!stats) {
      throw new Error("path not found");
    }

    if (stats.isFile()) {
      throw new Error("path points to a file");
    }

    if (!stats.isDirectory()) {
      throw new Error("path points to an unsupported filesystem entry");
    }

    const includeHidden = Boolean(args.includeHidden);
    const maxEntries = normalizeMaxEntries(args.maxEntries);
    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    const filteredEntries = entries
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxEntries);

    const results = [];

    for (const entry of filteredEntries) {
      const fullPath = path.join(targetPath, entry.name);
      const entryStats = await fs.lstat(fullPath);
      results.push(buildEntrySummary(entry, fullPath, entryStats));
    }

    return {
      cwd,
      path: targetPath,
      includeHidden,
      maxEntries,
      entryCount: filteredEntries.length,
      totalCount: entries.filter((entry) => includeHidden || !entry.name.startsWith(".")).length,
      truncated: entries.length > filteredEntries.length,
      entries: results
    };
  }
};
