const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yyzClaw", {
  openWorkspaceWindow() {
    ipcRenderer.send("workspace:open");
  }
});
