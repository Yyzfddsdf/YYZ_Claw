import { execFile } from "node:child_process";
import os from "node:os";

import pty from "node-pty";
import WebSocket, { WebSocketServer } from "ws";

const PROCESS_TITLE_POLL_MS = 1400;

function normalizeProcessTitle(processName = "") {
  const rawName = String(processName ?? "").trim();
  if (!rawName) {
    return "";
  }
  return rawName.replace(/\.exe$/i, "");
}

function resolveShellTitle() {
  if (os.platform() === "win32") {
    return "PowerShell";
  }
  const shellName = String(process.env.SHELL || "").split(/[\\/]/).pop();
  return normalizeProcessTitle(shellName) || "Terminal";
}

function normalizeCommandTitle(command = "") {
  const trimmedCommand = String(command ?? "").trim();
  if (!trimmedCommand) {
    return "";
  }
  if (/^(?:\[?[IO])+$/i.test(trimmedCommand)) {
    return "";
  }

  const withoutPrefix = trimmedCommand
    .replace(/^(?:&\s*)?["']?([^"'\s]+)["']?.*$/, "$1")
    .split(/[\\/]/)
    .pop();
  const commandName = normalizeProcessTitle(withoutPrefix);
  if (!commandName) {
    return "";
  }

  const lowerCommand = commandName.toLowerCase();
  const titleByCommand = new Map([
    ["py", "python"],
    ["python3", "python"],
    ["pwsh", "PowerShell"],
    ["powershell", "PowerShell"],
    ["powershell_ise", "PowerShell"],
    ["npm", "npm"],
    ["pnpm", "pnpm"],
    ["yarn", "yarn"],
    ["node", "node"],
    ["npx", "npx"],
    ["conda", "conda"],
    ["git", "git"],
    ["go", "go"],
    ["pytest", "pytest"],
    ["uv", "uv"]
  ]);

  return titleByCommand.get(lowerCommand) || commandName;
}

function createInputCommandTracker({ shellTitle, sendTitle, onCommandStart }) {
  let buffer = "";
  let escapeMode = "";

  function handleInput(data = "") {
    for (const char of String(data)) {
      if (escapeMode) {
        if (escapeMode === "esc") {
          escapeMode = char === "[" || char === "]" ? char : "";
          continue;
        }

        if (escapeMode === "[") {
          if (char >= "@" && char <= "~") {
            escapeMode = "";
          }
          continue;
        }

        if (escapeMode === "]") {
          if (char === "\u0007") {
            escapeMode = "";
          }
          continue;
        }
      }

      if (char === "\u001b") {
        escapeMode = "esc";
        continue;
      }

      if (char === "\u0003") {
        buffer = "";
        sendTitle(shellTitle);
        continue;
      }

      if (char === "\u007f" || char === "\b") {
        buffer = buffer.slice(0, -1);
        continue;
      }

      if (char === "\r" || char === "\n") {
        const title = normalizeCommandTitle(buffer);
        buffer = "";
        if (title) {
          sendTitle(title);
          onCommandStart?.();
        }
        continue;
      }

      if (char >= " ") {
        buffer += char;
      }
    }
  }

  return {
    handleInput
  };
}

function createShellProcess(cwd) {
  if (os.platform() === "win32") {
    const startupScript = [
      "[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      "$OutputEncoding=[System.Text.Encoding]::UTF8",
      "chcp 65001 > $null",
      "try { Set-PSReadLineOption -PredictionSource None } catch {}"
    ].join("; ");

    return pty.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-NoExit",
        "-Command",
        startupScript
      ],
      {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );
  }

  return pty.spawn(process.env.SHELL || "/bin/bash", ["-l"], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color"
    }
  });
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function findWindowsForegroundProcess(rootPid) {
  return new Promise((resolve) => {
    const script = `
$root = ${Number(rootPid) || 0}
$items = @()
function Walk($parentPid) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" | ForEach-Object {
    $script:items += $_
    Walk $_.ProcessId
  }
}
Walk $root
$leaf = $items | Sort-Object CreationDate | Select-Object -Last 1
if ($leaf) { $leaf.Name }
`;
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        timeout: 900
      },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(normalizeProcessTitle(stdout));
      }
    );
  });
}

async function findForegroundProcess(rootPid) {
  if (!rootPid) {
    return "";
  }
  if (os.platform() === "win32") {
    return findWindowsForegroundProcess(rootPid);
  }
  return "";
}

export function attachWorkspaceTerminalServer(server, options = {}) {
  const cwd = options.cwd || process.cwd();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/api/workspace/terminal") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    const shellTitle = resolveShellTitle();
    let lastSentTitle = shellTitle;
    let titlePollInFlight = false;
    let titlePoll = null;

    function sendTitle(title) {
      const nextTitle = String(title ?? "").trim();
      if (!nextTitle || nextTitle === lastSentTitle) {
        return;
      }
      lastSentTitle = nextTitle;
      sendJson(socket, {
        type: "title",
        title: nextTitle
      });
    }

    sendJson(socket, {
      type: "meta",
      cwd,
      title: shellTitle
    });

    sendJson(socket, {
      type: "title",
      title: shellTitle
    });

    const shell = createShellProcess(cwd);

    function startTitlePolling() {
      if (titlePoll) {
        return;
      }

      titlePoll = setInterval(async () => {
        if (titlePollInFlight || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        titlePollInFlight = true;
        try {
          const processTitle = await findForegroundProcess(shell.pid);
          const nextTitle = processTitle || shellTitle;
          sendTitle(nextTitle);
        } finally {
          titlePollInFlight = false;
        }
      }, PROCESS_TITLE_POLL_MS);
    }

    const commandTracker = createInputCommandTracker({
      shellTitle,
      sendTitle,
      onCommandStart: startTitlePolling
    });

    const dataDisposable = shell.onData((chunk) => {
      sendJson(socket, {
        type: "output",
        data: chunk
      });
    });

    const exitDisposable = shell.onExit((event) => {
      sendJson(socket, {
        type: "exit",
        code: event.exitCode
      });
      socket.close();
    });

    socket.on("message", (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString("utf8"));
      } catch {
        return;
      }

      if (message?.type === "input" && typeof message.data === "string") {
        commandTracker.handleInput(message.data);
        shell.write(message.data);
        return;
      }

      if (message?.type === "resize") {
        const cols = Number(message.cols);
        const rows = Number(message.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
          shell.resize(Math.floor(cols), Math.floor(rows));
        }
      }
    });

    socket.on("close", () => {
      if (titlePoll) {
        clearInterval(titlePoll);
      }
      dataDisposable.dispose();
      exitDisposable.dispose();
      shell.kill();
    });
  });

  return wss;
}
