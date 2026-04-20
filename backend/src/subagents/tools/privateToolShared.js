import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".idea",
  ".vscode",
  "coverage"
]);

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
  ".bin",
  ".class",
  ".jar",
  ".so",
  ".dylib",
  ".woff",
  ".woff2"
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function appendWithLimit(current, next, maxChars) {
  if (!next) {
    return current;
  }

  const merged = current + next;
  if (merged.length <= maxChars) {
    return merged;
  }

  return merged.slice(merged.length - maxChars);
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

function buildPowerShellCommand(command) {
  const prelude = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "chcp 65001 | Out-Null"
  ].join("; ");

  return `${prelude}; ${command}`;
}

function buildShellCommand(command) {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildPowerShellCommand(command)
      ]
    };
  }

  return {
    file: "/bin/bash",
    args: ["-lc", command]
  };
}

export function clipText(value, maxChars = 1200) {
  const text = String(value ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()}\n...[truncated]`;
}

export function normalizePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  if (normalized < min) {
    return min;
  }

  if (normalized > max) {
    return max;
  }

  return normalized;
}

export function resolveContextWorkingDirectory(executionContext = {}, rawCwd = "") {
  const explicitCwd = normalizeText(rawCwd);
  if (explicitCwd) {
    return path.resolve(explicitCwd);
  }

  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";

  return candidate ? path.resolve(candidate) : process.cwd();
}

export function resolveTargetPath(rootCwd, rawPath = "") {
  const normalized = normalizeText(rawPath);
  if (!normalized) {
    return rootCwd;
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  return path.resolve(rootCwd, normalized);
}

export async function ensureDirectory(dirPath) {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }
}

export async function fileExists(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function runShellCommand(options = {}) {
  const command = normalizeText(options.command);
  const cwd = normalizeText(options.cwd);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxOutputChars = normalizePositiveInteger(
    options.maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
    800,
    50000
  );

  if (!command) {
    throw new Error("command is required");
  }
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }

  await ensureDirectory(cwd);
  const shellCommand = buildShellCommand(command);
  const env = {
    ...process.env,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    PYTHONUTF8: "1"
  };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(shellCommand.file, shellCommand.args, {
      cwd,
      env,
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
      stdout = appendWithLimit(stdout, chunk, maxOutputChars);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendWithLimit(stderr, chunk, maxOutputChars);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && Number(exitCode ?? -1) === 0,
        command,
        cwd,
        timeoutMs,
        exitCode: Number(exitCode ?? -1),
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command,
        cwd,
        timeoutMs,
        exitCode: -1,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: String(error?.message ?? "spawn failed")
      });
    });
  });
}

function isLikelyTextFile(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return !BINARY_EXTENSIONS.has(ext);
}

export async function walkTextFiles(rootPath, options = {}) {
  const maxFiles = normalizePositiveInteger(options.maxFiles, 1000, 1, 10000);
  const queue = [path.resolve(rootPath)];
  const results = [];

  while (queue.length > 0 && results.length < maxFiles) {
    const currentPath = queue.shift();
    let stats;
    try {
      stats = await fs.stat(currentPath);
    } catch {
      continue;
    }

    if (stats.isFile()) {
      if (isLikelyTextFile(currentPath)) {
        results.push(currentPath);
      }
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(path.join(currentPath, entry.name));
        continue;
      }

      if (entry.isFile()) {
        const filePath = path.join(currentPath, entry.name);
        if (isLikelyTextFile(filePath)) {
          results.push(filePath);
          if (results.length >= maxFiles) {
            break;
          }
        }
      }
    }
  }

  return results;
}

export async function readTextFileLines(filePath, options = {}) {
  const maxChars = normalizePositiveInteger(options.maxChars, 300000, 5000, 5000000);
  const text = await fs.readFile(filePath, "utf8");
  const truncated = text.length > maxChars;
  const safeText = truncated ? text.slice(0, maxChars) : text;
  const lines = safeText.replace(/\r\n/g, "\n").split("\n");
  return {
    lines,
    truncated
  };
}

export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toSafeRelative(rootPath, absolutePath) {
  return path.relative(rootPath, absolutePath).replace(/\\/g, "/");
}
