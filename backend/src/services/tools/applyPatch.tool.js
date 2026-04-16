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

  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }

  return path.resolve(cwd, candidate);
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
  return patch.trimStart().startsWith("*** Begin Patch");
}

function stripStructuredPrefix(line) {
  if (line.startsWith("+")) {
    return line.slice(1);
  }

  if (line.startsWith("-")) {
    return line.slice(1);
  }

  if (line.startsWith(" ")) {
    return line.slice(1);
  }

  return line;
}

function splitPatchLines(patch) {
  return patch.replace(/\r\n/g, "\n").split("\n");
}

function finalizeStructuredBlock(current, blocks) {
  if (!current) {
    return;
  }

  blocks.push(current);
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
    const line = rawLine;

    if (
      line === "*** Begin Patch" ||
      line === "*** End Patch" ||
      line === "*** End of File"
    ) {
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      finalizeStructuredBlock(current, blocks);
      current = {
        type: "add",
        filePath: line.slice("*** Add File: ".length).trim(),
        contentLines: []
      };
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      finalizeStructuredBlock(current, blocks);
      current = {
        type: "delete",
        filePath: line.slice("*** Delete File: ".length).trim()
      };
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
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

    if (line.startsWith("*** Move to: ")) {
      if (!current || current.type !== "update") {
        throw new Error("Move instruction must appear inside an update block.");
      }

      current.moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current || current.type !== "update") {
        continue;
      }

      pushCurrentHunk();
      currentHunk = [];
      continue;
    }

    if (!current) {
      if (line.trim().length === 0) {
        continue;
      }

      throw new Error(`Unexpected patch content: ${line}`);
    }

    if (current.type === "add") {
      if (!line.startsWith("+")) {
        throw new Error("Add File lines must start with '+'.");
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
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n")
  };
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
    const oldText = replacement.oldText;
    const newText = replacement.newText;

    if (oldText.length === 0 && newText.length === 0) {
      continue;
    }

    if (oldText.length === 0 && newText.length > 0) {
      nextContent = newText + nextContent;
      continue;
    }

    const matchIndex = nextContent.indexOf(oldText);
    if (matchIndex < 0) {
      const preview = oldText.slice(0, 240);
      throw new Error(
        `Structured patch context not found in ${resolvedFilePath}. Missing block starts with: ${JSON.stringify(preview)}`
      );
    }

    nextContent =
      nextContent.slice(0, matchIndex) + newText + nextContent.slice(matchIndex + oldText.length);
  }

  if (nextContent === currentContent && !block.moveTo) {
    return {
      filePath: resolvedFilePath,
      operation: "update",
      changed: false
    };
  }

  const targetPath = block.moveTo
    ? (path.isAbsolute(block.moveTo) ? path.resolve(block.moveTo) : resolveTargetPath(block.moveTo, cwd))
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

function buildGitApplyError(result, timeoutMs) {
  return [
    `git apply failed with code ${result.exitCode}.`,
    result.stderr ? `STDERR:\n${result.stderr}` : "",
    result.stdout ? `STDOUT:\n${result.stdout}` : "",
    "If this was meant to be a structured patch, use *** Begin Patch / *** Update File syntax or read the target file first."
  ]
    .filter(Boolean)
    .join("\n");
}

export default {
  name: "apply_patch",
  description:
    "Apply either a structured patch block or a unified diff patch to files. Use checkOnly=true to validate without writing files.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Structured patch text starting with *** Begin Patch, or a unified diff patch."
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
        description: "Optional timeout in milliseconds (1000-300000)."
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
            "Suggestion: re-read the target file and keep the patch block smaller."
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
      throw new Error(buildGitApplyError(result, timeoutMs));
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
