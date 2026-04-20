import {
  clipText,
  ensureDirectory,
  escapeRegExp,
  normalizePositiveInteger,
  readTextFileLines,
  resolveContextWorkingDirectory,
  resolveTargetPath,
  toSafeRelative,
  walkTextFiles
} from "../../tools/privateToolShared.js";

function normalizeQueries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalized = String(item ?? "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function buildSnippet(lines, lineIndex, contextLines, maxChars) {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length - 1, lineIndex + contextLines);
  const snippet = lines.slice(start, end + 1).join("\n");

  return {
    startLine: start + 1,
    endLine: end + 1,
    snippet: clipText(snippet, maxChars)
  };
}

export default {
  name: "researcher_evidence_bundle",
  description:
    "Collect query-based evidence snippets across workspace files with grouped results per query.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Evidence query list."
      },
      path: {
        type: "string",
        description: "Optional root path (relative to workspace or absolute).",
        default: "."
      },
      contextLines: {
        type: "integer",
        description: "Context line radius per evidence snippet.",
        default: 2
      },
      perQueryLimit: {
        type: "integer",
        description: "Max snippets returned for each query.",
        default: 6
      },
      maxTotalResults: {
        type: "integer",
        description: "Global cap of returned snippets.",
        default: 36
      },
      maxFiles: {
        type: "integer",
        description: "Max files to scan.",
        default: 700
      },
      maxSnippetChars: {
        type: "integer",
        description: "Max chars per snippet.",
        default: 800
      }
    },
    required: ["queries"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const queries = normalizeQueries(args.queries);
    if (queries.length === 0) {
      throw new Error("queries must include at least one non-empty item");
    }

    const workspaceCwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(workspaceCwd);
    const targetPath = resolveTargetPath(workspaceCwd, args.path);
    const contextLines = normalizePositiveInteger(args.contextLines, 2, 0, 8);
    const perQueryLimit = normalizePositiveInteger(args.perQueryLimit, 6, 1, 30);
    const maxTotalResults = normalizePositiveInteger(args.maxTotalResults, 36, 1, 300);
    const maxFiles = normalizePositiveInteger(args.maxFiles, 700, 1, 10000);
    const maxSnippetChars = normalizePositiveInteger(args.maxSnippetChars, 800, 200, 3000);

    const queryStates = queries.map((query) => ({
      query,
      regex: new RegExp(escapeRegExp(query), "i"),
      results: []
    }));

    const files = await walkTextFiles(targetPath, { maxFiles });
    let totalResults = 0;

    for (const filePath of files) {
      if (totalResults >= maxTotalResults) {
        break;
      }

      let parsed;
      try {
        parsed = await readTextFileLines(filePath, { maxChars: 500000 });
      } catch {
        continue;
      }

      for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
        if (totalResults >= maxTotalResults) {
          break;
        }

        const line = parsed.lines[lineIndex];
        for (const state of queryStates) {
          if (state.results.length >= perQueryLimit || totalResults >= maxTotalResults) {
            continue;
          }

          state.regex.lastIndex = 0;
          if (!state.regex.test(line)) {
            continue;
          }

          const snippet = buildSnippet(parsed.lines, lineIndex, contextLines, maxSnippetChars);
          state.results.push({
            filePath,
            relativePath: toSafeRelative(targetPath, filePath),
            lineNumber: lineIndex + 1,
            line: line.trimEnd(),
            ...snippet
          });
          totalResults += 1;
        }
      }
    }

    const evidenceBundle = queryStates.map((state) => ({
      query: state.query,
      resultCount: state.results.length,
      results: state.results
    }));

    return {
      targetPath,
      summary: {
        queryCount: queries.length,
        scannedFiles: files.length,
        totalResults
      },
      evidenceBundle
    };
  }
};
