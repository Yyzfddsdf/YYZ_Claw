import { requestJson } from "./httpClient";

function buildWorkspaceQuery(params = {}) {
  const query = new URLSearchParams();
  const root = String(params.root ?? params.workspaceRoot ?? "").trim();
  if (root) {
    query.set("root", root);
  }
  const path = String(params.path ?? "").trim();
  if (path) {
    query.set("path", path);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export function fetchWorkspaceInfo(root = "") {
  return requestJson(`/workspace${buildWorkspaceQuery({ root })}`);
}

export function fetchWorkspaceTree(path = "", root = "") {
  return requestJson(`/workspace/tree${buildWorkspaceQuery({ path, root })}`);
}

export function readWorkspaceFile(path, root = "") {
  return requestJson(`/workspace/files${buildWorkspaceQuery({ path, root })}`);
}

export function writeWorkspaceFile(path, content, root = "") {
  return requestJson("/workspace/files", {
    method: "PUT",
    body: {
      root,
      path,
      content
    }
  });
}
