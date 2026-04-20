import path from "node:path";

import {
  ensureDirectory,
  escapeRegExp,
  normalizePositiveInteger,
  readTextFileLines,
  resolveContextWorkingDirectory,
  resolveTargetPath,
  toSafeRelative,
  walkTextFiles
} from "../../tools/privateToolShared.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function buildSymbolRegex(symbol, exactWord) {
  const escaped = escapeRegExp(symbol);
  if (exactWord && /^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) {
    return new RegExp(`\\b${escaped}\\b`);
  }
  return new RegExp(escaped);
}

function isDefinitionCandidate(line, symbol) {
  const escaped = escapeRegExp(symbol);
  const definitionPatterns = [
    new RegExp(`\\b(class|interface|enum|type|struct|function|def|const|let|var|export|fn)\\b[^\\n]*\\b${escaped}\\b`),
    new RegExp(`\\b${escaped}\\b\\s*[:=(]`)
  ];

  return definitionPatterns.some((pattern) => pattern.test(line));
}

export default {
  name: "researcher_symbol_map",
  description:
    "Build a symbol evidence map across workspace files with occurrence lines and likely definition candidates.",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Target symbol name or token."
      },
      path: {
        type: "string",
        description: "Optional root path (relative to workspace or absolute).",
        default: "."
      },
      exactWord: {
        type: "boolean",
        description: "Use word-boundary exact match when possible.",
        default: true
      },
      maxFiles: {
        type: "integer",
        description: "Max files to scan.",
        default: 1200
      },
      maxResults: {
        type: "integer",
        description: "Max matched lines to return.",
        default: 120
      }
    },
    required: ["symbol"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const symbol = normalizeText(args.symbol);
    if (!symbol) {
      throw new Error("symbol is required");
    }

    const workspaceCwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(workspaceCwd);
    const targetPath = resolveTargetPath(workspaceCwd, args.path);
    const maxFiles = normalizePositiveInteger(args.maxFiles, 1200, 1, 10000);
    const maxResults = normalizePositiveInteger(args.maxResults, 120, 1, 1000);
    const exactWord = args.exactWord !== false;
    const symbolRegex = buildSymbolRegex(symbol, exactWord);

    const files = await walkTextFiles(targetPath, { maxFiles });
    const matches = [];

    for (const filePath of files) {
      let parsed;
      try {
        parsed = await readTextFileLines(filePath, { maxChars: 500000 });
      } catch {
        continue;
      }

      for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
        const line = parsed.lines[lineIndex];
        symbolRegex.lastIndex = 0;
        if (!symbolRegex.test(line)) {
          continue;
        }

        const lineNumber = lineIndex + 1;
        const trimmed = line.trimEnd();
        const kind = isDefinitionCandidate(trimmed, symbol) ? "definition_candidate" : "reference";
        matches.push({
          filePath,
          relativePath: toSafeRelative(targetPath, filePath),
          lineNumber,
          kind,
          line: trimmed
        });

        if (matches.length >= maxResults) {
          break;
        }
      }

      if (matches.length >= maxResults) {
        break;
      }
    }

    const definitionCount = matches.filter((item) => item.kind === "definition_candidate").length;
    const referenceCount = matches.length - definitionCount;
    const filesWithMatches = Array.from(new Set(matches.map((item) => item.filePath))).length;

    return {
      symbol,
      targetPath: path.resolve(targetPath),
      summary: {
        scannedFiles: files.length,
        filesWithMatches,
        totalMatches: matches.length,
        definitionCandidateCount: definitionCount,
        referenceCount
      },
      matches
    };
  }
};
