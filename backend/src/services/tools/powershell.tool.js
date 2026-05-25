import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_CAPTURED_OUTPUT = 12000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const COMMAND_SEGMENT_PREFIX = "(?:^|[;&|\\n])\\s*";

const DESTRUCTIVE_COMMAND_RULES = [
  {
    pattern: new RegExp(`${COMMAND_SEGMENT_PREFIX}format(?:\\.com|\\.exe)?\\b`, "i"),
    reason: "format 可能会格式化磁盘。"
  },
  {
    pattern: new RegExp(`${COMMAND_SEGMENT_PREFIX}diskpart\\b`, "i"),
    reason: "diskpart 可直接修改/清空磁盘分区。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}(?:clear-disk|format-volume|remove-partition|initialize-disk)\\b`,
      "i"
    ),
    reason: "检测到 PowerShell 磁盘管理破坏性命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}(?:mkfs(?:\\.[a-z0-9_+.-]+)?|fdisk|parted|sgdisk|gdisk|cfdisk|wipefs)\\b`,
      "i"
    ),
    reason: "检测到磁盘分区/文件系统重建命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}dd\\b[^|;&\\n]*\\bof\\s*=\\s*(?:\\\\\\\\\\.\\\\physicaldrive\\d+|\\/dev\\/[a-z0-9]+)`,
      "i"
    ),
    reason: "dd 正在向物理磁盘设备写入数据。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}rm\\b[^|;&\\n]*\\s-rf?\\b[^|;&\\n]*\\s(?:--no-preserve-root\\s+)?\\/(?:\\s|$)`,
      "i"
    ),
    reason: "检测到删除根目录命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}rm\\b[^|;&\\n]*\\s-rf?\\b[^|;&\\n]*(?:\\/etc|\\/usr|\\/bin|\\/sbin|\\/boot)(?:\\s|$)`,
      "i"
    ),
    reason: "检测到删除关键系统目录命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}(?:rd|rmdir|del|erase)\\b[^|;&\\n]*(?:[a-z]:\\\\windows|[a-z]:\\\\program files|[a-z]:\\\\programdata)(?:\\s|$)`,
      "i"
    ),
    reason: "检测到删除 Windows 关键系统目录命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}(?:remove-item|rm)\\b[^|;&\\n]*(?:[a-z]:\\\\windows|[a-z]:\\\\program files|[a-z]:\\\\programdata)(?:\\s|$)`,
      "i"
    ),
    reason: "检测到 PowerShell 删除 Windows 关键目录命令。"
  },
  {
    pattern: new RegExp(`${COMMAND_SEGMENT_PREFIX}(?:bcdedit|bootrec)\\b`, "i"),
    reason: "检测到引导配置修改命令。"
  },
  {
    pattern: new RegExp(
      `${COMMAND_SEGMENT_PREFIX}reg(?:\\.exe)?\\s+delete\\s+(?:hklm|hkey_local_machine)\\\\`,
      "i"
    ),
    reason: "检测到删除系统级注册表键命令。"
  }
];

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

function terminateProcessTree(child) {
  if (!child) {
    return;
  }

  if (process.platform === "win32") {
    const pid = Number(child.pid ?? 0);
    if (pid > 0) {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.unref();
        return;
      } catch {
        // Fall back to direct kill below.
      }
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {
      // Ignore secondary kill failures.
    }
  }
}

function detectDestructiveCommand(command) {
  const normalized = String(command ?? "").replace(/\r/g, "").trim();
  if (!normalized) {
    return "";
  }

  for (const rule of DESTRUCTIVE_COMMAND_RULES) {
    if (rule.pattern.test(normalized)) {
      return String(rule.reason ?? "").trim() || "命中系统安全拦截规则。";
    }
  }

  return "";
}

function buildPowerShellCommand(command) {
  const normalizedCommand = encodeNestedPowerShellCommandArguments(command);
  const prelude = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "chcp 65001 | Out-Null"
  ].join("; ");

  return `${prelude}; ${normalizedCommand}`;
}

function encodePowerShellCommand(command) {
  return Buffer.from(buildPowerShellCommand(command), "utf16le").toString("base64");
}

function encodeNestedPowerShellCommandArguments(command) {
  return String(command ?? "").replace(
    /(\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b(?:(?!\s-(?:Command|c)\b)[\s\S])*?\s-)(?:Command|c)(\s+)"([\s\S]*?)"/gi,
    (_match, prefix, spacing, script) =>
      `${prefix}EncodedCommand${spacing}${Buffer.from(script, "utf16le").toString("base64")}`
  );
}

function findWindowsExecutable(commandName) {
  try {
    const result = execFileSync("where.exe", [commandName], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1000
    });
    return String(result ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

function findUnixExecutable(commandName) {
  try {
    const result = execFileSync("bash", ["-lc", `command -v ${commandName}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1000
    });
    return String(result ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

async function resolvePowerShellExecutable() {
  if (process.platform === "win32") {
    return findWindowsExecutable("pwsh.exe") || findWindowsExecutable("powershell.exe") || "powershell.exe";
  }

  return findUnixExecutable("pwsh") || findUnixExecutable("powershell") || "pwsh";
}

async function runCommand({ command, cwd, timeoutMs, abortSignal = null }) {
  const shellFile = await resolvePowerShellExecutable();

  if (!shellFile) {
    throw new Error("PowerShell executable not found. Install pwsh or powershell.");
  }

  const env = {
    ...process.env,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    PYTHONUTF8: "1"
  };

  const shellArgs = process.platform === "win32"
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(command)
      ]
    : ["-NoProfile", "-NonInteractive", "-Command", buildPowerShellCommand(command)];

  return new Promise((resolve, reject) => {
    const child = spawn(shellFile, shellArgs, {
      cwd,
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    };

    const settleResolve = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(payload);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    const abortHandler = () => {
      terminateProcessTree(child);
      settleResolve({
        exitCode: -1,
        signal: "SIGTERM",
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: false,
        aborted: true
      });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler();
      } else if (typeof abortSignal.addEventListener === "function") {
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout = appendWithLimit(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    child.on("error", (error) => {
      settleReject(error);
    });

    child.on("close", (exitCode, signal) => {
      settleResolve({
        exitCode: Number(exitCode ?? -1),
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        aborted: false
      });
    });
  });
}

export default {
  name: "PowerShell",
  description:
    "Run a PowerShell command in a shell context and return stdout/stderr with exit status. UTF-8 is forced for shell I/O.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "PowerShell command to execute."
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

    const destructiveReason = detectDestructiveCommand(command);
    if (destructiveReason) {
      throw new Error(`Command blocked by system safety guard: ${destructiveReason}`);
    }

    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error("cwd must be a directory");
    }

    const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
    const result = await runCommand({
      command,
      cwd,
      timeoutMs,
      abortSignal: executionContext?.abortSignal ?? null
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
