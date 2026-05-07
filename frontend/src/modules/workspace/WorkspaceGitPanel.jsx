import { useRef, useState } from "react";

import { WorkspaceIcon, WorkspaceIconButton } from "./workspaceIcons";

function getBranchLeadMeta(branch, kind) {
  const ahead = Number(branch?.ahead ?? 0) || 0;
  const behind = Number(branch?.behind ?? 0) || 0;
  if (ahead > behind && ahead > 0) {
    return kind === "local"
      ? { label: `本地最新 ↑${ahead}`, tone: "local" }
      : { label: `远程最新 ↓${ahead}`, tone: "remote" };
  }
  if (behind > ahead && behind > 0) {
    return kind === "local"
      ? { label: `本地最新 ↓${behind}`, tone: "remote" }
      : { label: `远程最新 ↑${behind}`, tone: "local" };
  }
  return { label: "同步", tone: "sync" };
}

function renderTimelineEntry({
  commit,
  isExpanded,
  onToggle,
  onSelectBranchFile,
  selectedBranchGitPreviewKey,
  isHovered,
  onHoverStart,
  onHoverEnd
}) {
  const refs = Array.isArray(commit?.refs) ? commit.refs : [];
  const refChips = [];
  const seenChipText = new Set();

  for (const ref of refs) {
    const text = String(ref?.text ?? "").trim();
    if (!text || seenChipText.has(text)) {
      continue;
    }
    seenChipText.add(text);
    refChips.push({
      text,
      tone: ref?.tone || "sync"
    });
  }

  const statusChips = [];

  if (commit?.presenceLabel && !refChips.some((chip) => chip.text === commit.presenceLabel)) {
    statusChips.push({
      text: commit.presenceLabel,
      tone: commit.presenceLabel === "当前" ? "current" : commit.presenceLabel.includes("远程") ? "remote" : commit.presenceLabel.includes("本地") ? "local" : "upstream"
    });
  }

  const displayChips = [
    ...refChips.slice(0, 2),
    ...statusChips.slice(0, 1)
  ];

  const commitText = commit?.subject || "没有提交描述";
  const metaText = [
    commit?.commit ? `#${commit.commit}` : "",
    commit?.date || "",
    commit?.fileCount ? `${commit.fileCount} files` : ""
  ].filter(Boolean).join(" · ");
  const isCurrent = Boolean(commit?.isCurrentTip);
  const isRemoteOnly = Boolean(commit?.hasRemoteRef) && !Boolean(commit?.hasLocalRef);
  const isLocalOnly = Boolean(commit?.hasLocalRef) && !Boolean(commit?.hasRemoteRef);

  return (
    <section
      key={commit?.fullCommit || commit?.commit}
      className={`workspace-git-branch-item ${isCurrent ? "is-current" : ""} ${isExpanded ? "is-expanded" : ""} ${
        isHovered ? "is-hovered" : ""
      }`}
      onMouseEnter={(event) => onHoverStart?.(event, commit)}
      onMouseLeave={() => onHoverEnd?.()}
    >
      <button
        type="button"
        className={`workspace-git-branch-entry ${isRemoteOnly ? "is-remote" : "is-local"} ${isCurrent ? "is-current" : ""} ${
          commit?.hasLocalRef || commit?.hasRemoteRef ? "is-tracked" : ""
        }`}
        title={[commitText, metaText].filter(Boolean).join(" · ")}
        aria-expanded={isExpanded}
        onClick={onToggle}
      >
        <div className="workspace-git-branch-entry-rail" aria-hidden="true">
          <span
            className={`workspace-git-branch-dot ${
              isRemoteOnly ? "is-remote" : isLocalOnly ? "is-local" : "is-current"
            }`}
          />
        </div>
        <div className="workspace-git-branch-entry-main">
          <div className="workspace-git-branch-entry-head">
            <span className="workspace-git-branch-entry-name" title={commitText}>
              {commitText}
            </span>
            <div className="workspace-git-branch-entry-tags">
              {displayChips.map((chip) => (
                <span
                  key={`${commit?.fullCommit || commit?.commit}:${chip.text}`}
                  className={`workspace-git-chip is-${chip.tone === "tag" ? "sync" : chip.tone}`}
                >
                  {chip.text}
                </span>
              ))}
            </div>
          </div>
          <div className="workspace-git-branch-entry-meta">
            <span className="workspace-git-branch-commit">{commit?.commit ? `#${commit.commit}` : "—"}</span>
            <span className="workspace-git-branch-subject">{commit?.date || "未知日期"}</span>
            <span className="workspace-git-branch-counts">
              +{Number(commit?.insertions ?? 0) || 0} -{Number(commit?.deletions ?? 0) || 0} · {Number(commit?.fileCount ?? 0) || 0} files
            </span>
          </div>
        </div>
        <span className={`workspace-git-branch-entry-toggle ${isExpanded ? "is-expanded" : ""}`} aria-hidden="true">
          <WorkspaceIcon name="chevron" />
        </span>
      </button>
      {isExpanded && (
        <div className="workspace-git-branch-history">
          {renderBranchHistoryCommit(commit, {
            onSelectBranchFile,
            selectedBranchGitPreviewKey
          })}
        </div>
      )}
    </section>
  );
}

function renderBranchHistoryCommit(commit, { onSelectBranchFile, selectedBranchGitPreviewKey } = {}) {
  const files = Array.isArray(commit?.files) ? commit.files : [];

  return (
    <article key={commit.fullCommit || commit.commit} className="workspace-git-branch-history-commit">
      <div className="workspace-git-branch-history-head">
        <div className="workspace-git-branch-history-title">
          <span className="workspace-git-branch-history-sha">#{commit.commit || "—"}</span>
          <span className="workspace-git-branch-history-date">{commit.date || "未知日期"}</span>
        </div>
        <div className="workspace-git-branch-history-stats">
          <span className="workspace-git-branch-history-plus">+{Number(commit.insertions ?? 0) || 0}</span>
          <span className="workspace-git-branch-history-minus">-{Number(commit.deletions ?? 0) || 0}</span>
          <span className="workspace-git-branch-history-files">{files.length} files</span>
        </div>
      </div>
      <div className="workspace-git-branch-history-subject">{commit.subject || "没有提交描述"}</div>
      {files.length > 0 && (
        <div className="workspace-git-branch-history-file-list">
          {files.map((file) => {
            const fileKey = `${commit.fullCommit || commit.commit}:${file.path}`;
            const isActive = selectedBranchGitPreviewKey === fileKey;
            return (
              <button
                key={fileKey}
                type="button"
                className={`workspace-git-branch-history-file ${isActive ? "is-active" : ""}`}
                title={file.path}
                onClick={() => onSelectBranchFile?.(commit, file)}
              >
                <span className="workspace-git-branch-history-file-path">{file.path}</span>
                <span className="workspace-git-branch-history-file-stats">
                  +{Number(file.insertions ?? 0) || 0}/-{Number(file.deletions ?? 0) || 0}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

function getGitStatusMeta(entry) {
  if (entry?.untracked) {
    return {
      label: "未追踪",
      tone: "untracked"
    };
  }

  switch (entry?.changeKind) {
    case "added":
      return { label: "已添加", tone: "added" };
    case "deleted":
      return { label: "已删除", tone: "deleted" };
    case "renamed":
      return { label: "已重命名", tone: "renamed" };
    case "copied":
      return { label: "已复制", tone: "copied" };
    case "modified":
    default:
      return { label: "已修改", tone: "modified" };
  }
}

export function WorkspaceGitPanel({
  gitSession
}) {
  const {
    gitState,
    gitLoading,
    gitError,
    gitMessage,
    setGitMessage,
    gitMessageStreaming,
    gitActionBusy,
    selectedGitPath,
    selectedBranchGitPreviewKey,
    selectedPathSet,
    primaryAction,
    refreshGitState,
    selectGitPath,
    selectBranchGitFile,
    toggleGitSelection,
    clearGitSelection,
    generateCommitMessage,
    executePrimaryAction,
    initGit,
    revertGitPath
  } = gitSession;

  const [expandedTimelineCommits, setExpandedTimelineCommits] = useState([]);
  const [hoveredTimelinePreview, setHoveredTimelinePreview] = useState(null);
  const [branchSectionHeight, setBranchSectionHeight] = useState(224);
  const panelRef = useRef(null);
  const branchResizeDragRef = useRef(null);

  const gitAvailable = Boolean(gitState?.gitAvailable);
  const isRepo = Boolean(gitState?.isRepo);
  const selectedCount = selectedPathSet.size;
  const allFiles = Array.isArray(gitState?.files) ? gitState.files : [];
  const selectedFiles = allFiles.filter((entry) => selectedPathSet.has(entry.path));
  const remainingFiles = allFiles.filter((entry) => !selectedPathSet.has(entry.path));
  const remainingCount = remainingFiles.length;
  const timelineEntries = Array.isArray(gitState?.timeline?.commits) ? gitState.timeline.commits : [];
  const expandedTimelineSet = new Set(expandedTimelineCommits);
  const currentBranchEntry = Array.isArray(gitState?.localBranches)
    ? gitState.localBranches.find((branch) => branch?.isCurrent)
    : null;
  const branchSummary = [
    currentBranchEntry?.name ? `branch ${currentBranchEntry.name}` : gitState?.currentBranch ? `branch ${gitState.currentBranch}` : "",
    currentBranchEntry?.commit ? `#${currentBranchEntry.commit}` : "",
    gitState?.ahead ? `ahead ${gitState.ahead}` : "",
    gitState?.behind ? `behind ${gitState.behind}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const composerStateLabel = gitMessageStreaming
    ? "AI 生成中"
    : gitLoading
      ? "加载中"
      : branchSummary || "Git 面板";
  const composerCountLabel = selectedCount > 0
    ? `${selectedCount} 待提交 · ${remainingCount} 未提交`
    : `未提交 ${remainingCount}`;

  function clearTimelineHover() {
    setHoveredTimelinePreview(null);
  }

  function handleTimelineHoverStart(event, commit) {
    const normalizedCommit = String(commit?.fullCommit || commit?.commit || "").trim();
    if (!normalizedCommit) {
      setHoveredTimelinePreview(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 800;
    const width = Math.min(440, Math.max(340, Math.round(viewportWidth * 0.32)));
    const estimatedHeight = 340;
    const maxLeft = Math.max(12, viewportWidth - width - 12);
    const maxTop = Math.max(12, viewportHeight - estimatedHeight - 12);
    const left = Math.min(Math.max(12, Math.round(rect.right + 14)), maxLeft);
    const top = Math.min(Math.max(12, Math.round(rect.top)), maxTop);

    setHoveredTimelinePreview({
      commitId: normalizedCommit,
      top,
      left,
      width
    });
  }

  function toggleTimelineCommit(commitId) {
    const normalizedCommit = String(commitId ?? "").trim();
    if (!normalizedCommit) {
      return;
    }

    setExpandedTimelineCommits((current) => (
      current.includes(normalizedCommit)
        ? current.filter((item) => item !== normalizedCommit)
        : [...current, normalizedCommit]
    ));
  }

  function handleBranchResizePointerDown(event) {
    if (event.button !== 0) {
      return;
    }

    const panelNode = panelRef.current;
    if (!panelNode) {
      return;
    }

    event.preventDefault();
    const panelBounds = panelNode.getBoundingClientRect();
    const minHeight = 160;
    const maxHeight = Math.max(260, Math.floor(panelBounds.height * 0.55));

    const handleMove = (moveEvent) => {
      const nextHeight = Math.max(
        minHeight,
        Math.min(maxHeight, Math.round(panelBounds.bottom - moveEvent.clientY))
      );
      setBranchSectionHeight(nextHeight);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      branchResizeDragRef.current = null;
    };

    branchResizeDragRef.current = {
      handleMove,
      handleUp
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  return (
    <div className="workspace-git-panel" ref={panelRef}>
      {gitError && <div className="workspace-git-error">{gitError}</div>}
      <div className="workspace-git-composer">
        <div className="workspace-git-composer-topline">
          <div className="workspace-git-composer-status">
            <span>{composerStateLabel}</span>
            <span>{composerCountLabel}</span>
          </div>
          <WorkspaceIconButton
            icon="refresh"
            label="刷新 Git 状态"
            className="workspace-git-refresh workspace-git-refresh-compact"
            onClick={refreshGitState}
            disabled={gitLoading}
          />
        </div>
        <div className="workspace-git-message-shell">
          <textarea
            className="workspace-git-message-input"
            value={gitMessage}
            onChange={(event) => setGitMessage(event.target.value)}
            placeholder="feat: ..."
            spellCheck={false}
            rows={4}
          />
          <WorkspaceIconButton
            icon="spark"
            label="AI 生成 commit 描述"
            className="workspace-git-message-ai"
            onClick={() => generateCommitMessage()}
            disabled={!gitAvailable || gitMessageStreaming || gitLoading}
          />
        </div>
        <div className="workspace-git-composer-footer">
          <button
            type="button"
            className={`workspace-git-primary-action ${primaryAction.type === "push" ? "is-push" : "is-commit"} ${
              !primaryAction.disabled && primaryAction.type !== "idle" ? "is-active" : ""
            }`}
            onClick={executePrimaryAction}
            disabled={primaryAction.disabled || gitLoading || Boolean(gitActionBusy)}
            aria-label={primaryAction.label}
            title={primaryAction.label}
          >
            <WorkspaceIcon name={primaryAction.icon} />
            <span>{primaryAction.label}</span>
          </button>
          <div className="workspace-git-composer-footer-actions">
            {!isRepo && gitAvailable && (
              <WorkspaceIconButton
                icon="git"
                label="初始化 Git"
                onClick={initGit}
                disabled={gitLoading || Boolean(gitActionBusy)}
              />
            )}
            {selectedCount > 0 && (
              <WorkspaceIconButton
                icon="close"
                label="清空选择"
                onClick={clearGitSelection}
                disabled={gitLoading}
              />
            )}
          </div>
        </div>
      </div>

      <div className="workspace-git-file-groups">
        {gitLoading && !gitState ? (
          <div className="workspace-git-empty">正在读取 Git 状态…</div>
        ) : !gitAvailable ? (
          <div className="workspace-git-empty">git 不可用</div>
        ) : !isRepo ? (
          <div className="workspace-git-empty">
            <strong>当前目录还不是 Git 仓库。</strong>
            <span>点击上方的 Git 图标初始化。</span>
          </div>
        ) : allFiles.length > 0 ? (
          <>
            {selectedFiles.length > 0 && (
              <section className="workspace-git-file-group is-selected">
                <div className="workspace-git-file-group-head">
                  <div>
                    <span>待提交</span>
                    <small>{selectedFiles.length}</small>
                  </div>
                  <small>会进入本次 commit</small>
                </div>
                <div className="workspace-git-file-list">
                  {selectedFiles.map((entry) => renderGitFileRow({
                    entry,
                    selectedForCommit: true,
                    selectedGitPath,
                    gitLoading,
                    gitActionBusy,
                    selectGitPath,
                    toggleGitSelection,
                    revertGitPath
                  }))}
                </div>
              </section>
            )}
            <section className="workspace-git-file-group is-remaining">
              <div className="workspace-git-file-group-head">
                <div>
                  <span>未提交</span>
                  <small>{remainingFiles.length}</small>
                </div>
                <small>点击 + 加入待提交</small>
              </div>
              <div className="workspace-git-file-list">
                {remainingFiles.length > 0 ? (
                  remainingFiles.map((entry) => renderGitFileRow({
                    entry,
                    selectedForCommit: false,
                    selectedGitPath,
                    gitLoading,
                    gitActionBusy,
                    selectGitPath,
                    toggleGitSelection,
                    revertGitPath
                  }))
                ) : (
                  <div className="workspace-git-empty workspace-git-empty-inline">没有未提交文件。</div>
                )}
              </div>
            </section>
          </>
        ) : (
          <div className="workspace-git-empty">没有检测到未提交变更。</div>
        )}
      </div>

      <div
        className="workspace-git-branch-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整分支区域高度"
        onPointerDown={handleBranchResizePointerDown}
      />
      <div
        className="workspace-git-branch-section"
        style={{
          height: `${branchSectionHeight}px`,
          minHeight: `${branchSectionHeight}px`,
          maxHeight: `${branchSectionHeight}px`
        }}
      >
        <div className="workspace-git-section-head is-compact">
          <span>图表</span>
          <small>{timelineEntries.length}</small>
        </div>
        <div className="workspace-git-branch-list">
          {timelineEntries.length === 0 ? (
            <div className="workspace-git-empty">没有提交时间线。</div>
          ) : (
            timelineEntries.map((commit) => {
              const commitId = commit?.fullCommit || commit?.commit || "";
              const isExpanded = expandedTimelineSet.has(commitId);
              return renderTimelineEntry({
                commit,
                isExpanded,
                onToggle: () => toggleTimelineCommit(commitId),
                onSelectBranchFile: selectBranchGitFile,
                selectedBranchGitPreviewKey,
                isHovered: hoveredTimelinePreview?.commitId === commitId,
                onHoverStart: handleTimelineHoverStart,
                onHoverEnd: clearTimelineHover
              });
            })
          )}
        </div>
      </div>
      {hoveredTimelinePreview && (
        <div
          className="workspace-git-branch-float-preview"
          style={{
            top: `${hoveredTimelinePreview.top}px`,
            left: `${hoveredTimelinePreview.left}px`,
            width: `${hoveredTimelinePreview.width}px`
          }}
          aria-hidden="true"
        >
          {(() => {
            const hoveredCommit = timelineEntries.find((commit) => {
              const commitId = commit?.fullCommit || commit?.commit || "";
              return commitId === hoveredTimelinePreview.commitId;
            }) ?? null;

            if (!hoveredCommit) {
              return null;
            }

            const refs = Array.isArray(hoveredCommit?.refs) ? hoveredCommit.refs : [];
            const chips = [];
            const seenTexts = new Set();
            for (const ref of refs) {
              const text = String(ref?.text ?? "").trim();
              if (!text || seenTexts.has(text)) {
                continue;
              }
              seenTexts.add(text);
              chips.push({ text, tone: ref?.tone || "sync" });
            }

            if (hoveredCommit?.presenceLabel && !chips.some((chip) => chip.text === hoveredCommit.presenceLabel)) {
              chips.push({
                text: hoveredCommit.presenceLabel,
                tone: hoveredCommit.presenceLabel === "当前" ? "current" : hoveredCommit.presenceLabel.includes("远程") ? "remote" : hoveredCommit.presenceLabel.includes("本地") ? "local" : "upstream"
              });
            }

            return (
              <div className="workspace-git-branch-hovercard">
                <div className="workspace-git-branch-hovercard-head">
                  <div className="workspace-git-branch-hovercard-title" title={hoveredCommit.subject || "没有提交描述"}>
                    {hoveredCommit.subject || "没有提交描述"}
                  </div>
                  <div className="workspace-git-branch-hovercard-meta">
                    <span className="workspace-git-branch-hovercard-time">{hoveredCommit.date || "未知日期"}</span>
                    <span className="workspace-git-branch-hovercard-sha">#{hoveredCommit.fullCommit || hoveredCommit.commit || "—"}</span>
                  </div>
                </div>
                <div className="workspace-git-branch-hovercard-grid">
                  <div className="workspace-git-branch-hovercard-field">
                    <span>本地账号</span>
                    <strong title={gitState?.gitUserName || ""}>{gitState?.gitUserName || "未配置"}</strong>
                  </div>
                  <div className="workspace-git-branch-hovercard-field">
                    <span>本地邮箱</span>
                    <strong title={gitState?.gitUserEmail || ""}>{gitState?.gitUserEmail || "未配置"}</strong>
                  </div>
                  <div className="workspace-git-branch-hovercard-field">
                    <span>提交作者</span>
                    <strong title={[hoveredCommit?.authorName, hoveredCommit?.authorEmail].filter(Boolean).join(" · ")}>
                      {hoveredCommit?.authorName || hoveredCommit?.authorEmail || "未知"}
                    </strong>
                  </div>
                  <div className="workspace-git-branch-hovercard-field">
                    <span>提交邮箱</span>
                    <strong title={hoveredCommit?.authorEmail || ""}>{hoveredCommit?.authorEmail || "未知"}</strong>
                  </div>
                  <div className="workspace-git-branch-hovercard-field">
                    <span>增减行</span>
                    <strong>+{Number(hoveredCommit?.insertions ?? 0) || 0} / -{Number(hoveredCommit?.deletions ?? 0) || 0}</strong>
                  </div>
                  <div className="workspace-git-branch-hovercard-field">
                    <span>文件数</span>
                    <strong>{Number(hoveredCommit?.fileCount ?? 0) || 0}</strong>
                  </div>
                </div>
                <div className="workspace-git-branch-hovercard-tags">
                  {chips.map((chip) => (
                    <span
                      key={`hover:${hoveredCommit?.fullCommit || hoveredCommit?.commit}:${chip.text}`}
                      className={`workspace-git-chip is-${chip.tone === "tag" ? "sync" : chip.tone}`}
                    >
                      {chip.text}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function renderGitFileRow({
  entry,
  selectedForCommit,
  selectedGitPath,
  gitLoading,
  gitActionBusy,
  selectGitPath,
  toggleGitSelection,
  revertGitPath
}) {
  const isActive = selectedGitPath === entry.path;
  const label = entry.previousPath && entry.previousPath !== entry.path
    ? `${entry.previousPath} → ${entry.path}`
    : entry.path;
  const statusMeta = getGitStatusMeta(entry);

  return (
    <div
      key={entry.path}
      role="button"
      tabIndex={0}
      className={`workspace-git-file-row is-${statusMeta.tone} ${
        selectedForCommit ? "is-commit-selected" : "is-unselected"
      } ${isActive ? "is-active" : ""}`}
      onClick={() => selectGitPath(entry.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectGitPath(entry.path);
        }
      }}
    >
      <WorkspaceIconButton
        icon={selectedForCommit ? "minus" : "add"}
        label={selectedForCommit ? "从待提交移除" : "加入待提交"}
        className={`workspace-git-file-toggle ${selectedForCommit ? "is-remove" : "is-add"}`}
        active={selectedForCommit}
        onClick={(event) => {
          event.stopPropagation();
          toggleGitSelection(entry.path);
        }}
      />
      <div className="workspace-git-file-main">
        <span className="workspace-git-file-name" title={label}>
          {label}
        </span>
        <div className="workspace-git-file-badges">
          <span className={`workspace-git-status-badge is-${statusMeta.tone}`}>
            {statusMeta.label}
          </span>
          {selectedForCommit && (
            <span className="workspace-git-status-badge is-staged">待提交</span>
          )}
        </div>
      </div>
      <WorkspaceIconButton
        icon="revert"
        label={`回退 ${entry.path}`}
        className="workspace-git-file-revert"
        onClick={(event) => {
          event.stopPropagation();
          revertGitPath(entry.path);
        }}
        disabled={gitLoading || Boolean(gitActionBusy)}
      />
    </div>
  );
}
