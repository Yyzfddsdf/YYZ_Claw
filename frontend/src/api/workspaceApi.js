import { requestJson } from "./httpClient";

export function fetchWorkspaceInfo() {
  return requestJson("/workspace");
}

export function fetchWorkspaceTree(path = "") {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestJson(`/workspace/tree${query}`);
}

export function readWorkspaceFile(path) {
  return requestJson(`/workspace/files?path=${encodeURIComponent(path)}`);
}

export function writeWorkspaceFile(path, content) {
  return requestJson("/workspace/files", {
    method: "PUT",
    body: {
      path,
      content
    }
  });
}
