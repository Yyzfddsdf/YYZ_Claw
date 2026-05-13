import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBraceGroupEnd(pattern, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitBraceGroup(pattern) {
  const parts = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
    }
    current += char;
  }

  parts.push(current);
  return parts;
}

function globToRegExp(glob) {
  const normalized = String(glob ?? "")
    .replace(/\\/g, "/")
    .trim();

  if (!normalized) {
    return null;
  }

  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    if (char === "{") {
      const endIndex = findBraceGroupEnd(normalized, index);
      if (endIndex > index) {
        const inner = normalized.slice(index + 1, endIndex);
        const variants = splitBraceGroup(inner)
          .map((part) => globToRegExp(part))
          .filter(Boolean)
          .map((regex) => regex.source.replace(/^\^/, "").replace(/\$$/, ""));
        if (variants.length > 0) {
          pattern += `(?:${variants.join("|")})`;
          index = endIndex;
          continue;
        }
      }
    }

    pattern += escapeRegExp(char);
  }

  return new RegExp(`^${pattern}$`, "i");
}

function compilePattern(pattern) {
  const normalized = String(pattern ?? "").trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("/") && normalized.endsWith("/") && normalized.length > 1) {
    try {
      return new RegExp(normalized.slice(1, -1), "i");
    } catch {
      return globToRegExp(normalized);
    }
  }

  if (/[\\^$+.()[\]|]/.test(normalized)) {
    try {
      return new RegExp(normalized, "i");
    } catch {
      return globToRegExp(normalized);
    }
  }

  return globToRegExp(normalized);
}

async function walkFiles(rootPath) {
  const stats = await getStatsOrNull(rootPath);

  if (!stats) {
    throw new Error("path not found");
  }

  if (stats.isFile()) {
    return [{ filePath: rootPath, stats }];
  }

  const results = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }

        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        const fileStats = await getStatsOrNull(fullPath);
        if (!fileStats) {
          continue;
        }

        results.push({ filePath: fullPath, stats: fileStats });
      }
    }
  }

  return results;
}

function matchesFilePattern(filePath, rootPath, regex) {
  const relativePath = path.relative(rootPath, filePath).replace(/\\/g, "/");
  const fileName = path.basename(filePath);
  return regex.test(relativePath) || regex.test(fileName);
}

export default {
  name: "Glob",
  description:
    "Find files by path/name under the current workspace. Supports glob wildcards (`*`, `?`, `**`), brace extension lists like `*.{png,jpg,jpeg}`, or regex wrapped as `/.../`. Returns matching file paths, not file contents.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Path/name matcher. Supports glob (`*.js`, `**/*.png`), brace lists (`*.{png,jpg,jpeg}`), or regex wrapped as `/.../`."
      },
      path: {
        type: "string",
        description:
          "Directory or file to search in. Relative paths resolve from current conversation workplace.",
        default: "."
      },
      includeHidden: {
        type: "boolean",
        description: "When true, include dot-prefixed entries."
      },
      maxEntries: {
        type: "integer",
        description: "Maximum number of results to return.",
        default: 500
      }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const rootPath = resolveTargetPath(args.path, resolveContextWorkingDirectory(executionContext));
    const rootStats = await getStatsOrNull(rootPath);

    if (!rootStats) {
      throw new Error("path not found");
    }

    const regex = compilePattern(args.pattern);
    if (!regex) {
      throw new Error("pattern is required");
    }

    const includeHidden = Boolean(args.includeHidden);
    const maxEntries = Number.isFinite(args.maxEntries) && args.maxEntries > 0
      ? Math.min(Math.trunc(args.maxEntries), 5000)
      : 500;

    const files = await walkFiles(rootPath);
    const matched = files
      .filter((item) => {
        if (!includeHidden && path.basename(item.filePath).startsWith(".")) {
          return false;
        }
        return matchesFilePattern(item.filePath, rootPath, regex);
      })
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
      .slice(0, maxEntries)
      .map((item) => ({
        filePath: item.filePath,
        relativePath: path.relative(rootPath, item.filePath).replace(/\\/g, "/"),
        fileName: path.basename(item.filePath),
        size: Number(item.stats.size),
        modifiedAt: Number(item.stats.mtimeMs)
      }));

    return {
      path: rootPath,
      pattern: String(args.pattern ?? ""),
      includeHidden,
      maxEntries,
      totalCount: matched.length,
      results: matched
    };
  }
};
