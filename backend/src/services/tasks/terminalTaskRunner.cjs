const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

function normalizeText(value) {
  return String(value ?? "").trim();
}

function appendLine(filePath, text) {
  return fsp.appendFile(filePath, `${String(text ?? "")}\n`, "utf8");
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function updateTask(taskFile, patch) {
  const current = await readJson(taskFile);
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };
  await fsp.writeFile(taskFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function buildPowerShellCommand(command) {
  const prelude = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "chcp 65001 | Out-Null"
  ].join("; ");

  return `${prelude}; ${String(command ?? "")}`;
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

function resolveWindowsPowerShellFile() {
  return findWindowsExecutable("pwsh.exe") || findWindowsExecutable("powershell.exe") || "powershell.exe";
}

function buildShellCommand(command) {
  if (process.platform === "win32") {
    return {
      file: resolveWindowsPowerShellFile(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(buildPowerShellCommand(command), "utf16le").toString("base64")
      ]
    };
  }

  return {
    file: "/bin/bash",
    args: ["-lc", String(command ?? "")]
  };
}

async function main() {
  const payloadFile = normalizeText(process.argv[2]);
  if (!payloadFile) {
    throw new Error("payload file is required");
  }

  const payload = await readJson(payloadFile);
  const taskFile = normalizeText(payload.taskFile);
  const stdoutFile = normalizeText(payload.stdoutFile);
  const stderrFile = normalizeText(payload.stderrFile);
  const command = String(payload.command ?? "");
  const cwd = normalizeText(payload.cwd);

  const stdoutStream = fs.createWriteStream(stdoutFile, { flags: "a", encoding: "utf8" });
  const stderrStream = fs.createWriteStream(stderrFile, { flags: "a", encoding: "utf8" });
  const shellCommand = buildShellCommand(command);
  const child = spawn(shellCommand.file, shellCommand.args, {
    cwd,
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      PYTHONUTF8: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);

  await updateTask(taskFile, {
    status: "running",
    pid: child.pid ?? null,
    startedAt: Date.now()
  });

  child.on("error", async (error) => {
    await appendLine(stderrFile, `[runner-error] ${error?.message ?? "unknown error"}`);
    await updateTask(taskFile, {
      status: "failed",
      exitCode: -1,
      finishedAt: Date.now()
    });
    process.exit(1);
  });

  child.on("close", async (exitCode, signal) => {
    await updateTask(taskFile, {
      status: Number(exitCode ?? 1) === 0 ? "exited" : "failed",
      exitCode: Number.isInteger(exitCode) ? exitCode : -1,
      signal: normalizeText(signal),
      finishedAt: Date.now()
    });
    process.exit(0);
  });
}

main().catch(async (error) => {
  const payloadFile = normalizeText(process.argv[2]);
  if (payloadFile) {
    try {
      const payload = await readJson(payloadFile);
      if (payload?.stderrFile) {
        await appendLine(payload.stderrFile, `[runner-fatal] ${error?.message ?? "unknown error"}`);
      }
      if (payload?.taskFile) {
        await updateTask(payload.taskFile, {
          status: "failed",
          exitCode: -1,
          finishedAt: Date.now()
        });
      }
    } catch {}
  }
  process.exit(1);
});
