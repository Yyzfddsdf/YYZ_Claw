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

async function ensureDirectory(cwd) {
  const stats = await fs.stat(cwd);

  if (!stats.isDirectory()) {
    throw new Error("cwd must be a directory");
  }
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

function runCommand({ command, cwd, timeoutMs }) {
  const shellCommand = buildShellCommand(command);
  const env = {
    ...process.env,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    PYTHONUTF8: "1"
  };

  return new Promise((resolve, reject) => {
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
      stdout = appendWithLimit(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);

      resolve({
        exitCode: Number(exitCode ?? -1),
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut
      });
    });
  });
}

export default {
  name: "run_terminal",
  description:
    "Run a shell command in terminal context and return stdout/stderr with exit status. UTF-8 is forced for shell I/O.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute."
      },
      cwd: {
        type: "string",
        description: "Optional absolute working directory. Defaults to current conversation workplace."
      },
      timeoutMs: {
        type: "integer",
        description: "Optional timeout in milliseconds (1000-300000)."
      }
    },
    required: ["command"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const command = typeof args.command === "string" ? args.command.trim() : "";

    if (!command) {
      throw new Error("command is required");
    }

    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    await ensureDirectory(cwd);

    const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
    const result = await runCommand({
      command,
      cwd,
      timeoutMs
    });

    if (result.timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms.`);
    }

    if (result.exitCode !== 0) {
      const detail = [
        `Command exited with code ${result.exitCode}.`,
        result.stderr ? `STDERR:\n${result.stderr}` : "",
        result.stdout ? `STDOUT:\n${result.stdout}` : ""
      ]
        .filter(Boolean)
        .join("\n");

      throw new Error(detail);
    }

    return {
      cwd,
      command,
      timeoutMs,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
};
