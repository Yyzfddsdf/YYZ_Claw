import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_CAPTURED_OUTPUT = 12000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;

function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";

  return candidate ? path.resolve(candidate) : process.cwd();
}

async function ensureDirectory(dirPath) {
  const stats = await fs.stat(dirPath);

  if (!stats.isDirectory()) {
    throw new Error("cwd must be a directory");
  }
}

async function getStatsOrNull(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

function resolveTargetPath(rawFilePath, cwd) {
  const candidate = typeof rawFilePath === "string" ? rawFilePath.trim() : "";

  if (!candidate) {
    throw new Error("filePath is required");
  }

  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
}

function appendWithLimit(current, next) {
  if (!next) {
    return current;
  }

  const merged = current + next;
  if (merged.length <= MAX_CAPTURED_OUTPUT) {
    return merged;
  }

  return merged.slice(merged.length - MAX_CAPTURED_OUTPUT);
}

function normalizeTimeoutMs(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1000) {
    return 1000;
  }

  return Math.min(normalized, MAX_TIMEOUT_MS);
}

function isStructuredPatch(patch) {
  const trimmed = patch.trimStart();

  return (
    trimmed.startsWith("*** Begin Patch") ||
    trimmed.startsWith("*** Update File:") ||
    trimmed.startsWith("*** Add File:") ||
    trimmed.startsWith("*** Delete File:")
  );
}

function splitPatchLines(patch) {
  return patch.replace(/\r\n/g, "\n").split("\n");
}

function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function applyLineEnding(text, lineEnding) {
  if (!text) {
    return text;
  }

  return text.replace(/\n/g, lineEnding);
}

function finalizeStructuredBlock(current, blocks) {
  if (!current) {
    return;
  }

  blocks.push(current);
}

function normalizePatchHeaderLine(line) {
  const trimmed = line.trim();

  if (trimmed === "*** Begin Patch ***") {
    return "*** Begin Patch";
  }

  if (trimmed === "*** End Patch ***") {
    return "*** End Patch";
  }

  if (trimmed === "*** End of File ***") {
    return "*** End of File";
  }

  return line;
}

function isPatchHeaderLine(line) {
  return (
    line === "*** Begin Patch" ||
    line === "*** End Patch" ||
    line === "*** End of File" ||
    line.startsWith("*** Update File:") ||
    line.startsWith("*** Add File:") ||
    line.startsWith("*** Delete File:") ||
    line.startsWith("*** Move to:")
  );
}

function assertNoUnifiedDiffHeaderInsideStructuredPatch(line) {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    throw new Error(
      [
        `Unexpected unified diff header inside structured patch: ${line}.`,
        "Do not mix patch formats.",
        "Structured patch format: *** Begin Patch / *** Update File: <path> / @@ / -old / +new / *** End Patch.",
        "Unified diff format: --- a/file / +++ b/file / @@ / -old / +new, without *** Begin Patch or *** End Patch."
      ].join(" ")
    );
  }
}

function assertNoTrailingStarsOnFileHeader(line) {
  const trimmed = line.trim();

  if (
    (trimmed.startsWith("*** Update File:") ||
      trimmed.startsWith("*** Add File:") ||
      trimmed.startsWith("*** Delete File:") ||
      trimmed.startsWith("*** Move to:")) &&
    trimmed.endsWith(" ***")
  ) {
    throw new Error(
      [
        `Invalid structured patch file header: ${line}.`,
        "Only wrapper headers may use trailing stars: *** Begin Patch *** and *** End Patch ***.",
        "File operation headers must not use trailing stars.",
        "Write: *** Update File: <path>",
        "Do not write: *** Update File: <path> ***"
      ].join(" ")
    );
  }
}

function parseStructuredPatch(patch) {
  const lines = splitPatchLines(patch);
  const blocks = [];
  let current = null;
  let currentHunk = null;

  function pushCurrentHunk() {
    if (!current || current.type !== "update" || !currentHunk) {
      return;
    }

    current.hunks.push(currentHunk);
    currentHunk = null;
  }

  for (const rawLine of lines) {
    const line = normalizePatchHeaderLine(rawLine);

    assertNoUnifiedDiffHeaderInsideStructuredPatch(line);
    assertNoTrailingStarsOnFileHeader(line);

    if (isPatchHeaderLine(line)) {
      if (line.startsWith("*** Update File:")) {
        pushCurrentHunk();
        finalizeStructuredBlock(current, blocks);

        current = {
          type: "update",
          filePath: line.slice("*** Update File: ".length).trim(),
          moveTo: "",
          hunks: []
        };
        currentHunk = [];
        continue;
      }

      if (line.startsWith("*** Add File: ")) {
        pushCurrentHunk();
        finalizeStructuredBlock(current, blocks);

        current = {
          type: "add",
          filePath: line.slice("*** Add File: ".length).trim(),
          contentLines: []
        };
        currentHunk = null;
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        pushCurrentHunk();
        finalizeStructuredBlock(current, blocks);

        current = {
          type: "delete",
          filePath: line.slice("*** Delete File: ".length).trim()
        };
        currentHunk = null;
        continue;
      }

      if (line.startsWith("*** Move to: ")) {
        if (!current || current.type !== "update") {
          throw new Error("Move instruction must appear inside an update block.");
        }

        current.moveTo = line.slice("*** Move to: ".length).trim();
        continue;
      }

      continue;
    }

    if (!current) {
      if (line.trim().length === 0) {
        continue;
      }

      throw new Error(
        `Unexpected patch content: ${line}. Structured patches must use headers like "*** Begin Patch", "*** Update File: <path>", and "*** End Patch". Do not use unified diff headers inside structured patches.`
      );
    }

    if (current.type === "add") {
      if (!line.startsWith("+")) {
        throw new Error("Add File lines must start with '+'. The line must begin with '+' followed by a space and the content (e.g., '+ hello'), not '+hello' without the space. Do not omit the space between '+' and the content.");
      }

      current.contentLines.push(line.slice(1));
      continue;
    }

    if (current.type === "update") {
      if (!currentHunk) {
        currentHunk = [];
      }

      currentHunk.push(line);
      continue;
    }

    if (current.type === "delete") {
      if (line.trim().length > 0) {
        throw new Error("Delete File block must not contain body content.");
      }
    }
  }

  pushCurrentHunk();
  finalizeStructuredBlock(current, blocks);

  return blocks;
}

function buildStructuredBlockReplacement(hunkLines) {
  const oldLines = [];
  const newLines = [];

  for (const line of hunkLines) {
    if (line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(" ")) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
      continue;
    }

    if (line.trim().length === 0) {
      oldLines.push("");
      newLines.push("");
      continue;
    }

    throw new Error(
      `Invalid structured patch line: ${line}. Update hunk lines must start with ' ', '+', '-', or '@@'.`
    );
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n")
  };
}

function findUniqueMatchIndex(content, oldText, filePath) {
  const firstIndex = content.indexOf(oldText);

  if (firstIndex < 0) {
    const preview = oldText.slice(0, 240);
    throw new Error(
      `Structured patch context not found in ${filePath}. Missing block starts with: ${JSON.stringify(preview)}`
    );
  }

  const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);

  if (secondIndex >= 0) {
    const preview = oldText.slice(0, 240);
    throw new Error(
      [
        `Structured patch context is ambiguous in ${filePath}.`,
        "The old block appears more than once.",
        `Ambiguous block starts with: ${JSON.stringify(preview)}`,
        "Add more unchanged surrounding context lines to make the match unique."
      ].join(" ")
    );
  }

  return firstIndex;
}

async function writeUtf8File(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: "utf8" });
}

async function applyStructuredPatchBlock(block, cwd, checkOnly) {
  const resolvedFilePath = path.isAbsolute(block.filePath)
    ? path.resolve(block.filePath)
    : resolveTargetPath(block.filePath, cwd);

  if (block.type === "delete") {
    const stats = await getStatsOrNull(resolvedFilePath);
    if (!stats) {
      throw new Error(`Delete target not found: ${resolvedFilePath}`);
    }

    if (stats.isDirectory()) {
      throw new Error(`Delete target is a directory: ${resolvedFilePath}`);
    }

    if (!checkOnly) {
      await fs.unlink(resolvedFilePath);
    }

    return {
      filePath: resolvedFilePath,
      operation: "delete"
    };
  }

  if (block.type === "add") {
    const stats = await getStatsOrNull(resolvedFilePath);
    if (stats) {
      throw new Error(`Add target already exists: ${resolvedFilePath}`);
    }

    const content = block.contentLines.join("\n");

    if (!checkOnly) {
      await fs.mkdir(path.dirname(resolvedFilePath), { recursive: true });
      await writeUtf8File(resolvedFilePath, content);
    }

    return {
      filePath: resolvedFilePath,
      operation: "add"
    };
  }

  if (block.type !== "update") {
    throw new Error(`Unsupported structured patch block: ${block.type}`);
  }

  const sourceStats = await getStatsOrNull(resolvedFilePath);
  if (!sourceStats) {
    throw new Error(`Update target not found: ${resolvedFilePath}`);
  }

  if (sourceStats.isDirectory()) {
    throw new Error(`Update target is a directory: ${resolvedFilePath}`);
  }

  const currentContent = await fs.readFile(resolvedFilePath, "utf8");
  const lineEnding = detectLineEnding(currentContent);

  if (!Array.isArray(block.hunks) || block.hunks.length === 0) {
    if (!block.moveTo) {
      return {
        filePath: resolvedFilePath,
        operation: "update",
        changed: false
      };
    }
  }

  let nextContent = currentContent;

  for (const hunk of block.hunks ?? []) {
    const replacement = buildStructuredBlockReplacement(hunk);

    const oldText = applyLineEnding(replacement.oldText, lineEnding);
    const newText = applyLineEnding(replacement.newText, lineEnding);

    if (oldText.length === 0 && newText.length === 0) {
      continue;
    }

    if (oldText.length === 0 && newText.length > 0) {
      nextContent = newText + nextContent;
      continue;
    }

    const matchIndex = findUniqueMatchIndex(
      nextContent,
      oldText,
      resolvedFilePath
    );

    nextContent =
      nextContent.slice(0, matchIndex) +
      newText +
      nextContent.slice(matchIndex + oldText.length);
  }

  if (nextContent === currentContent && !block.moveTo) {
    return {
      filePath: resolvedFilePath,
      operation: "update",
      changed: false
    };
  }

  const targetPath = block.moveTo
    ? path.isAbsolute(block.moveTo)
      ? path.resolve(block.moveTo)
      : resolveTargetPath(block.moveTo, cwd)
    : resolvedFilePath;

  if (block.moveTo) {
    const targetStats = await getStatsOrNull(targetPath);
    if (targetStats) {
      throw new Error(`Move target already exists: ${targetPath}`);
    }
  }

  if (!checkOnly) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await writeUtf8File(targetPath, nextContent);

    if (targetPath !== resolvedFilePath) {
      await fs.unlink(resolvedFilePath);
    }
  }

  return {
    filePath: resolvedFilePath,
    targetFilePath: targetPath,
    operation: block.moveTo ? "move_update" : "update",
    changed: true
  };
}

async function applyStructuredPatch({ patch, cwd, checkOnly }) {
  const blocks = parseStructuredPatch(patch);
  const results = [];

  for (const block of blocks) {
    if (!block.filePath) {
      throw new Error("Structured patch block is missing file path.");
    }

    const result = await applyStructuredPatchBlock(block, cwd, checkOnly);
    results.push(result);
  }

  return {
    mode: "structured",
    results
  };
}

function runGitApply({ cwd, patch, checkOnly, timeoutMs }) {
  const gitArgs = [
    "-C",
    cwd,
    "apply",
    "--no-index",
    "--recount",
    "--whitespace=nowarn",
    "--unsafe-paths"
  ];

  if (checkOnly) {
    gitArgs.push("--check");
  }

  gitArgs.push("-");

  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs, {
      cwd,
      env: process.env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout = appendWithLimit(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);

      resolve({
        exitCode: Number(exitCode ?? -1),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut
      });
    });

    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(patch);
    child.stdin.end();
  });
}

function buildGitApplyError(result) {
  return [
    `git apply failed with code ${result.exitCode}.`,
    result.stderr ? `STDERR:\n${result.stderr}` : "",
    result.stdout ? `STDOUT:\n${result.stdout}` : "",
    "Use exactly one patch format. For structured patches, use '*** Begin Patch', '*** Update File: <path>', and '*** End Patch'. For unified diff patches, do not wrap them with structured patch headers."
  ]
    .filter(Boolean)
    .join("\n");
}

export default {
  name: "Edit",
  description:
    "Apply an OpenAI apply_patch-style structured patch or a standard unified diff patch to modify files. Use checkOnly=true to validate without writing files.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Patch text. Choose exactly one format and never mix formats. Format 1: apply_patch-style structured patch. It may use wrapper headers '*** Begin Patch' / '*** End Patch' or tolerated trailing-star wrapper headers '*** Begin Patch ***' / '*** End Patch ***'. Structured patches must use file operation headers such as '*** Update File: <path>', '*** Add File: <path>', or '*** Delete File: <path>'. File operation headers must not use trailing stars: write '*** Update File: <path>', not '*** Update File: <path> ***'. Structured patch update hunks may use '@@' as a visual separator, followed by lines starting with ' ' for unchanged context, '-' for removed lines, and '+' for added lines. Do not put unified-diff headers like '--- a/file' or '+++ b/file' inside a structured patch. Format 2: standard unified diff. Unified diff patches must use '--- a/file', '+++ b/file', and '@@' hunks, and must not be wrapped with '*** Begin Patch' or '*** End Patch'."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for applying patch. Defaults to current conversation workplace."
      },
      checkOnly: {
        type: "boolean",
        description: "When true, only validates patch without writing files."
      },
      timeoutMs: {
        type: "integer",
        description: "Optional timeout in milliseconds, clamped to 1000-300000."
      }
    },
    required: ["patch"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const patch = typeof args.patch === "string" ? args.patch : "";

    if (!patch.trim()) {
      throw new Error("patch is required");
    }

    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    await ensureDirectory(cwd);

    const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
    const checkOnly = Boolean(args.checkOnly);

    if (isStructuredPatch(patch)) {
      try {
        const structuredResult = await applyStructuredPatch({
          patch,
          cwd,
          checkOnly
        });

        return {
          cwd,
          checkOnly,
          applied: !checkOnly,
          mode: structuredResult.mode,
          results: structuredResult.results
        };
      } catch (error) {
        throw new Error(
          [
            `Structured patch failed: ${error?.message || "unknown error"}`,
            "Suggestion: use exactly one patch format. For structured patches, use *** Update File: <path> and do not include ---/+++ unified diff headers. Do not add trailing stars to file operation headers. For unified diff patches, do not wrap them with *** Begin Patch. Re-read the target file and keep the patch block smaller."
          ].join("\n")
        );
      }
    }

    const result = await runGitApply({
      cwd,
      patch,
      checkOnly,
      timeoutMs
    });

    if (result.timedOut) {
      throw new Error(`git apply timed out after ${timeoutMs}ms.`);
    }

    if (result.exitCode !== 0) {
      throw new Error(buildGitApplyError(result));
    }

    return {
      cwd,
      checkOnly,
      applied: !checkOnly,
      mode: "git",
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
};