import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
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

function isBinaryFilePath(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    pattern += escapeRegExp(char);
  }

  return new RegExp(`^${pattern}$`, "i");
}

function compileFileMatcher(pattern) {
  const normalized = String(pattern ?? "").trim();

  if (!normalized) {
    return null;
  }

  const looksLikeRegex =
    (normalized.startsWith("/") && normalized.endsWith("/") && normalized.length > 1) ||
    /[\\^$+?.()[\]{}|]/.test(normalized);

  if (normalized.startsWith("/") && normalized.endsWith("/") && normalized.length > 1) {
    try {
      return new RegExp(normalized.slice(1, -1), "i");
    } catch {
      return globToRegExp(normalized);
    }
  }

  if (looksLikeRegex) {
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

function buildLineSnippets(lines, lineNumber, context) {
  const safeContext = Number.isFinite(context) && context > 0 ? Math.trunc(context) : 0;
  const startLine = Math.max(1, lineNumber - safeContext);
  const endLine = Math.min(lines.length, lineNumber + safeContext);

  return {
    startLine,
    endLine,
    snippet: lines.slice(startLine - 1, endLine).join("\n")
  };
}

function compileSearchRegex(pattern) {
  const normalized = String(pattern ?? "").trim();
  if (!normalized) {
    throw new Error("pattern is required");
  }

  return new RegExp(normalized, "i");
}

function collectContentMatches(filePath, text, regex, context) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const results = [];
  const globalRegex = new RegExp(regex.source, `${regex.flags.includes("g") ? regex.flags : `${regex.flags}g`}`);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    globalRegex.lastIndex = 0;
    const matches = Array.from(line.matchAll(globalRegex));

    if (matches.length === 0) {
      continue;
    }

    const lineNumber = index + 1;
    const snippet = buildLineSnippets(lines, lineNumber, context);

    results.push({
      filePath,
      lineNumber,
      matchCount: matches.length,
      line: line.trimEnd(),
      ...snippet
    });
  }

  return results;
}

function collectCountMatches(filePath, text, regex) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let count = 0;
  const globalRegex = new RegExp(regex.source, `${regex.flags.includes("g") ? regex.flags : `${regex.flags}g`}`);

  for (const line of lines) {
    globalRegex.lastIndex = 0;
    count += Array.from(line.matchAll(globalRegex)).length;
  }

  if (count === 0) {
    return null;
  }

  return {
    filePath,
    matchCount: count
  };
}

function matchesFilePattern(filePath, rootPath, regex) {
  const relativePath = path.relative(rootPath, filePath).replace(/\\/g, "/");
  const fileName = path.basename(filePath);
  return regex.test(relativePath) || regex.test(fileName);
}

export default {
  name: "Grep",
  description:
    "Search patterns in file contents under the current workspace. Returns matches with line numbers and optional context.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for."
      },
      path: {
        type: "string",
        description:
          "Directory or file to search in. Relative paths resolve from current conversation workplace.",
        default: "."
      },
      file_glob: {
        type: "string",
        description: "Optional glob filter for content search."
      },
      limit: {
        type: "integer",
        description: "Maximum results to return.",
        default: 50
      },
      offset: {
        type: "integer",
        description: "Skip the first N results.",
        default: 0
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_only", "count"],
        description: "How to format search results.",
        default: "content"
      },
      context: {
        type: "integer",
        description: "Context lines around a match.",
        default: 0
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

    const searchRegex = compileSearchRegex(args.pattern);
    const fileGlobRegex = args.file_glob ? compileFileMatcher(args.file_glob) : null;
    const context = Number.isFinite(args.context) && args.context >= 0 ? Math.trunc(args.context) : 0;
    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : 50;
    const offset = Number.isFinite(args.offset) && args.offset >= 0 ? Math.trunc(args.offset) : 0;
    const outputMode = String(args.output_mode ?? "content").trim();

    const files = await walkFiles(rootPath);
    const results = [];

    for (const item of files) {
      if (isBinaryFilePath(item.filePath)) {
        continue;
      }

      if (fileGlobRegex && !matchesFilePattern(item.filePath, rootPath, fileGlobRegex)) {
        continue;
      }

      let text;
      try {
        text = await fs.readFile(item.filePath, "utf8");
      } catch {
        continue;
      }

      if (outputMode === "count") {
        const countResult = collectCountMatches(item.filePath, text, searchRegex);
        if (countResult) {
          results.push({
            ...countResult,
            relativePath: path.relative(rootPath, item.filePath).replace(/\\/g, "/"),
            fileName: path.basename(item.filePath),
            size: Number(item.stats.size),
            modifiedAt: Number(item.stats.mtimeMs)
          });
        }
        continue;
      }

      const matches = collectContentMatches(item.filePath, text, searchRegex, context);
      for (const match of matches) {
        results.push({
          ...match,
          relativePath: path.relative(rootPath, item.filePath).replace(/\\/g, "/"),
          fileName: path.basename(item.filePath),
          size: Number(item.stats.size),
          modifiedAt: Number(item.stats.mtimeMs)
        });
      }
    }

    const sliced = results.slice(offset, offset + limit);

    if (outputMode === "files_only") {
      const uniqueFiles = [];
      const seen = new Set();

      for (const item of sliced) {
        if (seen.has(item.filePath)) {
          continue;
        }
        seen.add(item.filePath);
        uniqueFiles.push({
          filePath: item.filePath,
          relativePath: item.relativePath,
          fileName: item.fileName,
          size: item.size,
          modifiedAt: item.modifiedAt
        });
      }

      return {
        pattern: String(args.pattern ?? ""),
        path: rootPath,
        totalCount: results.length,
        returnedCount: uniqueFiles.length,
        truncated: offset + sliced.length < results.length,
        results: uniqueFiles
      };
    }

    return {
      pattern: String(args.pattern ?? ""),
      path: rootPath,
      totalCount: results.length,
      returnedCount: sliced.length,
      truncated: offset + sliced.length < results.length,
      results: sliced
    };
  }
};
