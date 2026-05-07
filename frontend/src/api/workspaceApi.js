import { requestJson } from "./httpClient";
import { streamSseJson } from "./sseClient";

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
  const branch = String(params.branch ?? "").trim();
  if (branch) {
    query.set("branch", branch);
  }
  const commit = String(params.commit ?? "").trim();
  if (commit) {
    query.set("commit", commit);
  }
  const limit = Number(params.limit ?? 0);
  if (Number.isFinite(limit) && limit > 0) {
    query.set("limit", String(Math.floor(limit)));
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

export function fetchWorkspaceGitState(root = "") {
  return requestJson(`/workspace/git/state${buildWorkspaceQuery({ root })}`);
}

export function fetchWorkspaceGitDiff(path, root = "") {
  return requestJson(`/workspace/git/diff${buildWorkspaceQuery({ root, path })}`);
}

export function fetchWorkspaceGitCommitDiff(root = "", commit = "", path = "") {
  return requestJson(`/workspace/git/commit-diff${buildWorkspaceQuery({ root, commit, path })}`);
}

export function fetchWorkspaceGitBranchHistory(root = "", branch = "", limit = 6) {
  return requestJson(`/workspace/git/branch-history${buildWorkspaceQuery({ root, branch, limit })}`);
}

export function initWorkspaceGit(root = "") {
  return requestJson("/workspace/git/init", {
    method: "POST",
    body: {
      root
    }
  });
}

export function stageWorkspaceGitFiles(root = "", paths = [], staged = true) {
  return requestJson("/workspace/git/stage", {
    method: "POST",
    body: {
      root,
      paths,
      staged
    }
  });
}

export function commitWorkspaceGitChanges(root = "", message = "") {
  return requestJson("/workspace/git/commit", {
    method: "POST",
    body: {
      root,
      message
    }
  });
}

export function pushWorkspaceGitChanges(root = "") {
  return requestJson("/workspace/git/push", {
    method: "POST",
    body: {
      root
    }
  });
}

export function revertWorkspaceGitFiles(root = "", paths = []) {
  return requestJson("/workspace/git/revert", {
    method: "POST",
    body: {
      root,
      paths
    }
  });
}

export async function streamWorkspaceGitCommitMessage({ root = "", paths = [], signal, onMessage } = {}) {
  return streamSseJson({
    url: "/api/workspace/git/commit-message",
    body: {
      root,
      paths
    },
    signal,
    onMessage
  });
}
