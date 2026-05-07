import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import { applyModelProfileToRuntimeConfig, resolveModelProfile } from "../config/modelProfileConfig.js";
import { runModelProviderStream } from "../modelProviders/runtime.js";
import { resolveWorkspacePath } from "./workspacePath.js";

const DEFAULT_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PROMPT_CHARS = 120_000;
const DEFAULT_MAX_FILE_CHARS = 8_000;
const DEFAULT_COMMIT_MAX_TOKENS = 512;

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function clipText(text, maxChars = DEFAULT_MAX_FILE_CHARS) {
  const source = String(text ?? "");
  if (source.length <= maxChars) {
    return source;
  }

  const headChars = Math.max(1600, Math.floor(maxChars * 0.72));
  const tailChars = Math.max(400, Math.floor(maxChars * 0.12));
  return `${source.slice(0, headChars)}\n...[truncated]...\n${source.slice(-tailChars)}`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        ...(options.env
          ? {
              env: {
                ...process.env,
                ...options.env
              }
            }
          : {})
      },
      (error, stdout, stderr) => {
        resolve({
          error: error ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: Number(error?.code ?? 0)
        });
      }
    );
  });
}

function parseAheadBehind(text = "") {
  const normalized = normalizeText(text);
  const result = { ahead: 0, behind: 0 };
  if (!normalized) {
    return result;
  }

  for (const token of normalized.split(",")) {
    const cleaned = normalizeText(token);
    const aheadMatch = cleaned.match(/ahead\s+(\d+)/i);
    const behindMatch = cleaned.match(/behind\s+(\d+)/i);
    if (aheadMatch) {
      result.ahead = Number(aheadMatch[1] ?? 0);
    }
    if (behindMatch) {
      result.behind = Number(behindMatch[1] ?? 0);
    }
  }

  return result;
}

function parseStatusBranchLine(line, state) {
  const text = normalizeText(line.slice(3));
  if (!text) {
    return;
  }

  if (text.startsWith("HEAD (no branch)") || text.startsWith("HEAD (detached")) {
    state.detachedHead = true;
    state.currentBranch = "";
    state.branchSummary = text;
    return;
  }

  if (text.startsWith("No commits yet on ")) {
    state.currentBranch = normalizeText(text.replace(/^No commits yet on /i, ""));
    state.branchSummary = text;
    return;
  }

  const match = text.match(/^(.*?)\.\.\.(.*?)(?:\s+\[(.+)\])?$/);
  if (match) {
    state.currentBranch = normalizeText(match[1]);
    state.upstream = normalizeText(match[2]);
    const counts = parseAheadBehind(match[3] ?? "");
    state.ahead = counts.ahead;
    state.behind = counts.behind;
    return;
  }

  state.currentBranch = text;
}

function parseGitStatusLine(line) {
  const statusCode = String(line.slice(0, 2));
  if (statusCode === "!!") {
    return null;
  }

  if (statusCode === "??") {
    const pathValue = normalizeText(line.slice(3));
    return {
      path: pathValue,
      displayPath: pathValue,
      previousPath: "",
      statusCode,
      indexStatus: "?",
      worktreeStatus: "?",
      staged: false,
      untracked: true,
      renamed: false,
      copied: false,
      changeKind: "untracked"
    };
  }

  const indexStatus = statusCode[0] ?? " ";
  const worktreeStatus = statusCode[1] ?? " ";
  const rawPath = normalizeText(line.slice(3));
  const renameMatch = rawPath.match(/^(.*)\s+->\s+(.*)$/);
  const previousPath = renameMatch ? normalizeText(renameMatch[1]) : "";
  const pathValue = renameMatch ? normalizeText(renameMatch[2]) : rawPath;
  const renamed = Boolean(previousPath);
  const copied = statusCode.includes("C");
  const staged = ![" ", "?", "!"].includes(indexStatus);

  let changeKind = "modified";
  if (renamed) {
    changeKind = "renamed";
  } else if (copied) {
    changeKind = "copied";
  } else if (indexStatus === "A" || worktreeStatus === "A") {
    changeKind = "added";
  } else if (indexStatus === "D" || worktreeStatus === "D") {
    changeKind = "deleted";
  } else if (indexStatus === "R" || worktreeStatus === "R") {
    changeKind = "renamed";
  }

  return {
    path: pathValue,
    displayPath: pathValue,
    previousPath,
    statusCode,
    indexStatus,
    worktreeStatus,
    staged,
    untracked: false,
    renamed,
    copied,
    changeKind
  };
}

function sortStatusEntries(left, right) {
  const leftPriority = left.staged ? 0 : left.untracked ? 1 : left.changeKind === "deleted" ? 2 : 3;
  const rightPriority = right.staged ? 0 : right.untracked ? 1 : right.changeKind === "deleted" ? 2 : 3;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.path.localeCompare(right.path, "zh-CN");
}

function normalizeRelativeGitPath(inputPath = "") {
  return normalizeText(inputPath).replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizePathList(paths = []) {
  const seen = new Set();
  const normalized = [];

  for (const item of Array.isArray(paths) ? paths : []) {
    const nextPath = normalizeRelativeGitPath(item);
    if (!nextPath || seen.has(nextPath)) {
      continue;
    }
    seen.add(nextPath);
    normalized.push(nextPath);
  }

  return normalized;
}

function extractStreamChunkText(chunk) {
  const choice = chunk?.choices?.[0] ?? null;
  const delta = choice?.delta ?? null;
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    return delta.content;
  }

  if (typeof chunk?.content === "string" && chunk.content.length > 0) {
    return chunk.content;
  }

  if (typeof chunk?.text === "string" && chunk.text.length > 0) {
    return chunk.text;
  }

  return "";
}

function buildDiffPromptEntry(entry) {
  const beforeHeader = entry.previousPath && entry.previousPath !== entry.path
    ? `${entry.previousPath} -> ${entry.path}`
    : entry.path;
  const beforeContent = clipText(String(entry.beforeContent ?? ""), DEFAULT_MAX_FILE_CHARS);
  const afterContent = clipText(String(entry.afterContent ?? ""), DEFAULT_MAX_FILE_CHARS);

  return [
    `### ${beforeHeader}`,
    `status: ${entry.changeKind}`,
    "",
    "<before>",
    beforeContent || "(empty)",
    "</before>",
    "",
    "<after>",
    afterContent || "(empty)",
    "</after>"
  ].join("\n");
}

function buildCommitSystemPrompt() {
  return [
    "You are a git commit message generator.",
    "Follow conventional commit format strictly.",
    "Always output plain text only.",
    "The first line must start with a conventional prefix such as feat, fix, refactor, chore, docs, style, test, perf, build, ci, or revert.",
    "Use a short imperative subject line.",
    "If the diff suggests a feature addition, prefer feat.",
    "If the diff suggests a behavior fix, prefer fix.",
    "Do not wrap the result in markdown fences, quotes, or code blocks.",
    "Do not explain your reasoning.",
    "Do not output anything except the commit message."
  ].join(" ");
}

function buildCommitUserPrompt({ rootDir, branch, stagedFiles, diffEntries }) {
  const stagedList = stagedFiles.length > 0
    ? stagedFiles.map((item) => `- ${item}`).join("\n")
    : "- (none)";
  const diffList = diffEntries.length > 0
    ? diffEntries.map((entry) => buildDiffPromptEntry(entry)).join("\n\n")
    : "(none)";

  return [
    "Write a git commit message for the following workspace diff.",
    "Output plain text only.",
    "The first line must be a conventional commit header such as feat, fix, refactor, chore, docs, style, test, perf, build, ci, or revert.",
    "Keep the subject short, concrete, and imperative.",
    "If the change adds a feature, prefer feat.",
    "If the change fixes behavior, prefer fix.",
    "You may add one blank line and a short bullet body.",
    "Do not use markdown fences.",
    "",
    `Repository root: ${rootDir}`,
    `Current branch: ${branch || "(detached or unborn)"}`,
    "",
    "Staged files:",
    stagedList,
    "",
    "Diff entries:",
    diffList
  ].join("\n");
}

function parseNumStatOutput(output = "") {
  const files = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^(\-|\d+)\t(\-|\d+)\t(.+)$/);
    if (!match) {
      continue;
    }

    const additions = match[1] === "-" ? 0 : Number(match[1]) || 0;
    const removals = match[2] === "-" ? 0 : Number(match[2]) || 0;
    const filePath = normalizeText(match[3]);
    if (!filePath) {
      continue;
    }

    insertions += additions;
    deletions += removals;
    files.push({
      path: filePath,
      insertions: additions,
      deletions: removals
    });
  }

  return {
    insertions,
    deletions,
    files
  };
}

function parseCommitNameStatusOutput(output = "") {
  const files = [];

  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const parts = line.split("\t");
    const statusCode = normalizeText(parts[0]);
    if (!statusCode) {
      continue;
    }

    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const previousPath = normalizeText(parts[1]);
      const pathValue = normalizeText(parts[2]);
      if (!pathValue) {
        continue;
      }

      files.push({
        path: pathValue,
        previousPath,
        statusCode,
        changeKind: statusCode.startsWith("R") ? "renamed" : "copied"
      });
      continue;
    }

    const pathValue = normalizeText(parts[1]);
    if (!pathValue) {
      continue;
    }

    let changeKind = "modified";
    if (statusCode === "A") {
      changeKind = "added";
    } else if (statusCode === "D") {
      changeKind = "deleted";
    } else if (statusCode === "M") {
      changeKind = "modified";
    }

    files.push({
      path: pathValue,
      previousPath: "",
      statusCode,
      changeKind
    });
  }

  return files;
}

function parseLogDecorations(decorations = "", currentBranch = "") {
  const refs = [];
  const seen = new Set();
  let headBranch = "";

  for (const rawToken of String(decorations ?? "").split(",")) {
    const token = normalizeText(rawToken);
    if (!token || token === "HEAD") {
      continue;
    }

    let text = token;
    let tone = token.includes("/") ? "remote" : "local";

    if (token.startsWith("HEAD -> ")) {
      text = normalizeText(token.replace(/^HEAD -> /, ""));
      tone = "current";
      headBranch = text;
    } else if (token.startsWith("origin/HEAD -> ")) {
      continue;
    } else if (token.startsWith("tag: ")) {
      text = normalizeText(token.replace(/^tag:\s*/, ""));
      tone = "tag";
    } else if (token.includes(" -> ")) {
      const rightSide = normalizeText(token.slice(token.indexOf("->") + 2));
      if (rightSide.endsWith("/HEAD") || rightSide === "HEAD") {
        continue;
      }
      text = rightSide || token;
      tone = text.includes("/") ? "remote" : "local";
    }

    if (!text) {
      continue;
    }

    const key = text;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ text, tone });
  }

  return {
    refs,
    headBranch
  };
}

function buildLeadMeta(ahead = 0, behind = 0) {
  const normalizedAhead = Number(ahead) || 0;
  const normalizedBehind = Number(behind) || 0;

  if (normalizedAhead > normalizedBehind && normalizedAhead > 0) {
    return {
      label: `本地领先 ↑${normalizedAhead}`,
      tone: "local"
    };
  }

  if (normalizedBehind > normalizedAhead && normalizedBehind > 0) {
    return {
      label: `远程领先 ↓${normalizedBehind}`,
      tone: "remote"
    };
  }

  return {
    label: "同步",
    tone: "sync"
  };
}

async function readTextFilePreview(filePath, maxBytes = DEFAULT_MAX_PREVIEW_BYTES) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return {
      content: "",
      size: 0,
      truncated: false
    };
  }

  if (stat.size > maxBytes) {
    return {
      content: "[文件过大，暂不预览]",
      size: stat.size,
      truncated: true
    };
  }

  const content = await fs.readFile(filePath, "utf8");
  return {
    content,
    size: stat.size,
    truncated: false
  };
}

async function readGitBlobPreviewAtRef(rootDir, ref, relativePath, maxBytes = DEFAULT_MAX_PREVIEW_BYTES) {
  const normalizedPath = normalizeRelativeGitPath(relativePath);
  if (!normalizedPath) {
    return {
      content: "",
      size: 0,
      truncated: false
    };
  }

  const result = await runCommand(
    "git",
    ["show", `${normalizeText(ref || "HEAD")}:${normalizedPath}`],
    {
      cwd: rootDir,
      maxBuffer: maxBytes + 512 * 1024
    }
  );

  if (result.error) {
    return {
      content: "",
      size: 0,
      truncated: false
    };
  }

  const content = String(result.stdout ?? "");
  return {
    content: content.length > maxBytes ? clipText(content, maxBytes) : content,
    size: content.length,
    truncated: content.length > maxBytes
  };
}

async function readGitBlobPreview(rootDir, relativePath, maxBytes = DEFAULT_MAX_PREVIEW_BYTES) {
  return readGitBlobPreviewAtRef(rootDir, "HEAD", relativePath, maxBytes);
}

async function readGitConfigValue(rootDir, key) {
  const result = await runCommand("git", ["config", "--get", key], { cwd: rootDir });
  return result.error ? "" : normalizeText(result.stdout);
}

export class WorkspaceGitService {
  constructor(options = {}) {
    this.configStore = options.configStore ?? null;
    this.gitAvailablePromise = null;
  }

  async isGitAvailable() {
    if (!this.gitAvailablePromise) {
      this.gitAvailablePromise = runCommand("git", ["--version"]).then((result) => !result.error);
    }

    return this.gitAvailablePromise;
  }

  async isRepository(rootDir) {
    const available = await this.isGitAvailable();
    if (!available) {
      return false;
    }

    const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootDir
    });
    if (result.error) {
      return false;
    }

    return normalizeText(result.stdout).toLowerCase() === "true";
  }

  async readStatusState(rootDir) {
    const gitAvailable = await this.isGitAvailable();
    if (!gitAvailable) {
      return {
        gitAvailable: false,
        isRepo: false,
        root: rootDir,
        currentBranch: "",
        detachedHead: false,
        branchSummary: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        remoteNames: [],
        files: [],
        stagedPaths: [],
        dirtyPaths: [],
        stagedCount: 0,
        dirtyCount: 0,
        untrackedCount: 0,
        canPush: false,
        headCommit: "",
        gitUserName: "",
        gitUserEmail: ""
      };
    }

    const isRepo = await this.isRepository(rootDir);
    if (!isRepo) {
      return {
        gitAvailable: true,
        isRepo: false,
        root: rootDir,
        currentBranch: "",
        detachedHead: false,
        branchSummary: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        remoteNames: [],
        files: [],
        stagedPaths: [],
        dirtyPaths: [],
        stagedCount: 0,
        dirtyCount: 0,
        untrackedCount: 0,
        canPush: false,
        headCommit: "",
        gitUserName: "",
        gitUserEmail: ""
      };
    }

    const statusResult = await runCommand(
      "git",
      ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
      {
        cwd: rootDir
      }
    );

    if (statusResult.error) {
      const error = new Error(statusResult.stderr || statusResult.error.message || "git status failed");
      error.statusCode = 500;
      throw error;
    }

    const state = {
      gitAvailable: true,
      isRepo: true,
      root: rootDir,
      currentBranch: "",
      detachedHead: false,
      branchSummary: "",
      upstream: "",
      ahead: 0,
      behind: 0,
      remoteNames: [],
      files: [],
      stagedPaths: [],
      dirtyPaths: [],
      stagedCount: 0,
      dirtyCount: 0,
      untrackedCount: 0,
      canPush: false,
      headCommit: "",
      gitUserName: "",
      gitUserEmail: ""
    };

    for (const line of String(statusResult.stdout ?? "").split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      if (line.startsWith("## ")) {
        parseStatusBranchLine(line, state);
        continue;
      }

      const entry = parseGitStatusLine(line);
      if (entry) {
        state.files.push(entry);
      }
    }

    state.files.sort(sortStatusEntries);
    state.stagedPaths = state.files.filter((entry) => entry.staged).map((entry) => entry.path);
    state.dirtyPaths = state.files.map((entry) => entry.path);
    state.stagedCount = state.stagedPaths.length;
    state.dirtyCount = state.files.length;
    state.untrackedCount = state.files.filter((entry) => entry.untracked).length;

    const remoteResult = await runCommand("git", ["remote"], { cwd: rootDir });
    state.remoteNames = remoteResult.error
      ? []
      : String(remoteResult.stdout ?? "")
          .split(/\r?\n/)
          .map((item) => normalizeText(item))
          .filter(Boolean);

    const headCommitResult = await runCommand("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir
    });
    state.headCommit = headCommitResult.error ? "" : normalizeText(headCommitResult.stdout);
    state.gitUserName = await readGitConfigValue(rootDir, "user.name");
    state.gitUserEmail = await readGitConfigValue(rootDir, "user.email");
    state.canPush = Boolean(
      !state.detachedHead && state.ahead > 0 && state.remoteNames.length > 0
    );

    return state;
  }

  async readBranchState(rootDir) {
    const gitAvailable = await this.isGitAvailable();
    if (!gitAvailable) {
      return {
        localBranches: [],
        remoteBranches: []
      };
    }

    const localBranchesResult = await runCommand(
      "git",
      ["for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:short)\t%(objectname:short)\t%(subject)"],
      { cwd: rootDir }
    );
    const remoteBranchesResult = await runCommand(
      "git",
      ["for-each-ref", "refs/remotes", "--format=%(refname:short)\t%(objectname:short)\t%(subject)"],
      { cwd: rootDir }
    );

    const localBranches = [];
    if (!localBranchesResult.error) {
      for (const line of String(localBranchesResult.stdout ?? "").split(/\r?\n/)) {
        if (!line) {
          continue;
        }

        const [name = "", upstream = "", commit = "", ...subjectParts] = line.split("\t");
        const normalizedName = normalizeText(name);
        if (!normalizedName) {
          continue;
        }

        localBranches.push({
          name: normalizedName,
          upstream: normalizeText(upstream),
          commit: normalizeText(commit),
          subject: normalizeText(subjectParts.join("\t"))
        });
      }
    }

    const remoteBranches = [];
    if (!remoteBranchesResult.error) {
      for (const line of String(remoteBranchesResult.stdout ?? "").split(/\r?\n/)) {
        if (!line) {
          continue;
        }

        const [ref = "", commit = "", ...subjectParts] = line.split("\t");
        const normalizedRef = normalizeText(ref);
        const slashIndex = normalizedRef.indexOf("/");
        if (!normalizedRef || normalizedRef.endsWith("/HEAD") || slashIndex < 0) {
          continue;
        }

        remoteBranches.push({
          ref: normalizedRef,
          remote: slashIndex >= 0 ? normalizedRef.slice(0, slashIndex) : "",
          name: slashIndex >= 0 ? normalizedRef.slice(slashIndex + 1) : normalizedRef,
          commit: normalizeText(commit),
          subject: normalizeText(subjectParts.join("\t"))
        });
      }
    }

    const localBranchDetails = [];
    for (const branch of localBranches) {
      let ahead = 0;
      let behind = 0;
      if (branch.upstream) {
        const comparison = await runCommand(
          "git",
          ["rev-list", "--left-right", "--count", `${branch.name}...${branch.upstream}`],
          { cwd: rootDir }
        );
        if (!comparison.error) {
          const [aheadText = "0", behindText = "0"] = normalizeText(comparison.stdout).split(/\s+/);
          ahead = Number(aheadText ?? 0) || 0;
          behind = Number(behindText ?? 0) || 0;
        }
      }

      localBranchDetails.push({
        ...branch,
        ahead,
        behind,
        isCurrent: false
      });
    }

    return {
      localBranches: localBranchDetails,
      remoteBranches
    };
  }

  async readBranchHistory(rootDir, branchName, limit = 6) {
    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const isRepo = await this.isRepository(rootDir);
    if (!isRepo) {
      const error = new Error("当前目录不是 Git 仓库");
      error.statusCode = 400;
      throw error;
    }

    const normalizedBranch = normalizeText(branchName);
    if (!normalizedBranch) {
      const error = new Error("缺少分支名称");
      error.statusCode = 400;
      throw error;
    }

    const commitLimit = Math.min(Math.max(Number(limit) || 6, 1), 20);
    const logResult = await runCommand(
      "git",
      [
        "log",
        `--max-count=${commitLimit}`,
        "--date=short",
        "--pretty=format:%H%x09%h%x09%ad%x09%an%x09%ae%x09%s",
        normalizedBranch
      ],
      { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 }
    );

    if (logResult.error) {
      const stderrText = normalizeText(logResult.stderr);
      if (/does not have any commits yet|unknown revision|bad revision/i.test(stderrText)) {
        return { commits: [] };
      }
      const error = new Error(logResult.stderr || logResult.error.message || "git log failed");
      error.statusCode = 500;
      throw error;
    }

    const commits = [];
    for (const line of String(logResult.stdout ?? "").split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      const [fullCommit = "", commit = "", date = "", authorName = "", authorEmail = "", ...subjectParts] = line.split("\t");
      const normalizedCommit = normalizeText(commit);
      const normalizedFullCommit = normalizeText(fullCommit);
      if (!normalizedCommit || !normalizedFullCommit) {
        continue;
      }

      const numStatResult = await runCommand(
        "git",
        [
          "diff-tree",
          "--no-commit-id",
          "--root",
          "--numstat",
          "--no-renames",
          "-r",
          normalizedFullCommit
        ],
        { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 }
      );

      if (numStatResult.error) {
        const error = new Error(numStatResult.stderr || numStatResult.error.message || "git diff-tree failed");
        error.statusCode = 500;
        throw error;
      }

      const stats = parseNumStatOutput(numStatResult.stdout);
      commits.push({
        commit: normalizedCommit,
        fullCommit: normalizedFullCommit,
        date: normalizeText(date),
        authorName: normalizeText(authorName),
        authorEmail: normalizeText(authorEmail),
        subject: normalizeText(subjectParts.join("\t")),
        insertions: stats.insertions,
        deletions: stats.deletions,
        fileCount: stats.files.length,
        files: stats.files
      });
    }

    return {
      branch: normalizedBranch,
      commits
    };
  }

  async readTimeline(rootDir, options = {}) {
    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const isRepo = await this.isRepository(rootDir);
    if (!isRepo) {
      const error = new Error("当前目录不是 Git 仓库");
      error.statusCode = 400;
      throw error;
    }

    const commitLimit = Math.min(Math.max(Number(options.limit) || 14, 1), 30);
    const currentBranch = normalizeText(options.currentBranch);
    const leadMeta = buildLeadMeta(options.ahead, options.behind);

    const logResult = await runCommand(
      "git",
      [
        "log",
        "--all",
        `--max-count=${commitLimit}`,
        "--date=short",
        "--decorate=short",
        "--pretty=format:%H%x09%h%x09%ad%x09%an%x09%ae%x09%s%x09%D"
      ],
      { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 }
    );

    if (logResult.error) {
      const error = new Error(logResult.stderr || logResult.error.message || "git log failed");
      error.statusCode = 500;
      throw error;
    }

    const commits = [];
    for (const line of String(logResult.stdout ?? "").split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      const [fullCommit = "", commit = "", date = "", authorName = "", authorEmail = "", ...rest] = line.split("\t");
      const normalizedCommit = normalizeText(commit);
      const normalizedFullCommit = normalizeText(fullCommit);
      if (!normalizedCommit || !normalizedFullCommit) {
        continue;
      }

      const [subject = "", decorations = ""] = rest;
      const parsedDecorations = parseLogDecorations(decorations, currentBranch);
      const numStatResult = await runCommand(
        "git",
        [
          "diff-tree",
          "--no-commit-id",
          "--root",
          "--numstat",
          "--no-renames",
          "-r",
          normalizedFullCommit
        ],
        { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 }
      );

      if (numStatResult.error) {
        const error = new Error(numStatResult.stderr || numStatResult.error.message || "git diff-tree failed");
        error.statusCode = 500;
        throw error;
      }

      const stats = parseNumStatOutput(numStatResult.stdout);
      const hasLocalRef = parsedDecorations.refs.some((item) => item.tone === "local" || item.tone === "current");
      const hasRemoteRef = parsedDecorations.refs.some((item) => item.tone === "remote");
      const isCurrentTip = parsedDecorations.headBranch === currentBranch && Boolean(currentBranch);

      commits.push({
        commit: normalizedCommit,
        fullCommit: normalizedFullCommit,
        date: normalizeText(date),
        authorName: normalizeText(authorName),
        authorEmail: normalizeText(authorEmail),
        subject,
        refs: parsedDecorations.refs,
        headBranch: parsedDecorations.headBranch,
        isCurrentTip,
        hasLocalRef,
        hasRemoteRef,
        presenceLabel: isCurrentTip
          ? "当前"
          : hasRemoteRef && !hasLocalRef
            ? "远程最新"
            : hasLocalRef && !hasRemoteRef
              ? "本地最新"
              : hasLocalRef && hasRemoteRef
                ? "追踪"
                : "",
        leadLabel: isCurrentTip ? leadMeta.label : "",
        leadTone: isCurrentTip ? leadMeta.tone : "",
        insertions: stats.insertions,
        deletions: stats.deletions,
        fileCount: stats.files.length,
        files: stats.files
      });
    }

    return {
      commits
    };
  }

  async readState(rootDir) {
    const status = await this.readStatusState(rootDir);
    const branches = status.isRepo ? await this.readBranchState(rootDir) : {
      localBranches: [],
      remoteBranches: []
    };
    const currentBranch = normalizeText(status.currentBranch);
    const timeline = status.isRepo
      ? await this.readTimeline(rootDir, {
          currentBranch,
          ahead: status.ahead,
          behind: status.behind,
          limit: 14
        })
      : {
          commits: []
        };

    return {
      ...status,
      gitUserName: status.gitUserName ?? "",
      gitUserEmail: status.gitUserEmail ?? "",
      localBranches: branches.localBranches.map((branch) => ({
        ...branch,
        isCurrent: branch.name === currentBranch
      })),
      remoteBranches: branches.remoteBranches,
      currentBranch,
      timeline
    };
  }

  async readFilePreview(rootDir, inputPath) {
    const normalizedPath = normalizeRelativeGitPath(inputPath);
    if (!normalizedPath) {
      const error = new Error("缺少文件路径");
      error.statusCode = 400;
      throw error;
    }

    const state = await this.readStatusState(rootDir);
    const entry = state.files.find(
      (item) => item.path === normalizedPath || item.previousPath === normalizedPath
    ) ?? null;
    const filePath = entry?.path ?? normalizedPath;
    const previousPath = entry?.previousPath ?? "";

    let afterContent = "";
    let afterSize = 0;
    let afterTruncated = false;
    let beforeContent = "";
    let beforeSize = 0;
    let beforeTruncated = false;

    const absoluteAfterPath = resolveWorkspacePath(rootDir, filePath).absolutePath;
    try {
      const preview = await readTextFilePreview(absoluteAfterPath);
      afterContent = preview.content;
      afterSize = preview.size;
      afterTruncated = preview.truncated;
    } catch {
      afterContent = "";
    }

    if (entry?.untracked) {
      beforeContent = "";
    } else {
      const beforePreview = await readGitBlobPreviewAtRef(rootDir, "HEAD", previousPath || filePath);
      beforeContent = beforePreview.content;
      beforeSize = beforePreview.size;
      beforeTruncated = beforePreview.truncated;
    }

    return {
      path: filePath,
      previousPath,
      displayPath: previousPath && previousPath !== filePath ? `${previousPath} -> ${filePath}` : filePath,
      changeKind: entry?.changeKind ?? "modified",
      indexStatus: entry?.indexStatus ?? " ",
      worktreeStatus: entry?.worktreeStatus ?? " ",
      staged: Boolean(entry?.staged),
      untracked: Boolean(entry?.untracked),
      renamed: Boolean(entry?.renamed),
      copied: Boolean(entry?.copied),
      beforeContent,
      afterContent,
      beforeSize,
      afterSize,
      beforeTruncated,
      afterTruncated,
      language: path.extname(filePath).replace(/^\./, "").toLowerCase() || "plaintext"
    };
  }

  async readCommitFilePreview(rootDir, commitHash, inputPath) {
    const normalizedCommit = normalizeText(commitHash);
    if (!normalizedCommit) {
      const error = new Error("缺少提交哈希");
      error.statusCode = 400;
      throw error;
    }

    const normalizedPath = normalizeRelativeGitPath(inputPath);
    if (!normalizedPath) {
      const error = new Error("缺少文件路径");
      error.statusCode = 400;
      throw error;
    }

    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const isRepo = await this.isRepository(rootDir);
    if (!isRepo) {
      const error = new Error("当前目录不是 Git 仓库");
      error.statusCode = 400;
      throw error;
    }

    const nameStatusResult = await runCommand(
      "git",
      [
        "diff-tree",
        "--no-commit-id",
        "--root",
        "--name-status",
        "--find-renames",
        "--find-copies-harder",
        "-r",
        normalizedCommit
      ],
      { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 }
    );

    if (nameStatusResult.error) {
      const error = new Error(nameStatusResult.stderr || nameStatusResult.error.message || "git diff-tree failed");
      error.statusCode = 500;
      throw error;
    }

    const files = parseCommitNameStatusOutput(nameStatusResult.stdout);
    const entry = files.find((item) => item.path === normalizedPath || item.previousPath === normalizedPath) ?? null;
    const filePath = entry?.path ?? normalizedPath;
    const previousPath = entry?.previousPath ?? "";
    const changeKind = entry?.changeKind ?? "modified";
    const parentRef = `${normalizedCommit}^`;

    let beforeContent = "";
    let afterContent = "";
    let beforeSize = 0;
    let afterSize = 0;
    let beforeTruncated = false;
    let afterTruncated = false;

    if (changeKind === "added") {
      const afterPreview = await readGitBlobPreviewAtRef(rootDir, normalizedCommit, filePath);
      afterContent = afterPreview.content;
      afterSize = afterPreview.size;
      afterTruncated = afterPreview.truncated;
    } else if (changeKind === "deleted") {
      const beforePreview = await readGitBlobPreviewAtRef(rootDir, parentRef, previousPath || filePath);
      beforeContent = beforePreview.content;
      beforeSize = beforePreview.size;
      beforeTruncated = beforePreview.truncated;
    } else {
      const beforePreview = await readGitBlobPreviewAtRef(rootDir, parentRef, previousPath || filePath);
      beforeContent = beforePreview.content;
      beforeSize = beforePreview.size;
      beforeTruncated = beforePreview.truncated;

      const afterPreview = await readGitBlobPreviewAtRef(rootDir, normalizedCommit, filePath);
      afterContent = afterPreview.content;
      afterSize = afterPreview.size;
      afterTruncated = afterPreview.truncated;
    }

    return {
      commit: normalizedCommit,
      path: filePath,
      previousPath,
      displayPath: previousPath && previousPath !== filePath ? `${previousPath} -> ${filePath}` : filePath,
      changeKind,
      statusCode: entry?.statusCode ?? "M",
      staged: false,
      untracked: false,
      renamed: changeKind === "renamed",
      copied: changeKind === "copied",
      beforeContent,
      afterContent,
      beforeSize,
      afterSize,
      beforeTruncated,
      afterTruncated,
      language: path.extname(filePath).replace(/^\./, "").toLowerCase() || "plaintext"
    };
  }

  async initRepository(rootDir) {
    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const isRepo = await this.isRepository(rootDir);
    if (isRepo) {
      return this.readState(rootDir);
    }

    const result = await runCommand("git", ["init"], { cwd: rootDir });
    if (result.error) {
      const error = new Error(result.stderr || result.error.message || "git init failed");
      error.statusCode = 500;
      throw error;
    }

    return this.readState(rootDir);
  }

  async stageFiles(rootDir, inputPaths = [], staged = true) {
    const paths = normalizePathList(inputPaths);
    if (paths.length === 0) {
      return this.readState(rootDir);
    }

    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const isRepo = await this.isRepository(rootDir);
    if (!isRepo) {
      const error = new Error("当前目录不是 Git 仓库");
      error.statusCode = 400;
      throw error;
    }

    const command = staged ? "add" : "reset";
    const args = staged ? ["add", "--", ...paths] : ["reset", "--", ...paths];
    const result = await runCommand("git", args, { cwd: rootDir });
    if (result.error) {
      const error = new Error(result.stderr || result.error.message || `git ${command} failed`);
      error.statusCode = 500;
      throw error;
    }

    return this.readState(rootDir);
  }

  async commitChanges(rootDir, message) {
    const commitMessage = normalizeText(message);
    if (!commitMessage) {
      const error = new Error("commit message is required");
      error.statusCode = 400;
      throw error;
    }

    const state = await this.readState(rootDir);
    if (state.stagedPaths.length === 0) {
      const error = new Error("没有已暂存的文件可提交");
      error.statusCode = 400;
      throw error;
    }

    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const result = await runCommand("git", ["commit", "-m", commitMessage], { cwd: rootDir });
    if (result.error) {
      const error = new Error(result.stderr || result.error.message || "git commit failed");
      error.statusCode = 500;
      throw error;
    }

    return {
      ...await this.readState(rootDir),
      output: normalizeText(result.stdout || result.stderr)
    };
  }

  async pushChanges(rootDir) {
    const state = await this.readState(rootDir);
    if (!state.canPush) {
      const error = new Error("没有可推送的本地提交");
      error.statusCode = 400;
      throw error;
    }

    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    const branchName = normalizeText(state.currentBranch);
    if (!branchName) {
      const error = new Error("当前分支不可用");
      error.statusCode = 400;
      throw error;
    }

    const remoteName = state.remoteNames[0] || "origin";
    const pushArgs = state.upstream
      ? ["push"]
      : ["push", "-u", remoteName, branchName];
    const result = await runCommand("git", pushArgs, { cwd: rootDir, maxBuffer: 30 * 1024 * 1024 });
    if (result.error) {
      const error = new Error(result.stderr || result.error.message || "git push failed");
      error.statusCode = 500;
      throw error;
    }

    return {
      ...await this.readState(rootDir),
      output: normalizeText(result.stdout || result.stderr)
    };
  }

  async revertFiles(rootDir, inputPaths = []) {
    const paths = normalizePathList(inputPaths);
    if (paths.length === 0) {
      return this.readState(rootDir);
    }

    const state = await this.readStatusState(rootDir);
    const targetPaths = paths
      .map((inputPath) => {
        const normalized = normalizeRelativeGitPath(inputPath);
        const entry = state.files.find(
          (item) => item.path === normalized || item.previousPath === normalized
        );
        return entry?.path ?? normalized;
      })
      .filter(Boolean);

    if (targetPaths.length === 0) {
      return this.readState(rootDir);
    }

    const available = await this.isGitAvailable();
    if (!available) {
      const error = new Error("git 不可用");
      error.statusCode = 503;
      throw error;
    }

    for (const targetPath of targetPaths) {
      const entry = state.files.find((item) => item.path === targetPath) ?? null;
      if (entry?.untracked) {
        const absolutePath = resolveWorkspacePath(rootDir, targetPath).absolutePath;
        await fs.rm(absolutePath, { force: true });
        continue;
      }

      const result = await runCommand(
        "git",
        ["restore", "--staged", "--worktree", "--source=HEAD", "--", targetPath],
        { cwd: rootDir }
      );
      if (result.error) {
        const error = new Error(result.stderr || result.error.message || "git restore failed");
        error.statusCode = 500;
        throw error;
      }
    }

    return this.readState(rootDir);
  }

  async generateCommitMessage(options = {}) {
    const rootDir = normalizeText(options.rootDir);
    if (!rootDir) {
      const error = new Error("缺少工作区根目录");
      error.statusCode = 400;
      throw error;
    }

    if (!this.configStore || typeof this.configStore.read !== "function") {
      const error = new Error("压缩模型配置不可用");
      error.statusCode = 500;
      throw error;
    }

    const state = await this.readState(rootDir);
    const candidatePaths = normalizePathList(options.paths).length > 0
      ? normalizePathList(options.paths)
      : state.stagedPaths.length > 0
        ? state.stagedPaths
        : state.dirtyPaths;

    if (candidatePaths.length === 0) {
      const error = new Error("没有可用于生成 commit 描述的 diff");
      error.statusCode = 400;
      throw error;
    }

    const diffEntries = [];
    for (const candidatePath of candidatePaths) {
      const preview = await this.readFilePreview(rootDir, candidatePath);
      diffEntries.push({
        ...preview,
        beforeContent: preview.beforeContent || "",
        afterContent: preview.afterContent || ""
      });
    }

    const config = await this.configStore.read();
    const compressionProfile = resolveModelProfile(config, "", "compression");
    if (!compressionProfile) {
      const error = new Error("压缩模型未配置");
      error.statusCode = 400;
      throw error;
    }

    const runtimeConfig = applyModelProfileToRuntimeConfig(config, compressionProfile);
    const commitRuntimeConfig = {
      ...runtimeConfig,
      maxOutputTokens: Math.min(
        Number(config?.compressionMaxOutputTokens ?? DEFAULT_COMMIT_MAX_TOKENS) || DEFAULT_COMMIT_MAX_TOKENS,
        DEFAULT_COMMIT_MAX_TOKENS
      )
    };
    const prompt = buildCommitUserPrompt({
      rootDir,
      branch: state.currentBranch,
      stagedFiles: state.stagedPaths,
      diffEntries: diffEntries.map((entry) => ({
        ...entry,
        beforeContent: clipText(entry.beforeContent ?? "", DEFAULT_MAX_FILE_CHARS),
        afterContent: clipText(entry.afterContent ?? "", DEFAULT_MAX_FILE_CHARS)
      }))
    });

    const completion = await runModelProviderStream(commitRuntimeConfig, {
      temperature: 0.2,
      max_tokens: commitRuntimeConfig.maxOutputTokens ?? DEFAULT_COMMIT_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content: buildCommitSystemPrompt()
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    let mergedText = "";
    for await (const chunk of completion) {
      const text = extractStreamChunkText(chunk);
      if (!text) {
        continue;
      }
      mergedText += text;
      options.onDelta?.(text, mergedText);
    }

    const commitMessage = normalizeText(mergedText);
    if (!commitMessage) {
      const error = new Error("commit 描述生成失败");
      error.statusCode = 500;
      throw error;
    }

    return commitMessage;
  }
}
