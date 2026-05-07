import { WorkspaceIcon, WorkspaceIconButton } from "./workspaceIcons";

function renderBranchBadges(group) {
  const badges = [];
  if (group.local) {
    badges.push(
      <span key="local" className="workspace-git-chip is-local">
        local
      </span>
    );
  }
  if (group.remotes.length > 0) {
    badges.push(
      <span key="remote" className="workspace-git-chip is-remote">
        remote
      </span>
    );
  }
  if (group.local?.upstream) {
    badges.push(
      <span key="upstream" className="workspace-git-chip is-upstream" title={group.local.upstream}>
        {group.local.upstream}
      </span>
    );
  }
  return badges;
}

function getBranchLeadMeta(group) {
  const ahead = Number(group?.ahead ?? 0) || 0;
  const behind = Number(group?.behind ?? 0) || 0;
  if (ahead > behind) {
    return { label: `本地领先 ↑${ahead}`, tone: "local" };
  }
  if (behind > ahead) {
    return { label: `远程领先 ↓${behind}`, tone: "remote" };
  }
  return { label: "同步", tone: "sync" };
}

function renderBranchTimelineEntry({
  branch,
  kind,
  leadMeta = null,
  tracked = false
}) {
  const label = kind === "remote" ? branch.ref : branch.name;
  const subject = branch.subject || "没有提交描述";
  const commit = branch.commit || "";
  const title = [
    label,
    commit ? `#${commit}` : "",
    subject
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      key={`${kind}:${label}:${commit}`}
      className={`workspace-git-branch-entry is-${kind} ${branch.isCurrent ? "is-current" : ""} ${
        tracked ? "is-tracked" : ""
      }`}
      title={title}
    >
      <div className="workspace-git-branch-entry-rail" aria-hidden="true">
        <span className={`workspace-git-branch-dot is-${kind}`} />
      </div>
      <div className="workspace-git-branch-entry-main">
        <div className="workspace-git-branch-entry-head">
          <span className="workspace-git-branch-entry-name">{label}</span>
          <div className="workspace-git-branch-entry-tags">
            <span className={`workspace-git-chip is-${kind}`}>
              {kind === "local" ? "local" : "remote"}
            </span>
            {branch.isCurrent && <span className="workspace-git-chip is-current">当前</span>}
            {tracked && <span className="workspace-git-chip is-upstream">追踪</span>}
            {leadMeta && <span className={`workspace-git-chip is-${leadMeta.tone}`}>{leadMeta.label}</span>}
          </div>
        </div>
        <div className="workspace-git-branch-entry-meta">
          <span className="workspace-git-branch-commit">{commit ? `#${commit}` : "—"}</span>
          <span className="workspace-git-branch-subject">{subject}</span>
        </div>
      </div>
    </div>
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
    selectedPathSet,
    branchGroups,
    primaryAction,
    refreshGitState,
    selectGitPath,
    toggleGitSelection,
    clearGitSelection,
    generateCommitMessage,
    executePrimaryAction,
    initGit,
    revertGitPath
  } = gitSession;

  const gitAvailable = Boolean(gitState?.gitAvailable);
  const isRepo = Boolean(gitState?.isRepo);
  const selectedCount = selectedPathSet.size;
  const allFiles = Array.isArray(gitState?.files) ? gitState.files : [];
  const selectedFiles = allFiles.filter((entry) => selectedPathSet.has(entry.path));
  const remainingFiles = allFiles.filter((entry) => !selectedPathSet.has(entry.path));
  const remainingCount = remainingFiles.length;
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

  return (
    <div className="workspace-git-panel">
      {gitError && <div className="workspace-git-error">{gitError}</div>}
      <div className="workspace-git-composer">
        <div className="workspace-git-composer-topline">
          <div className="workspace-git-composer-status">
            <span>{composerStateLabel}</span>
            <span>
              {selectedCount} 待提交 · {remainingCount} 未提交
            </span>
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
            <section className="workspace-git-file-group is-selected">
              <div className="workspace-git-file-group-head">
                <div>
                  <span>待提交</span>
                  <small>{selectedFiles.length}</small>
                </div>
                <small>会进入本次 commit</small>
              </div>
              <div className="workspace-git-file-list">
                {selectedFiles.length > 0 ? (
                  selectedFiles.map((entry) => renderGitFileRow({
                    entry,
                    selectedForCommit: true,
                    selectedGitPath,
                    gitLoading,
                    gitActionBusy,
                    selectGitPath,
                    toggleGitSelection,
                    revertGitPath
                  }))
                ) : (
                  <div className="workspace-git-empty workspace-git-empty-inline">还没有选择要提交的文件。</div>
                )}
              </div>
            </section>
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

      <div className="workspace-git-branch-section">
        <div className="workspace-git-section-head is-compact">
          <span>分支</span>
          <small>{branchGroups.length}</small>
        </div>
        <div className="workspace-git-branch-list">
          {branchGroups.length === 0 ? (
            <div className="workspace-git-empty">没有分支信息。</div>
          ) : (
            branchGroups.map((group) => (
              <section key={group.name} className={`workspace-git-branch-card ${group.local?.isCurrent ? "is-current" : ""}`}>
                <div className="workspace-git-branch-card-head">
                  <div className="workspace-git-branch-card-title">
                    <span className="workspace-git-branch-name">{group.name}</span>
                    {renderBranchBadges(group)}
                  </div>
                  <div className="workspace-git-branch-counts">
                    {group.local ? <span>↑{group.local.ahead ?? 0}</span> : null}
                    {group.local ? <span>↓{group.local.behind ?? 0}</span> : null}
                  </div>
                </div>
                <div className="workspace-git-branch-timeline">
                  {group.local
                    ? renderBranchTimelineEntry({
                        branch: group.local,
                        kind: "local",
                        leadMeta: getBranchLeadMeta(group),
                        tracked: Boolean(group.local.upstream)
                      })
                    : null}
                  {group.remotes.map((remote) =>
                    renderBranchTimelineEntry({
                      branch: remote,
                      kind: "remote",
                      leadMeta: group.local?.upstream && remote.ref === group.local.upstream ? getBranchLeadMeta(group) : null,
                      tracked: Boolean(group.local?.upstream && remote.ref === group.local.upstream)
                    })
                  )}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
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
