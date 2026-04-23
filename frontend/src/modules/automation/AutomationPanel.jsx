import { useEffect, useMemo, useState } from "react";

import {
  createAutomationTask,
  deleteAutomationHistoryById,
  deleteAutomationTask,
  fetchAutomationHistories,
  fetchAutomationTasks,
  runAutomationTaskNow,
  updateAutomationTask
} from "../../api/automationApi";
import { selectWorkplaceBySystemDialog } from "../../api/chatApi";
import { TimePickerDropdown } from "../../shared/TimePickerDropdown";
import "./automation.css";

function formatDateTime(timestamp) {
  const value = Number(timestamp ?? 0);
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("zh-CN", {
    hour12: false
  });
}

function normalizeTimeInput(value) {
  const normalized = String(value ?? "").trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized) ? normalized : "09:00";
}

function normalizeSource(value) {
  return String(value ?? "").trim().toLowerCase();
}

function groupAutomationHistories(histories) {
  const sourceList = Array.isArray(histories) ? histories : [];
  const byId = new Map();
  for (const item of sourceList) {
    const id = String(item?.id ?? "").trim();
    if (!id) {
      continue;
    }
    byId.set(id, item);
  }

  const topLevelItems = [];
  const childItemsByParentId = new Map();

  for (const item of sourceList) {
    const id = String(item?.id ?? "").trim();
    if (!id) {
      continue;
    }

    const parentId = String(item?.parentConversationId ?? "").trim();
    const isChild = normalizeSource(item?.source) === "subagent" && parentId && byId.has(parentId);

    if (isChild) {
      const current = childItemsByParentId.get(parentId) ?? [];
      current.push(item);
      childItemsByParentId.set(parentId, current);
      continue;
    }

    topLevelItems.push(item);
  }

  const sortByUpdatedDesc = (left, right) =>
    Number(right?.updatedAt ?? 0) - Number(left?.updatedAt ?? 0);
  topLevelItems.sort(sortByUpdatedDesc);
  for (const [parentId, list] of childItemsByParentId.entries()) {
    childItemsByParentId.set(parentId, [...list].sort(sortByUpdatedDesc));
  }

  return {
    topLevelItems,
    childItemsByParentId
  };
}

export function AutomationPanel({ onOpenConversation, activeConversationId = "" }) {
  const [tasks, setTasks] = useState([]);
  const [histories, setHistories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [workplaceSelecting, setWorkplaceSelecting] = useState(false);
  const [expandedHistoryGroupMap, setExpandedHistoryGroupMap] = useState({});
  const [form, setForm] = useState({
    name: "",
    prompt: "",
    workplacePath: "",
    timeOfDay: "09:00",
    enabled: true
  });

  async function loadData() {
    const [taskResp, historyResp] = await Promise.all([
      fetchAutomationTasks(),
      fetchAutomationHistories()
    ]);

    setTasks(Array.isArray(taskResp?.tasks) ? taskResp.tasks : []);
    setHistories(Array.isArray(historyResp?.histories) ? historyResp.histories : []);
  }

  useEffect(() => {
    let mounted = true;

    async function run() {
      setLoading(true);
      setError("");
      try {
        await loadData();
      } catch (loadError) {
        if (!mounted) {
          return;
        }
        setError(String(loadError?.message ?? "加载自动化失败"));
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    run();

    const timerId = setInterval(() => {
      void loadData().catch(() => {});
    }, 10000);

    return () => {
      mounted = false;
      clearInterval(timerId);
    };
  }, []);

  const sortedTasks = useMemo(
    () => [...tasks].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)),
    [tasks]
  );
  const groupedHistories = useMemo(() => groupAutomationHistories(histories), [histories]);

  async function handleCreateTask(event) {
    event.preventDefault();

    setSaving(true);
    setError("");
    try {
      await createAutomationTask({
        name: String(form.name ?? "").trim(),
        prompt: String(form.prompt ?? "").trim(),
        workplacePath: String(form.workplacePath ?? "").trim(),
        timeOfDay: normalizeTimeInput(form.timeOfDay),
        enabled: Boolean(form.enabled)
      });

      setForm({
        name: "",
        prompt: "",
        workplacePath: "",
        timeOfDay: "09:00",
        enabled: true
      });

      await loadData();
    } catch (createError) {
      setError(String(createError?.message ?? "创建自动化任务失败"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectWorkplace() {
    setError("");
    setWorkplaceSelecting(true);
    try {
      const response = await selectWorkplaceBySystemDialog(form.workplacePath);
      const selectedPath = String(response?.selectedPath ?? "").trim();
      if (!selectedPath || response?.canceled) {
        return;
      }

      setForm((prev) => ({
        ...prev,
        workplacePath: selectedPath
      }));
    } catch (selectError) {
      setError(String(selectError?.message ?? "选择工作区失败"));
    } finally {
      setWorkplaceSelecting(false);
    }
  }

  async function handleToggleTask(task) {
    setError("");
    try {
      await updateAutomationTask(task.id, {
        enabled: !Boolean(task.enabled)
      });
      await loadData();
    } catch (toggleError) {
      setError(String(toggleError?.message ?? "更新任务状态失败"));
    }
  }

  async function handleRunTask(task) {
    setError("");
    try {
      await runAutomationTaskNow(task.id);
      await loadData();
    } catch (runError) {
      setError(String(runError?.message ?? "立即执行失败"));
    }
  }

  async function handleDeleteTask(task) {
    const shouldDelete = window.confirm(`确认删除自动化任务“${task.name}”吗？`);
    if (!shouldDelete) {
      return;
    }

    setError("");
    try {
      await deleteAutomationTask(task.id);
      await loadData();
    } catch (deleteError) {
      setError(String(deleteError?.message ?? "删除任务失败"));
    }
  }

  function toggleHistoryGroup(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    setExpandedHistoryGroupMap((prev) => ({
      ...prev,
      [normalizedConversationId]: !Boolean(prev?.[normalizedConversationId])
    }));
  }

  async function handleDeleteAutomationHistory(history) {
    const conversationId = String(history?.id ?? "").trim();
    if (!conversationId) {
      return;
    }

    const displayName = String(history?.title ?? "").trim() || "该会话";
    const shouldDelete = window.confirm(`确认删除“${displayName}”及其子智能体会话吗？`);
    if (!shouldDelete) {
      return;
    }

    setError("");
    try {
      await deleteAutomationHistoryById(conversationId);
      await loadData();
    } catch (deleteError) {
      setError(String(deleteError?.message ?? "删除自动化会话失败"));
    }
  }

  return (
    <div className="automation-panel">
      <header className="automation-header">
        <div>
          <h2>自动化调度</h2>
          <p>独立任务池，按时间自动向独立会话发送指令。</p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void loadData()}>
          刷新
        </button>
      </header>

      <form className="automation-create" onSubmit={handleCreateTask}>
        <div className="automation-field-row">
          <label>
            任务名
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如：每日巡检"
              maxLength={120}
              required
            />
          </label>
          <label>
            每日执行时间
            <TimePickerDropdown
              value={normalizeTimeInput(form.timeOfDay)}
              onChange={(nextValue) =>
                setForm((prev) => ({ ...prev, timeOfDay: normalizeTimeInput(nextValue) }))
              }
              ariaLabel="每日执行时间"
            />
          </label>
          <label className="automation-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.enabled)}
              onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            启用
          </label>
        </div>

        <label>
          指令
          <textarea
            value={form.prompt}
            onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
            placeholder="到点时自动发送给模型的用户指令"
            rows={4}
            required
          />
        </label>

        <label>
          工作区
          <div className="automation-workplace-row">
            <input
              value={form.workplacePath}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, workplacePath: event.target.value }))
              }
              placeholder="请选择自动化会话工作区目录"
              required
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void handleSelectWorkplace()}
              disabled={workplaceSelecting}
            >
              {workplaceSelecting ? "打开中..." : "选择目录"}
            </button>
          </div>
        </label>

        <div className="automation-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "保存中..." : "创建任务"}
          </button>
        </div>
      </form>

      {error ? <p className="automation-error">{error}</p> : null}
      {loading ? <p className="automation-loading">加载中...</p> : null}

      <section className="automation-section">
        <h3>任务列表</h3>
        <div className="automation-list">
          {sortedTasks.length === 0 ? <p className="automation-empty">暂无任务</p> : null}
          {sortedTasks.map((task) => (
            <article key={task.id} className="automation-item">
              <div className="automation-item-main">
                <h4>{task.name}</h4>
                <p className="automation-item-meta">
                  时间 {task.timeOfDay} · 状态 {task.status} · 下次 {formatDateTime(task.nextRunAt)}
                </p>
                <p className="automation-item-meta">工作区 {task.workplacePath || "(未设置)"}</p>
                <p className="automation-item-meta">
                  上次 {formatDateTime(task.lastRunAt)}
                  {task.lastError ? ` · 错误：${task.lastError}` : ""}
                </p>
              </div>
              <div className="automation-item-actions">
                <button type="button" className="btn-ghost" onClick={() => void handleRunTask(task)}>
                  立即执行
                </button>
                <button type="button" className="btn-ghost" onClick={() => void handleToggleTask(task)}>
                  {task.enabled ? "停用" : "启用"}
                </button>
                <button type="button" className="btn-danger" onClick={() => void handleDeleteTask(task)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="automation-section">
        <h3>自动化历史会话</h3>
        <div className="history-list automation-history-list">
          {groupedHistories.topLevelItems.length === 0 ? (
            <p className="automation-empty">暂无自动化历史</p>
          ) : null}
          {groupedHistories.topLevelItems.map((item) => {
            const childItems =
              groupedHistories.childItemsByParentId.get(String(item?.id ?? "").trim()) ?? [];
            const hasChildren = childItems.length > 0;
            const normalizedItemId = String(item?.id ?? "").trim();
            const isParentActive =
              normalizedItemId && normalizedItemId === String(activeConversationId ?? "").trim();
            const containsActiveChild = childItems.some(
              (child) => String(child?.id ?? "").trim() === String(activeConversationId ?? "").trim()
            );
            const isExpanded =
              !hasChildren || Boolean(expandedHistoryGroupMap?.[normalizedItemId]);

            return (
              <article
                key={item.id}
                className={`history-group ${isExpanded ? "history-group-expanded" : ""}`}
              >
                <div
                  className={`history-item ${
                    isParentActive ? "history-item-active" : containsActiveChild ? "history-item-contains-active" : ""
                  } ${hasChildren ? "history-item-has-children" : ""}`}
                >
                  <button
                    type="button"
                    className="history-item-main"
                    onClick={() => onOpenConversation?.(item)}
                  >
                    <div className="history-item-top">
                      <strong>{item.title || "未命名会话"}</strong>
                      <div className="history-item-meta">
                        <span className="history-item-badge">自动化</span>
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </div>
                    </div>
                    <p>{item.preview || "暂无内容"}</p>
                  </button>

                  {hasChildren ? (
                    <button
                      type="button"
                      className={`history-item-toggle ${isExpanded ? "is-expanded" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleHistoryGroup(item.id);
                      }}
                      aria-label={isExpanded ? "收起子智能体对话" : "展开子智能体对话"}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m9 6l6 6l-6 6" />
                      </svg>
                    </button>
                  ) : null}

                  <div className="history-item-actions">
                    <button
                      type="button"
                      className="history-item-delete"
                      onClick={() => void handleDeleteAutomationHistory(item)}
                      aria-label="删除该自动化历史"
                    >
                      删除
                    </button>
                  </div>
                </div>

                {hasChildren && isExpanded ? (
                  <div className="history-subitem-list">
                    {childItems.map((child) => {
                      const isChildActive =
                        String(child?.id ?? "").trim() === String(activeConversationId ?? "").trim();
                      return (
                        <article
                          key={child.id}
                          className={`history-subitem ${isChildActive ? "history-subitem-active" : ""}`}
                        >
                          <button
                            type="button"
                            className="history-subitem-main"
                            onClick={() => onOpenConversation?.(child)}
                          >
                            <div className="history-item-top">
                              <strong>{child.title || child.agentDisplayName || "子智能体对话"}</strong>
                              <div className="history-item-meta">
                                <span className="history-item-badge">
                                  {child.agentDisplayName || child.agentType || "子智能体"}
                                </span>
                                <span>{formatDateTime(child.updatedAt)}</span>
                              </div>
                            </div>
                            <p>{child.preview || "暂无内容"}</p>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
