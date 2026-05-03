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
  const searchQuery = String(params.query ?? "").trim();
  if (searchQuery) {
    query.set("query", searchQuery);
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

export function searchWorkspaceFiles(query = "", root = "") {
  return requestJson(`/workspace/search${buildWorkspaceQuery({ query, root })}`);
}

export function readWorkspaceFile(path, root = "") {
  return requestJson(`/workspace/files${buildWorkspaceQuery({ path, root })}`);
}

export function getWorkspaceAssetUrl(path, root = "") {
  return `/api/workspace/assets${buildWorkspaceQuery({ path, root })}`;
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
