const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yyzClaw", {
  openWorkspaceWindow(workspaceRoot = "") {
    ipcRenderer.send("workspace:open", String(workspaceRoot || ""));
  },
  openPetWindow(payload = {}) {
    ipcRenderer.send("pet:open", payload);
  },
  updatePetWindow(payload = {}) {
    ipcRenderer.send("pet:update", payload);
  },
  onPetUpdate(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const listener = (_event, payload) => callback(payload ?? {});
    ipcRenderer.on("pet:update", listener);
    return () => ipcRenderer.removeListener("pet:update", listener);
  },
  movePetWindow(payload = {}) {
    ipcRenderer.send("pet:move", payload);
  },
  dragPetWindow(payload = {}) {
    ipcRenderer.send("pet:drag", payload);
  },
  openPetConversation(conversationId = "") {
    ipcRenderer.send("pet:conversation:open", String(conversationId || ""));
  },
  onOpenPetConversation(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const listener = (_event, conversationId) => callback(String(conversationId || ""));
    ipcRenderer.on("pet:conversation:open", listener);
    return () => ipcRenderer.removeListener("pet:conversation:open", listener);
  },
  closePetWindow() {
    ipcRenderer.send("pet:close");
  }
});
