import { useEffect, useMemo, useRef, useState } from "react";

import {
  commitWorkspaceGitChanges,
  fetchWorkspaceGitBranchHistory,
  fetchWorkspaceGitCommitDiff,
  fetchWorkspaceGitDiff,
  fetchWorkspaceGitState,
  initWorkspaceGit,
  pushWorkspaceGitChanges,
  stageWorkspaceGitFiles,
  revertWorkspaceGitFiles,
  streamWorkspaceGitCommitMessage
} from "../../api/workspaceApi";

function normalizeGitPathList(paths = []) {
  const seen = new Set();
  const normalized = [];

  for (const inputPath of Array.isArray(paths) ? paths : []) {
    const nextPath = String(inputPath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!nextPath || seen.has(nextPath)) {
      continue;
    }
    seen.add(nextPath);
    normalized.push(nextPath);
  }

  return normalized;
}

function compareBranchGroup(left, right) {
  const leftCurrent = Boolean(left?.local?.isCurrent);
  const rightCurrent = Boolean(right?.local?.isCurrent);
  if (leftCurrent !== rightCurrent) {
    return leftCurrent ? -1 : 1;
  }

  const leftLocal = Boolean(left?.local);
  const rightLocal = Boolean(right?.local);
  if (leftLocal !== rightLocal) {
    return leftLocal ? -1 : 1;
  }

  return String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "zh-CN");
}

function groupGitBranches(gitState) {
  const groups = new Map();
  const localBranches = Array.isArray(gitState?.localBranches) ? gitState.localBranches : [];
  const remoteBranches = Array.isArray(gitState?.remoteBranches) ? gitState.remoteBranches : [];

  function ensureGroup(name) {
    const normalizedName = String(name ?? "").trim();
    if (!normalizedName) {
      return null;
    }
    if (!groups.has(normalizedName)) {
      groups.set(normalizedName, {
        name: normalizedName,
        local: null,
        remotes: [],
        remoteRefs: [],
        ahead: 0,
        behind: 0,
        isCurrent: false
      });
    }
    return groups.get(normalizedName);
  }

  for (const localBranch of localBranches) {
    const group = ensureGroup(localBranch?.name);
    if (!group) {
      continue;
    }
    group.local = localBranch;
    group.ahead = Number(localBranch?.ahead ?? group.ahead ?? 0) || 0;
    group.behind = Number(localBranch?.behind ?? group.behind ?? 0) || 0;
    group.isCurrent = Boolean(localBranch?.isCurrent);
  }

  for (const remoteBranch of remoteBranches) {
    const group = ensureGroup(remoteBranch?.name);
    if (!group) {
      continue;
    }
    group.remotes.push(remoteBranch);
    group.remoteRefs.push(remoteBranch?.ref ?? remoteBranch?.name ?? "");
  }

  return Array.from(groups.values()).sort(compareBranchGroup);
}

function derivePrimaryAction(gitState, selectedPaths) {
  const hasSelection = normalizeGitPathList(selectedPaths).length > 0;
  const hasChanges = Number(gitState?.stagedCount ?? 0) > 0 || Number(gitState?.dirtyCount ?? 0) > 0;

  if (!gitState?.gitAvailable) {
    return {
      type: "unavailable",
      icon: "git",
      label: "git 不可用",
      disabled: true
    };
  }

  if (!gitState?.isRepo) {
    return {
      type: "init",
      icon: "git",
      label: "初始化 Git",
      disabled: false
    };
  }

  if (hasSelection) {
    return {
      type: "commit",
      icon: "commit",
      label: "commit",
      disabled: false
    };
  }

  if (hasChanges) {
    return {
      type: "commit",
      icon: "commit",
      label: "commit",
      disabled: false
    };
  }

  if (gitState?.canPush) {
    return {
      type: "push",
      icon: "push",
      label: "push",
      disabled: false
    };
  }

  return {
    type: "idle",
    icon: "commit",
    label: "无操作",
    disabled: true
  };
}

function pickDefaultPreviewPath(gitState, previousPath = "") {
  const filePaths = Array.isArray(gitState?.files) ? gitState.files.map((item) => item?.path).filter(Boolean) : [];
  if (previousPath && filePaths.includes(previousPath)) {
    return previousPath;
  }
  return filePaths[0] ?? "";
}

export function useWorkspaceGitSession({ workspaceRoot = "", enabled = false } = {}) {
  const [gitState, setGitState] = useState(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitPreview, setGitPreview] = useState(null);
  const [gitPreviewLoading, setGitPreviewLoading] = useState(false);
  const [branchGitPreview, setBranchGitPreview] = useState(null);
  const [branchGitPreviewLoading, setBranchGitPreviewLoading] = useState(false);
  const [gitMessage, setGitMessage] = useState("");
  const [gitMessageStreaming, setGitMessageStreaming] = useState(false);
  const [gitActionBusy, setGitActionBusy] = useState("");
  const [selectedGitPaths, setSelectedGitPaths] = useState([]);
  const [selectedGitPath, setSelectedGitPath] = useState("");
  const [selectedBranchGitPreviewKey, setSelectedBranchGitPreviewKey] = useState("");
  const [expandedBranchNames, setExpandedBranchNames] = useState([]);
  const [branchHistories, setBranchHistories] = useState({});
  const [branchHistoryLoading, setBranchHistoryLoading] = useState({});
  const gitStateRequestIdRef = useRef(0);
  const gitPreviewRequestIdRef = useRef(0);
  const branchGitPreviewRequestIdRef = useRef(0);
  const gitMessageAbortRef = useRef(null);
  const branchHistoryRequestIdsRef = useRef(new Map());

  const branchGroups = useMemo(() => groupGitBranches(gitState), [gitState]);
  const expandedBranchSet = useMemo(() => new Set(expandedBranchNames), [expandedBranchNames]);
  const primaryAction = useMemo(
    () => derivePrimaryAction(gitState, selectedGitPaths),
    [gitState, selectedGitPaths]
  );
  const selectedPathSet = useMemo(() => new Set(selectedGitPaths), [selectedGitPaths]);
  const candidatePaths = useMemo(() => {
    if (selectedGitPaths.length > 0) {
      return normalizeGitPathList(selectedGitPaths);
    }
    return normalizeGitPathList(gitState?.dirtyPaths ?? []);
  }, [gitState, selectedGitPaths]);

  function clearBranchGitPreview() {
    branchGitPreviewRequestIdRef.current += 1;
    setBranchGitPreview(null);
    setBranchGitPreviewLoading(false);
    setSelectedBranchGitPreviewKey("");
  }

  async function refreshGitState() {
    if (!enabled) {
      return null;
    }

    const requestId = gitStateRequestIdRef.current + 1;
    gitStateRequestIdRef.current = requestId;
    setGitLoading(true);
    setGitError("");

    try {
      const state = await fetchWorkspaceGitState(workspaceRoot);
      if (gitStateRequestIdRef.current !== requestId) {
        return state;
      }

      setGitState(state);

      setSelectedGitPaths((current) =>
        normalizeGitPathList(current).filter((item) =>
          Array.isArray(state?.files) ? state.files.some((file) => file?.path === item) : false
        )
      );

      const nextPreviewPath = pickDefaultPreviewPath(state, selectedGitPath);
      setSelectedGitPath(nextPreviewPath);
      clearBranchGitPreview();
      return state;
    } catch (error) {
      if (gitStateRequestIdRef.current === requestId) {
        setGitError(error?.message || "加载 Git 状态失败");
      }
      return null;
    } finally {
      if (gitStateRequestIdRef.current === requestId) {
        setGitLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let mounted = true;
    const previousSelectedPath = selectedGitPath;

    async function loadGitState() {
      const state = await refreshGitState();
      if (!mounted) {
        return;
      }

      const nextPath = pickDefaultPreviewPath(state, previousSelectedPath);
      if (nextPath && nextPath !== selectedGitPath) {
        setSelectedGitPath(nextPath);
      }
    }

    loadGitState();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceRoot]);

  useEffect(() => {
    if (!enabled || !selectedGitPath) {
      setGitPreview(null);
      return undefined;
    }

    const requestId = gitPreviewRequestIdRef.current + 1;
    gitPreviewRequestIdRef.current = requestId;
    setGitPreviewLoading(true);
    setGitError("");

    let mounted = true;

    async function loadPreview() {
      try {
        const preview = await fetchWorkspaceGitDiff(selectedGitPath, workspaceRoot);
        if (!mounted || gitPreviewRequestIdRef.current !== requestId) {
          return;
        }
        setGitPreview(preview);
      } catch (error) {
        if (mounted && gitPreviewRequestIdRef.current === requestId) {
          setGitError(error?.message || "加载 diff 失败");
          setGitPreview(null);
        }
      } finally {
        if (mounted && gitPreviewRequestIdRef.current === requestId) {
          setGitPreviewLoading(false);
        }
      }
    }

    loadPreview();

    return () => {
      mounted = false;
    };
  }, [enabled, selectedGitPath, workspaceRoot]);

  useEffect(() => {
    return () => {
      gitMessageAbortRef.current?.abort?.();
    };
  }, []);

  useEffect(() => {
    setExpandedBranchNames([]);
    setBranchHistories({});
    setBranchHistoryLoading({});
    branchHistoryRequestIdsRef.current = new Map();
    clearBranchGitPreview();
  }, [workspaceRoot]);

  function toggleGitSelection(path) {
    const normalizedPath = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedPath) {
      return;
    }

    clearBranchGitPreview();

    setSelectedGitPaths((current) => {
      const next = current.includes(normalizedPath)
        ? current.filter((item) => item !== normalizedPath)
        : [...current, normalizedPath];
      return next;
    });
  }

  function clearGitSelection() {
    setSelectedGitPaths([]);
  }

  function selectGitPath(path) {
    clearBranchGitPreview();
    const normalizedPath = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    setSelectedGitPath(normalizedPath);
  }

  async function selectBranchGitFile(commit, file) {
    const normalizedCommit = String(commit?.fullCommit ?? commit?.commit ?? "").trim();
    const normalizedPath = String(file?.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedCommit || !normalizedPath || !enabled) {
      return null;
    }

    const previewKey = `${normalizedCommit}:${normalizedPath}`;
    const requestId = branchGitPreviewRequestIdRef.current + 1;
    branchGitPreviewRequestIdRef.current = requestId;
    setSelectedBranchGitPreviewKey(previewKey);
    setBranchGitPreviewLoading(true);
    setGitError("");

    try {
      const preview = await fetchWorkspaceGitCommitDiff(workspaceRoot, normalizedCommit, normalizedPath);
      if (branchGitPreviewRequestIdRef.current !== requestId) {
        return preview;
      }
      setBranchGitPreview(preview);
      return preview;
    } catch (error) {
      if (branchGitPreviewRequestIdRef.current === requestId) {
        setGitError(error?.message || "加载提交 diff 失败");
        setBranchGitPreview(null);
        setSelectedBranchGitPreviewKey("");
      }
      return null;
    } finally {
      if (branchGitPreviewRequestIdRef.current === requestId) {
        setBranchGitPreviewLoading(false);
      }
    }
  }

  async function loadBranchHistory(branchName) {
    const normalizedBranch = String(branchName ?? "").trim();
    if (!normalizedBranch || !enabled) {
      return null;
    }

    const requestId = (branchHistoryRequestIdsRef.current.get(normalizedBranch) ?? 0) + 1;
    branchHistoryRequestIdsRef.current.set(normalizedBranch, requestId);
    setBranchHistoryLoading((current) => ({
      ...current,
      [normalizedBranch]: true
    }));

    try {
      const history = await fetchWorkspaceGitBranchHistory(workspaceRoot, normalizedBranch, 6);
      if (branchHistoryRequestIdsRef.current.get(normalizedBranch) !== requestId) {
        return history;
      }

      setBranchHistories((current) => ({
        ...current,
        [normalizedBranch]: history
      }));
      return history;
    } catch (error) {
      if (branchHistoryRequestIdsRef.current.get(normalizedBranch) === requestId) {
        setGitError(error?.message || "加载分支历史失败");
      }
      return null;
    } finally {
      if (branchHistoryRequestIdsRef.current.get(normalizedBranch) === requestId) {
        setBranchHistoryLoading((current) => ({
          ...current,
          [normalizedBranch]: false
        }));
      }
    }
  }

  function toggleBranchExpansion(branchName) {
    const normalizedBranch = String(branchName ?? "").trim();
    if (!normalizedBranch) {
      return;
    }

    setExpandedBranchNames((current) => {
      const isExpanded = current.includes(normalizedBranch);
      const next = isExpanded
        ? current.filter((item) => item !== normalizedBranch)
        : [...current, normalizedBranch];
      return next;
    });

    if (!expandedBranchSet.has(normalizedBranch) && !branchHistories[normalizedBranch] && !branchHistoryLoading[normalizedBranch]) {
      void loadBranchHistory(normalizedBranch);
    }
  }

  async function generateCommitMessage(explicitPaths = null) {
    const paths = normalizeGitPathList(explicitPaths ?? candidatePaths);
    if (paths.length === 0) {
      const error = new Error("没有可用于生成 commit 描述的 diff");
      setGitError(error.message);
      return "";
    }

    gitMessageAbortRef.current?.abort?.();
    const controller = new AbortController();
    gitMessageAbortRef.current = controller;

    setGitMessageStreaming(true);
    setGitError("");

    let mergedText = "";
    try {
      await streamWorkspaceGitCommitMessage({
        root: workspaceRoot,
        paths,
        signal: controller.signal,
        onMessage: (message) => {
          if (message.event === "error") {
            throw new Error(message.data?.message || "commit message generation failed");
          }

          if (message.event === "delta") {
            const nextText = String(message.data?.mergedText ?? message.data?.text ?? "");
            if (nextText) {
              mergedText = nextText;
              setGitMessage(nextText);
            }
            return;
          }

          if (message.event === "final") {
            const nextText = String(message.data?.text ?? mergedText).trim();
            if (nextText) {
              mergedText = nextText;
              setGitMessage(nextText);
            }
          }
        }
      });

      const finalText = String(mergedText ?? "").trim();
      if (finalText) {
        setGitMessage(finalText);
      }
      return finalText;
    } catch (error) {
      setGitError(error?.message || "commit message generation failed");
      return "";
    } finally {
      if (gitMessageAbortRef.current === controller) {
        gitMessageAbortRef.current = null;
      }
      setGitMessageStreaming(false);
    }
  }

  async function initGit() {
    if (!enabled) {
      return null;
    }

    setGitActionBusy("init");
    try {
      const state = await initWorkspaceGit(workspaceRoot);
      setGitState(state);
      clearBranchGitPreview();
      setSelectedGitPath(pickDefaultPreviewPath(state));
      clearGitSelection();
      return state;
    } catch (error) {
      setGitError(error?.message || "初始化 Git 失败");
      return null;
    } finally {
      setGitActionBusy("");
      await refreshGitState();
    }
  }

  async function revertGitPath(path) {
    const normalizedPath = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedPath) {
      return null;
    }

    setGitActionBusy(`revert:${normalizedPath}`);
    try {
      const state = await revertWorkspaceGitFiles(workspaceRoot, [normalizedPath]);
      clearGitSelection();
      clearBranchGitPreview();
      setGitState(state);
      setSelectedGitPath(pickDefaultPreviewPath(state, normalizedPath));
      return state;
    } catch (error) {
      setGitError(error?.message || "回退文件失败");
      return null;
    } finally {
      setGitActionBusy("");
      await refreshGitState();
    }
  }

  async function executePrimaryAction() {
    if (!gitState) {
      return null;
    }

    if (!gitState.gitAvailable) {
      return null;
    }

    if (!gitState.isRepo) {
      return initGit();
    }

    const hasSelection = normalizeGitPathList(selectedGitPaths).length > 0;
    const hasChanges = Number(gitState?.stagedCount ?? 0) > 0 || Number(gitState?.dirtyCount ?? 0) > 0;

    if (!hasSelection && hasChanges) {
      const pathsToCommit = normalizeGitPathList(gitState?.dirtyPaths ?? []);
      if (pathsToCommit.length === 0) {
        return null;
      }

      setGitActionBusy("commit");
      try {
        await stageWorkspaceGitFiles(workspaceRoot, pathsToCommit, true);
        await commitWorkspaceGitChanges(
          workspaceRoot,
          gitMessage.trim() || (await generateCommitMessage(pathsToCommit))
        );
        clearGitSelection();
        clearBranchGitPreview();
        setGitMessage("");
        setSelectedGitPath(pickDefaultPreviewPath(gitState, ""));
        return await refreshGitState();
      } catch (error) {
        setGitError(error?.message || "commit 失败");
        return null;
      } finally {
        setGitActionBusy("");
      }
    }

    if (!hasSelection && gitState.canPush) {
      setGitActionBusy("push");
      try {
        const result = await pushWorkspaceGitChanges(workspaceRoot);
        clearGitSelection();
        clearBranchGitPreview();
        setGitState(result);
        setSelectedGitPath(pickDefaultPreviewPath(result, selectedGitPath));
        return result;
      } catch (error) {
        setGitError(error?.message || "push 失败");
        return null;
      } finally {
        setGitActionBusy("");
        await refreshGitState();
      }
    }

    const pathsToCommit = hasSelection
      ? normalizeGitPathList(selectedGitPaths)
      : candidatePaths;

    if (pathsToCommit.length === 0) {
      if (gitState.canPush) {
        return executePrimaryAction();
      }
      return null;
    }

    setGitActionBusy("commit");
    try {
      await stageWorkspaceGitFiles(workspaceRoot, pathsToCommit, true);
      await commitWorkspaceGitChanges(
        workspaceRoot,
        gitMessage.trim() || (await generateCommitMessage(pathsToCommit))
      );
      clearGitSelection();
      clearBranchGitPreview();
      setGitMessage("");
      setSelectedGitPath(pickDefaultPreviewPath(gitState, ""));
      return await refreshGitState();
    } catch (error) {
      setGitError(error?.message || "commit 失败");
      return null;
    } finally {
      setGitActionBusy("");
    }
  }

  const selectedGitFiles = useMemo(() => {
    const fileMap = new Map((Array.isArray(gitState?.files) ? gitState.files : []).map((item) => [item.path, item]));
    return normalizeGitPathList(selectedGitPaths)
      .map((path) => fileMap.get(path))
      .filter(Boolean);
  }, [gitState, selectedGitPaths]);

  return {
    gitState,
    gitLoading,
    gitError,
    gitPreview,
    gitPreviewLoading,
    branchGitPreview,
    branchGitPreviewLoading,
    gitMessage,
    setGitMessage,
    gitMessageStreaming,
    gitActionBusy,
    selectedGitPath,
    selectedBranchGitPreviewKey,
    selectedGitPaths,
    selectedGitFiles,
    selectedPathSet,
    branchGroups,
    expandedBranchNames,
    expandedBranchSet,
    branchHistories,
    branchHistoryLoading,
    primaryAction,
    candidatePaths,
    refreshGitState,
    selectGitPath,
    selectBranchGitFile,
    toggleGitSelection,
    clearGitSelection,
    toggleBranchExpansion,
    generateCommitMessage,
    executePrimaryAction,
    initGit,
    revertGitPath
  };
}
