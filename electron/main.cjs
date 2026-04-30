const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const SERVER_URL = process.env.YYZ_CLAW_SERVER_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const PRELOAD_FILE = path.join(__dirname, "preload.cjs");
const APP_ICON_FILE = path.join(PROJECT_ROOT, "frontend", "src", "assets", "yyz-claw-icon.png");
const DEFAULT_ASSET_DIR_CANDIDATES = [
  path.join(PROJECT_ROOT, "resources", "defaults"),
  path.join(process.resourcesPath || "", "resources", "defaults"),
  path.join(process.resourcesPath || "", "defaults")
].filter(Boolean);

let backendProcess = null;
let mainWindow = null;
let workspaceWindow = null;
let tray = null;
let quitting = false;

function waitForServer(url, timeoutMs = 90000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function ping() {
      const request = http.get(`${url}/health`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.on("error", retry);
      request.setTimeout(2500, () => {
        request.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("YYZ_CLAW service startup timed out"));
        return;
      }
      setTimeout(ping, 650);
    }

    ping();
  });
}

function startBackendService() {
  if (process.env.YYZ_CLAW_SERVER_URL) {
    return null;
  }

  const defaultAssetsDir =
    DEFAULT_ASSET_DIR_CANDIDATES.find((candidate) => require("node:fs").existsSync(candidate)) ||
    DEFAULT_ASSET_DIR_CANDIDATES[0];
  const serviceEntry = path.join(PROJECT_ROOT, "service.js");

  const child = spawn(process.execPath, [serviceEntry], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      YYZ_CLAW_SKIP_FRONTEND_BUILD: app.isPackaged ? "1" : "",
      PORT: String(DEFAULT_PORT),
      YYZ_CLAW_DEFAULTS_DIR: defaultAssetsDir
    },
    stdio: "inherit",
    windowsHide: true
  });

  child.on("exit", (code, signal) => {
    if (!quitting) {
      console.error(`[electron] backend exited: code=${code} signal=${signal}`);
    }
  });

  return child;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: "YYZ_CLAW",
    icon: APP_ICON_FILE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD_FILE
    }
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes("/workspace-window")) {
      openWorkspaceWindow();
      return { action: "deny" };
    }

    return { action: "allow" };
  });
}

function openWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.show();
    workspaceWindow.focus();
    return;
  }

  workspaceWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "YYZ_CLAW Workbench",
    icon: APP_ICON_FILE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD_FILE
    }
  });

  workspaceWindow.loadURL(`${SERVER_URL}/workspace-window`);
  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow.show();
  });
  workspaceWindow.on("closed", () => {
    workspaceWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON_FILE);
  tray = new Tray(icon);
  tray.setToolTip("YYZ_CLAW");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
      {
        label: "打开工作区",
        click: openWorkspaceWindow
      },
      { type: "separator" },
      {
        label: "退出 YYZ_CLAW",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

app.whenReady().then(async () => {
  backendProcess = startBackendService();
  await waitForServer(SERVER_URL);
  ipcMain.on("workspace:open", openWorkspaceWindow);
  createMainWindow();
  createTray();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
});
