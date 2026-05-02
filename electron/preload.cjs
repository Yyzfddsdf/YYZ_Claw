const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yyzClaw", {
  openWorkspaceWindow(workspaceRoot = "") {
    ipcRenderer.send("workspace:open", String(workspaceRoot || ""));
  }
});
