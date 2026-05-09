import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIST_LIMIT = 12;
const MAX_LIST_LIMIT = 40;
const DEFAULT_RESULT_CHARS = 6000;
const MAX_RESULT_CHARS = 20000;
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

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeConversationId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error("conversationId is required");
  }
  return normalized;
}

function normalizeLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(numeric)));
}

function normalizeResultChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_RESULT_CHARS;
  }
  return Math.max(600, Math.min(MAX_RESULT_CHARS, Math.trunc(numeric)));
}

function normalizeTaskId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error("taskId is required");
  }
  return normalized;
}

function createTaskId() {
  return `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function sanitizePathSegment(value) {
  return normalizeText(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

function truncateMiddle(text, maxChars = DEFAULT_RESULT_CHARS) {
  const source = String(text ?? "");
  if (!source) {
    return "";
  }
  if (source.length <= maxChars) {
    return source;
  }
  const head = Math.max(240, Math.floor(maxChars * 0.45));
  const tail = Math.max(240, maxChars - head - 64);
  return `${source.slice(0, head)}\n\n...[中间已截断]...\n\n${source.slice(-tail)}`;
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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, fallbackValue = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function buildCombinedResult(stdout = "", stderr = "") {
  const chunks = [];
  const normalizedStdout = String(stdout ?? "").trim();
  const normalizedStderr = String(stderr ?? "").trim();
  if (normalizedStdout) {
    chunks.push(normalizedStdout);
  }
  if (normalizedStderr) {
    chunks.push(`[stderr]\n${normalizedStderr}`);
  }
  return chunks.join("\n\n");
}

export class ConversationTaskService {
  constructor(options = {}) {
    this.rootDir = normalizeText(options.rootDir);
    this.runnerScriptPath = normalizeText(options.runnerScriptPath);
  }

  async ensureDir() {
    if (!this.rootDir) {
      throw new Error("task rootDir is required");
    }
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  resolveConversationDir(conversationId) {
    return path.join(this.rootDir, sanitizePathSegment(normalizeConversationId(conversationId)));
  }

  resolveTaskDir(conversationId, taskId) {
    return path.join(
      this.resolveConversationDir(conversationId),
      sanitizePathSegment(normalizeTaskId(taskId))
    );
  }

  async startTerminalTask({ conversationId, command, cwd, requestedBy = "" } = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedCommand = normalizeText(command);
    const normalizedCwd = normalizeText(cwd);

    if (!normalizedCommand) {
      throw new Error("command is required");
    }
    if (!normalizedCwd) {
      throw new Error("cwd is required");
    }

    const destructiveReason = detectDestructiveCommand(normalizedCommand);
    if (destructiveReason) {
      throw new Error(destructiveReason);
    }

    const taskId = createTaskId();
    const conversationDir = this.resolveConversationDir(normalizedConversationId);
    const taskDir = this.resolveTaskDir(normalizedConversationId, taskId);
    const taskFile = path.join(taskDir, "task.json");
    const stdoutFile = path.join(taskDir, "stdout.log");
    const stderrFile = path.join(taskDir, "stderr.log");
    const payloadFile = path.join(taskDir, "payload.json");
    const now = Date.now();

    await fs.mkdir(conversationDir, { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(stdoutFile, "", "utf8");
    await fs.writeFile(stderrFile, "", "utf8");

    const taskRecord = {
      taskId,
      conversationId: normalizedConversationId,
      command: normalizedCommand,
      cwd: path.resolve(normalizedCwd),
      requestedBy: normalizeText(requestedBy),
      status: "queued",
      pid: null,
      exitCode: null,
      signal: "",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null
    };

    await fs.writeFile(taskFile, `${JSON.stringify(taskRecord, null, 2)}\n`, "utf8");
    await fs.writeFile(
      payloadFile,
      `${JSON.stringify(
        {
          taskFile,
          stdoutFile,
          stderrFile,
          command: normalizedCommand,
          cwd: taskRecord.cwd
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const child = spawn(process.execPath, [this.runnerScriptPath, payloadFile], {
      cwd: taskDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        YYZ_CLAW_TASK_RUNNER: "1"
      }
    });
    child.unref();

    return {
      taskId,
      status: "queued",
      command: normalizedCommand,
      result: "后台终端任务已创建，输出将持续写入本地日志。"
    };
  }

  async listConversationTasks(conversationId, options = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const conversationDir = this.resolveConversationDir(normalizedConversationId);
    const limit = normalizeLimit(options.limit);

    if (!(await pathExists(conversationDir))) {
      return {
        conversationId: normalizedConversationId,
        total: 0,
        tasks: []
      };
    }

    const entries = await fs.readdir(conversationDir, { withFileTypes: true });
    const tasks = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const taskDir = path.join(conversationDir, entry.name);
      const task = await this.readTaskRecord(taskDir);
      if (task) {
        tasks.push(task);
      }
    }

    tasks.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));

    return {
      conversationId: normalizedConversationId,
      total: tasks.length,
      tasks: await Promise.all(
        tasks.slice(0, limit).map(async (task) => this.buildOverviewItem(task, { resultChars: options.resultChars }))
      )
    };
  }

  async readTaskDetail(conversationId, taskId, options = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedTaskId = normalizeTaskId(taskId);
    const taskDir = this.resolveTaskDir(normalizedConversationId, normalizedTaskId);
    let task = await this.readTaskRecord(taskDir);

    if (!task) {
      throw new Error(`task not found: ${normalizedTaskId}`);
    }

    const resultChars = normalizeResultChars(options.resultChars);
    const stdout = await readTextFile(path.join(taskDir, "stdout.log"));
    const stderr = await readTextFile(path.join(taskDir, "stderr.log"));
    const combinedResult = buildCombinedResult(stdout, stderr);
    task = (await this.readTaskRecord(taskDir)) ?? task;

    return {
      taskId: task.taskId,
      status: task.status,
      command: task.command,
      cwd: task.cwd,
      pid: task.pid,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      updatedAt: task.updatedAt,
      result: truncateMiddle(combinedResult, resultChars)
    };
  }

  async deleteTask(conversationId, taskId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedTaskId = normalizeTaskId(taskId);
    const taskDir = this.resolveTaskDir(normalizedConversationId, normalizedTaskId);
    const task = await this.readTaskRecord(taskDir);

    if (!task) {
      throw new Error(`task not found: ${normalizedTaskId}`);
    }

    await fs.rm(taskDir, { recursive: true, force: true });

    return {
      deleted: true,
      taskId: normalizedTaskId,
      conversationId: normalizedConversationId
    };
  }

  async buildOverviewItem(task, options = {}) {
    const taskDir = this.resolveTaskDir(task.conversationId, task.taskId);
    const stdout = await readTextFile(path.join(taskDir, "stdout.log"));
    const stderr = await readTextFile(path.join(taskDir, "stderr.log"));
    const combinedResult = buildCombinedResult(stdout, stderr);
    const resultChars = normalizeResultChars(options.resultChars);
    const refreshedTask = (await this.readTaskRecord(taskDir)) ?? task;

    return {
      taskId: refreshedTask.taskId,
      status: refreshedTask.status,
      command: refreshedTask.command,
      exitCode: refreshedTask.exitCode,
      updatedAt: refreshedTask.updatedAt,
      result: truncateMiddle(combinedResult, resultChars)
    };
  }

  async readTaskRecord(taskDir) {
    const task = await readJsonFile(path.join(taskDir, "task.json"));
    if (!task || typeof task !== "object") {
      return null;
    }

    return {
      taskId: normalizeText(task.taskId),
      conversationId: normalizeText(task.conversationId),
      command: String(task.command ?? ""),
      cwd: String(task.cwd ?? ""),
      status: normalizeText(task.status) || "unknown",
      pid: Number.isInteger(task.pid) ? task.pid : null,
      exitCode: Number.isInteger(task.exitCode) ? task.exitCode : null,
      signal: normalizeText(task.signal),
      createdAt: Number(task.createdAt ?? 0) || 0,
      updatedAt: Number(task.updatedAt ?? 0) || 0,
      startedAt: Number(task.startedAt ?? 0) || null,
      finishedAt: Number(task.finishedAt ?? 0) || null
    };
  }
}
