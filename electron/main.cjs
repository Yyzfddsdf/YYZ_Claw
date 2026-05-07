const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const SERVER_URL = process.env.YYZ_CLAW_SERVER_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const PRELOAD_FILE = path.join(__dirname, "preload.cjs");
const APP_ICON_FILE = path.join(PROJECT_ROOT, "frontend", "src", "assets", "yyz-claw-icon.png");
const DEV_TRAY_ICON_FILE = path.join(PROJECT_ROOT, "build", "icons", "icon.ico");
const PET_WINDOW_WIDTH = 260;
const PET_WINDOW_HEIGHT = 176;
const DEFAULT_ASSET_DIR_CANDIDATES = [
  path.join(PROJECT_ROOT, "resources", "defaults"),
  path.join(process.resourcesPath || "", "resources", "defaults"),
  path.join(process.resourcesPath || "", "defaults")
].filter(Boolean);

let backendProcess = null;
let mainWindow = null;
let workspaceWindow = null;
let petWindow = null;
let tray = null;
let quitting = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function buildStartupPage(message = "正在启动 YYZ_CLAW 服务...") {
  const safeMessage = String(message || "正在启动 YYZ_CLAW 服务...")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "<meta charset=\"UTF-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    "<title>YYZ_CLAW</title>",
    "<style>",
    "html,body{height:100%;margin:0;background:#101418;color:#f6efe5;font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;}",
    "body{display:grid;place-items:center;overflow:hidden;}",
    ".shell{width:min(460px,80vw);padding:34px 36px;border:1px solid rgba(255,255,255,.12);border-radius:26px;background:linear-gradient(145deg,rgba(255,255,255,.12),rgba(255,255,255,.05));box-shadow:0 28px 80px rgba(0,0,0,.38);}",
    ".brand{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:800;letter-spacing:.04em;}",
    ".orb{width:46px;height:46px;border-radius:18px;background:linear-gradient(135deg,#ffcf8b,#f28c7b 48%,#7ac7d7);box-shadow:0 0 36px rgba(242,140,123,.38);}",
    ".msg{margin-top:18px;color:#d9cdbc;font-size:14px;line-height:1.7;}",
    ".bar{position:relative;height:7px;margin-top:24px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden;}",
    ".bar::after{content:'';position:absolute;inset:0;width:42%;border-radius:inherit;background:linear-gradient(90deg,#ffd08a,#ff8f73);animation:run 1.25s ease-in-out infinite;}",
    "@keyframes run{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}",
    "</style>",
    "</head>",
    "<body>",
    "<main class=\"shell\">",
    "<div class=\"brand\"><div class=\"orb\"></div><div>YYZ_CLAW</div></div>",
    `<div class="msg">${safeMessage}</div>`,
    "<div class=\"bar\"></div>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function loadStartupPage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildStartupPage(message))}`);
}

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

  const appRoot = app.isPackaged ? app.getAppPath() : PROJECT_ROOT;
  const serviceCwd = app.isPackaged ? path.dirname(process.execPath) : PROJECT_ROOT;
  const defaultAssetsDir =
    DEFAULT_ASSET_DIR_CANDIDATES.find((candidate) => require("node:fs").existsSync(candidate)) ||
    DEFAULT_ASSET_DIR_CANDIDATES[0];
  const serviceEntry = path.join(appRoot, "service.js");
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutLog = fs.openSync(path.join(logDir, "backend.out.log"), "a");
  const stderrLog = fs.openSync(path.join(logDir, "backend.err.log"), "a");

  const child = spawn(process.execPath, [serviceEntry], {
    cwd: serviceCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      YYZ_CLAW_SKIP_FRONTEND_BUILD: app.isPackaged ? "1" : "",
      YYZ_CLAW_USE_BACKEND_DIST: app.isPackaged ? "1" : "",
      PORT: String(DEFAULT_PORT),
      YYZ_CLAW_DEFAULTS_DIR: defaultAssetsDir
    },
    stdio: app.isPackaged ? ["ignore", stdoutLog, stderrLog] : "inherit",
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

  loadStartupPage();

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
      const parsedUrl = new URL(url);
      openWorkspaceWindow(parsedUrl.searchParams.get("root") || "");
      return { action: "deny" };
    }

    return { action: "allow" };
  });
}

function buildWorkspaceWindowUrl(workspaceRoot = "") {
  const normalizedRoot = String(workspaceRoot || "").trim();
  const nextUrl = new URL("/workspace-window", SERVER_URL);
  if (normalizedRoot) {
    nextUrl.searchParams.set("root", normalizedRoot);
  }
  return nextUrl.toString();
}

function buildPetWindowUrl(payload = {}) {
  const nextUrl = new URL("/pet-window", SERVER_URL);
  const { selectedPet, activeSessions } = normalizePetPayload(payload);
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (selectedPet) {
    nextUrl.searchParams.set("selectedPet", selectedPet);
  }
  if (activeSessions.length > 0) {
    nextUrl.searchParams.set("activeSessions", JSON.stringify(activeSessions));
  }
  if (Number.isFinite(x)) {
    nextUrl.searchParams.set("x", String(Math.round(x)));
  }
  if (Number.isFinite(y)) {
    nextUrl.searchParams.set("y", String(Math.round(y)));
  }
  return nextUrl.toString();
}

function resolveTrayIconFile() {
  const packagedTrayIcon = path.join(process.resourcesPath || "", "icon.ico");
  if (app.isPackaged && fs.existsSync(packagedTrayIcon)) {
    return packagedTrayIcon;
  }
  if (fs.existsSync(DEV_TRAY_ICON_FILE)) {
    return DEV_TRAY_ICON_FILE;
  }
  return APP_ICON_FILE;
}

function normalizePetPayload(payload = {}) {
  return {
    selectedPet: String(payload?.selectedPet || "").trim(),
    activeSessions: Array.isArray(payload?.activeSessions)
      ? payload.activeSessions
          .map((item) => ({
            conversationId: String(item?.conversationId ?? "").trim(),
            title: String(item?.title ?? "").trim()
          }))
          .filter((item) => item.conversationId && item.title)
          .slice(0, 3)
      : []
  };
}

function sendPetUpdate(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const normalizedPayload = normalizePetPayload(payload);
  if (petWindow.webContents.isLoading()) {
    petWindow.webContents.once("did-finish-load", () => {
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send("pet:update", normalizedPayload);
      }
    });
    return;
  }
  petWindow.webContents.send("pet:update", normalizedPayload);
}

function openWorkspaceWindow(workspaceRoot = "") {
  const targetUrl = buildWorkspaceWindowUrl(workspaceRoot);
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.loadURL(targetUrl);
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

  workspaceWindow.loadURL(targetUrl);
  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow.show();
  });
  workspaceWindow.on("closed", () => {
    workspaceWindow = null;
  });
}

function openPetWindow(payload = {}) {
  const targetUrl = buildPetWindowUrl(payload);
  const x = Number(payload?.x);
  const y = Number(payload?.y);

  if (petWindow && !petWindow.isDestroyed()) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      petWindow.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: PET_WINDOW_WIDTH,
        height: PET_WINDOW_HEIGHT
      });
    }
    sendPetUpdate(payload);
    petWindow.showInactive();
    return;
  }

  petWindow = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    x: Number.isFinite(x) ? Math.round(x) : undefined,
    y: Number.isFinite(y) ? Math.round(y) : undefined,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: "YYZ_CLAW Pet",
    icon: APP_ICON_FILE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD_FILE
    }
  });

  petWindow.setMenuBarVisibility(false);
  petWindow.setAlwaysOnTop(true);
  petWindow.setBackgroundColor("#00000000");
  petWindow.setMinimumSize(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT);
  petWindow.setMaximumSize(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT);
  petWindow.loadURL(targetUrl);
  petWindow.once("ready-to-show", () => {
    petWindow?.showInactive();
  });
  petWindow.on("closed", () => {
    petWindow = null;
  });
}

function movePetWindow(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  petWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT
  });
}

function updatePetWindow(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    openPetWindow(payload);
    return;
  }
  sendPetUpdate(payload);
}

function dragPetWindow(payload = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const dx = Number(payload?.dx);
  const dy = Number(payload?.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return;
  }
  const bounds = petWindow.getBounds();
  petWindow.setBounds({
    x: Math.round(bounds.x + dx),
    y: Math.round(bounds.y + dy),
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT
  });
}

function closePetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close();
  }
}

function openPetConversation(conversationId = "") {
  const normalizedId = String(conversationId || "").trim();
  if (!normalizedId || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("pet:conversation:open", normalizedId);
}

function createTray() {
  const iconPath = resolveTrayIconFile();
  const icon = nativeImage.createFromPath(iconPath);
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
        click: () => openWorkspaceWindow()
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

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    backendProcess = startBackendService();
    ipcMain.on("workspace:open", (_event, workspaceRoot) => openWorkspaceWindow(workspaceRoot));
    ipcMain.on("pet:open", (_event, payload) => openPetWindow(payload));
    ipcMain.on("pet:update", (_event, payload) => updatePetWindow(payload));
    ipcMain.on("pet:move", (_event, payload) => movePetWindow(payload));
    ipcMain.on("pet:drag", (_event, payload) => dragPetWindow(payload));
    ipcMain.on("pet:conversation:open", (_event, conversationId) =>
      openPetConversation(conversationId)
    );
    ipcMain.on("pet:close", () => closePetWindow());
    createMainWindow();
    createTray();

    waitForServer(SERVER_URL)
      .then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(SERVER_URL);
        }
      })
      .catch((error) => {
        console.error("[electron] service startup failed", error);
        loadStartupPage(`YYZ_CLAW 服务启动失败：${error?.message ?? "unknown error"}`);
      });
  });
}

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.destroy();
  }
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
});
