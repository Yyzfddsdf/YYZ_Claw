import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureDirectory,
  fileExists,
  normalizePositiveInteger,
  resolveContextWorkingDirectory,
  resolveTargetPath,
  runShellCommand
} from "../../tools/privateToolShared.js";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sc",
  ".sh",
  ".bash",
  ".zsh",
  ".rs"
]);

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function parseGitPorcelain(statusText = "") {
  const lines = String(statusText ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines
    .map((line) => {
      if (line.length < 4) {
        return null;
      }

      const statusCode = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      if (!filePath) {
        return null;
      }

      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        filePath = parts[parts.length - 1].trim();
      }

      filePath = filePath.replace(/^"(.*)"$/, "$1").replace(/\\"/g, "\"");
      if (!filePath) {
        return null;
      }

      return {
        path: filePath,
        statusCode
      };
    })
    .filter(Boolean);
}

function isTestFile(relativePath) {
  const normalized = toPosixPath(relativePath).toLowerCase();
  return (
    normalized.includes("/__tests__/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith("_test.go") ||
    normalized.endsWith("_test.py") ||
    /(^|\/)test_.*\.py$/.test(normalized) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(normalized)
  );
}

function isSourceFile(relativePath) {
  const normalized = toPosixPath(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) {
    return false;
  }
  return !isTestFile(normalized);
}

function inferCandidateTests(sourceRelativePath) {
  const normalized = toPosixPath(sourceRelativePath);
  const extension = path.extname(normalized);
  const dirname = path.posix.dirname(normalized);
  const basename = path.posix.basename(normalized, extension);
  const candidates = new Set();

  const push = (candidate) => {
    if (!candidate) {
      return;
    }
    candidates.add(toPosixPath(candidate));
  };

  if (extension === ".go") {
    push(path.posix.join(dirname, `${basename}_test.go`));
    push(path.posix.join("tests", dirname, `${basename}_test.go`));
  } else if (extension === ".py") {
    push(path.posix.join(dirname, `test_${basename}.py`));
    push(path.posix.join(dirname, `${basename}_test.py`));
    push(path.posix.join("tests", dirname, `test_${basename}.py`));
  } else {
    push(path.posix.join(dirname, `${basename}.test${extension}`));
    push(path.posix.join(dirname, `${basename}.spec${extension}`));
    push(path.posix.join(dirname, "__tests__", `${basename}.test${extension}`));
    push(path.posix.join(dirname, "__tests__", `${basename}.spec${extension}`));
    push(path.posix.join("tests", dirname, `${basename}.test${extension}`));
    push(path.posix.join("tests", dirname, `${basename}.spec${extension}`));
  }

  return Array.from(candidates);
}

function normalizeChangedFiles(entries = []) {
  return entries
    .map((entry) => String(entry?.path ?? "").trim())
    .filter(Boolean)
    .map((item) => toPosixPath(item));
}

export default {
  name: "reviewer_test_gap_scan",
  description:
    "Inspect changed source files and infer nearby test coverage candidates to surface likely test gaps.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional scope path (relative to workspace or absolute).",
        default: "."
      },
      maxResults: {
        type: "integer",
        description: "Max uncovered source files returned.",
        default: 120
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const workspaceCwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(workspaceCwd);
    const scopePath = resolveTargetPath(workspaceCwd, args.path);
    const scopeStats = await fs.stat(scopePath);
    const maxResults = normalizePositiveInteger(args.maxResults, 120, 1, 2000);

    const gitCheck = await runShellCommand({
      command: "git rev-parse --is-inside-work-tree",
      cwd: workspaceCwd,
      timeoutMs: 8000,
      maxOutputChars: 1000
    });
    if (!gitCheck.ok || gitCheck.stdout.toLowerCase() !== "true") {
      return {
        isGitRepo: false,
        scopePath,
        reason: "not a git repository"
      };
    }

    const statusRun = await runShellCommand({
      command: "git status --porcelain",
      cwd: workspaceCwd,
      timeoutMs: 15000,
      maxOutputChars: 25000
    });
    if (!statusRun.ok) {
      return {
        isGitRepo: true,
        scopePath,
        reason: statusRun.stderr || "failed to read git status"
      };
    }

    const changedEntries = parseGitPorcelain(statusRun.stdout);
    const changedFiles = normalizeChangedFiles(changedEntries);
    const scopedFiles = [];
    for (const relativePath of changedFiles) {
      const absolutePath = path.resolve(workspaceCwd, relativePath);
      if (scopeStats.isFile()) {
        if (path.resolve(scopePath) !== absolutePath) {
          continue;
        }
      } else {
        const relToScope = path.relative(scopePath, absolutePath);
        const within = relToScope === "" || (!relToScope.startsWith("..") && !path.isAbsolute(relToScope));
        if (!within) {
          continue;
        }
      }
      scopedFiles.push(relativePath);
    }

    const changedSourceFiles = scopedFiles.filter((item) => isSourceFile(item));
    const changedTestFiles = scopedFiles.filter((item) => isTestFile(item));
    const changedTestSet = new Set(changedTestFiles);

    const coverage = [];
    for (const sourceFile of changedSourceFiles) {
      const inferredCandidates = inferCandidateTests(sourceFile);
      const existingCandidates = [];
      const missingCandidates = [];

      for (const candidate of inferredCandidates) {
        const absoluteCandidate = path.resolve(workspaceCwd, candidate);
        if (await fileExists(absoluteCandidate)) {
          existingCandidates.push(candidate);
        } else {
          missingCandidates.push(candidate);
        }
      }

      const relatedChangedTests = inferredCandidates.filter((candidate) => changedTestSet.has(candidate));

      coverage.push({
        sourceFile,
        existingCandidateTests: existingCandidates,
        relatedChangedTests,
        missingCandidateTests: missingCandidates,
        hasRelatedTests: existingCandidates.length > 0 || relatedChangedTests.length > 0
      });
    }

    const uncovered = coverage.filter((item) => !item.hasRelatedTests).slice(0, maxResults);

    return {
      isGitRepo: true,
      scopePath,
      summary: {
        changedFileCount: scopedFiles.length,
        changedSourceCount: changedSourceFiles.length,
        changedTestCount: changedTestFiles.length,
        uncoveredSourceCount: uncovered.length
      },
      uncoveredSources: uncovered,
      changedTestFiles
    };
  }
};
