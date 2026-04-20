import path from "node:path";

import {
  clipText,
  ensureDirectory,
  normalizePositiveInteger,
  resolveContextWorkingDirectory,
  runShellCommand
} from "../../tools/privateToolShared.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function sanitizeGitRef(value, fallback = "HEAD") {
  const ref = normalizeText(value) || fallback;
  if (!/^[A-Za-z0-9._:/@-]+$/.test(ref)) {
    throw new Error("baseRef contains unsupported characters");
  }
  return ref;
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

      const indexStatus = statusCode[0] ?? " ";
      const worktreeStatus = statusCode[1] ?? " ";

      return {
        path: filePath,
        statusCode,
        indexStatus,
        worktreeStatus,
        isUntracked: statusCode === "??",
        isRenamed: indexStatus === "R" || worktreeStatus === "R"
      };
    })
    .filter(Boolean);
}

function parseNumstat(text = "") {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) {
        return null;
      }

      const additions = Number.parseInt(parts[0], 10);
      const deletions = Number.parseInt(parts[1], 10);
      const rawPath = parts.slice(2).join("\t");
      const filePath = rawPath.includes(" => ")
        ? rawPath.split(" => ").pop().replace(/[{}]/g, "")
        : rawPath;

      return {
        path: filePath.trim(),
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null
      };
    })
    .filter(Boolean);
}

function buildTopDirectories(filePaths = [], limit = 8) {
  const counter = new Map();
  for (const filePath of filePaths) {
    const normalized = String(filePath ?? "").replace(/\\/g, "/");
    const dir = normalized.includes("/") ? normalized.split("/")[0] : "(root)";
    counter.set(dir, (counter.get(dir) ?? 0) + 1);
  }

  return Array.from(counter.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([directory, fileCount]) => ({ directory, fileCount }));
}

export default {
  name: "builder_workspace_delta",
  description:
    "Analyze current workspace code delta with git status + numstat and return a structured implementation scope summary.",
  parameters: {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Optional absolute workspace path."
      },
      baseRef: {
        type: "string",
        description: "Git base ref for diff, default HEAD."
      },
      includePatchPreview: {
        type: "boolean",
        description: "Include clipped diff preview.",
        default: false
      },
      maxPatchChars: {
        type: "integer",
        description: "Max chars for patch preview (when enabled).",
        default: 2800
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const cwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(cwd);

    const gitCheck = await runShellCommand({
      command: "git rev-parse --is-inside-work-tree",
      cwd,
      timeoutMs: 8000,
      maxOutputChars: 1200
    });
    if (!gitCheck.ok || gitCheck.stdout.toLowerCase() !== "true") {
      return {
        cwd,
        isGitRepo: false,
        reason: clipText(gitCheck.stderr || "not a git repository", 400)
      };
    }

    const baseRef = sanitizeGitRef(args.baseRef, "HEAD");
    const statusRun = await runShellCommand({
      command: "git status --porcelain",
      cwd,
      timeoutMs: 15000
    });
    const statusEntries = parseGitPorcelain(statusRun.stdout);

    const numstatRun = await runShellCommand({
      command: `git diff --numstat ${baseRef}`,
      cwd,
      timeoutMs: 20000,
      maxOutputChars: 30000
    });
    const numstatEntries = numstatRun.ok ? parseNumstat(numstatRun.stdout) : [];
    const numstatMap = new Map(numstatEntries.map((entry) => [entry.path, entry]));

    const mergedPathSet = new Set([
      ...statusEntries.map((entry) => entry.path),
      ...numstatEntries.map((entry) => entry.path)
    ]);
    const changedFiles = Array.from(mergedPathSet)
      .sort((left, right) => left.localeCompare(right))
      .map((relativePath) => {
        const statusEntry = statusEntries.find((entry) => entry.path === relativePath) ?? null;
        const numstatEntry = numstatMap.get(relativePath) ?? null;
        return {
          relativePath: relativePath.replace(/\\/g, "/"),
          absolutePath: path.resolve(cwd, relativePath),
          statusCode: statusEntry?.statusCode ?? "",
          additions: numstatEntry?.additions ?? null,
          deletions: numstatEntry?.deletions ?? null
        };
      });

    const stagedCount = statusEntries.filter((entry) =>
      entry.indexStatus !== " " && entry.indexStatus !== "?"
    ).length;
    const unstagedCount = statusEntries.filter((entry) =>
      entry.worktreeStatus !== " " && entry.worktreeStatus !== "?"
    ).length;
    const untrackedCount = statusEntries.filter((entry) => entry.isUntracked).length;
    const topDirectories = buildTopDirectories(changedFiles.map((item) => item.relativePath));
    const includePatchPreview = Boolean(args.includePatchPreview);
    const maxPatchChars = normalizePositiveInteger(args.maxPatchChars, 2800, 600, 10000);

    let patchPreview = "";
    if (includePatchPreview) {
      const patchRun = await runShellCommand({
        command: `git diff --unified=1 ${baseRef}`,
        cwd,
        timeoutMs: 30000,
        maxOutputChars: Math.max(4000, maxPatchChars * 2)
      });
      patchPreview = clipText(patchRun.stdout || patchRun.stderr, maxPatchChars);
    }

    return {
      cwd,
      isGitRepo: true,
      baseRef,
      summary: {
        totalChangedFiles: changedFiles.length,
        stagedCount,
        unstagedCount,
        untrackedCount
      },
      topDirectories,
      changedFiles,
      patchPreview
    };
  }
};
