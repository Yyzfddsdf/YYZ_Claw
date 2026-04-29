import { useEffect, useMemo, useState } from "react";

import {
  createAutomationTask,
  deleteAutomationBinding,
  deleteAutomationTask,
  fetchAutomationBindings,
  fetchAutomationTasks,
  runAutomationBindingNow,
  updateAutomationBinding,
  updateAutomationTask,
  upsertAutomationBinding
} from "../../api/automationApi";
import { fetchHistories } from "../../api/chatApi";
import { TimePickerDropdown } from "../../shared/TimePickerDropdown";
import { confirmAction } from "../../shared/feedback";
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

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isBindableConversation(conversation) {
  const source = normalizeText(conversation?.source);
  return normalizeText(conversation?.id) && source !== "subagent";
}

export function AutomationPanel({ onOpenConversation, activeConversationId = "" }) {
  const [templates, setTemplates] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [histories, setHistories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [configTemplateId, setConfigTemplateId] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState("");
  const [form, setForm] = useState({
    name: "",
    prompt: ""
  });
  const [bindingDraftByConversationId, setBindingDraftByConversationId] = useState({});

  async function loadData() {
    const [taskResp, bindingResp, historyResp] = await Promise.all([
      fetchAutomationTasks(),
      fetchAutomationBindings(),
      fetchHistories()
    ]);

    setTemplates(Array.isArray(taskResp?.tasks) ? taskResp.tasks : []);
    setBindings(Array.isArray(bindingResp?.bindings) ? bindingResp.bindings : []);
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

  const sortedTemplates = useMemo(
    () => [...templates].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)),
    [templates]
  );

  const sortedBindings = useMemo(
    () => [...bindings].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)),
    [bindings]
  );

  const bindableHistories = useMemo(
    () =>
      (Array.isArray(histories) ? histories : [])
        .filter(isBindableConversation)
        .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)),
    [histories]
  );

  const bindingByConversationId = useMemo(() => {
    const result = new Map();
    for (const binding of bindings) {
      const conversationId = normalizeText(binding?.conversationId);
      if (conversationId) {
        result.set(conversationId, binding);
      }
    }
    return result;
  }, [bindings]);

  const activeTemplate = useMemo(
    () => sortedTemplates.find((template) => template.id === configTemplateId) ?? null,
    [sortedTemplates, configTemplateId]
  );

  function resetForm() {
    setEditingTemplateId("");
    setForm({
      name: "",
      prompt: ""
    });
  }

  function getBindingDraft(conversationId, existingBinding = null) {
    const normalizedConversationId = normalizeText(conversationId);
    const draft = bindingDraftByConversationId[normalizedConversationId] ?? {};
    return {
      timeOfDay: normalizeTimeInput(draft.timeOfDay ?? existingBinding?.timeOfDay ?? "09:00")
    };
  }

  function updateBindingDraft(conversationId, patch) {
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) {
      return;
    }

    setBindingDraftByConversationId((prev) => ({
      ...prev,
      [normalizedConversationId]: {
        ...(prev?.[normalizedConversationId] ?? {}),
        ...patch
      }
    }));
  }

  async function handleSaveTemplate(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        name: normalizeText(form.name),
        prompt: normalizeText(form.prompt)
      };

      if (editingTemplateId) {
        await updateAutomationTask(editingTemplateId, payload);
        setMessage("自动化任务模板已更新");
      } else {
        await createAutomationTask(payload);
        setMessage("自动化任务模板已创建");
      }

      resetForm();
      await loadData();
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存自动化任务模板失败"));
    } finally {
      setSaving(false);
    }
  }

  function handleEditTemplate(template) {
    setEditingTemplateId(template.id);
    setForm({
      name: template.name || "",
      prompt: template.prompt || ""
    });
  }

  async function handleDeleteTemplate(template) {
    const shouldDelete = await confirmAction({
      title: "删除自动化模板",
      message: `确认删除自动化任务模板“${template.name}”吗？相关会话绑定也会删除。`,
      confirmLabel: "删除"
    });
    if (!shouldDelete) {
      return;
    }

    setError("");
    setMessage("");
    try {
      await deleteAutomationTask(template.id);
      if (configTemplateId === template.id) {
        setConfigTemplateId("");
      }
      await loadData();
      setMessage("自动化任务模板已删除");
    } catch (deleteError) {
      setError(String(deleteError?.message ?? "删除任务模板失败"));
    }
  }

  async function handleBindConversation(conversation) {
    if (!activeTemplate) {
      return;
    }

    const conversationId = normalizeText(conversation?.id);
    const existingBinding = bindingByConversationId.get(conversationId) ?? null;
    const draft = getBindingDraft(conversationId, existingBinding);
    setError("");
    setMessage("");
    try {
      await upsertAutomationBinding({
        templateId: activeTemplate.id,
        conversationId,
        timeOfDay: draft.timeOfDay,
        enabled: true
      });
      await loadData();
      setMessage(`已绑定会话：${conversation.title || conversationId}`);
    } catch (bindError) {
      setError(String(bindError?.message ?? "绑定会话失败"));
    }
  }

  async function handleToggleBinding(binding) {
    setError("");
    setMessage("");
    try {
      await updateAutomationBinding(binding.id, {
        enabled: !Boolean(binding.enabled)
      });
      await loadData();
    } catch (toggleError) {
      setError(String(toggleError?.message ?? "更新绑定状态失败"));
    }
  }

  async function handleRunBinding(binding) {
    setError("");
    setMessage("");
    try {
      await runAutomationBindingNow(binding.id);
      await loadData();
      setMessage("已提交立即执行");
    } catch (runError) {
      setError(String(runError?.message ?? "立即执行失败"));
    }
  }

  async function handleUnbind(binding) {
    const shouldDelete = await confirmAction({
      title: "解绑自动化任务",
      message: `确认解绑“${binding.conversation?.title || binding.conversationId}”的自动化任务吗？`,
      confirmLabel: "解绑"
    });
    if (!shouldDelete) {
      return;
    }

    setError("");
    setMessage("");
    try {
      await deleteAutomationBinding(binding.id);
      await loadData();
      setMessage("已解绑自动化任务");
    } catch (deleteError) {
      setError(String(deleteError?.message ?? "解绑失败"));
    }
  }

  return (
    <div className="automation-panel">
      <header className="automation-header">
        <div>
          <h2>自动化调度</h2>
          <p>管理通用任务模板，并把模板绑定到任意普通会话。</p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void loadData()}>
          刷新
        </button>
      </header>

      <form className="automation-create" onSubmit={handleSaveTemplate}>
        <div className="automation-field-row">
          <label>
            模板名
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如：每日巡检"
              maxLength={120}
              required
            />
          </label>
        </div>

        <label>
          自动发送的用户消息
          <textarea
            value={form.prompt}
            onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
            placeholder="到点时作为正常 user 消息发送到绑定会话"
            rows={4}
            required
          />
        </label>

        <div className="automation-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "保存中..." : editingTemplateId ? "更新模板" : "创建模板"}
          </button>
          {editingTemplateId ? (
            <button type="button" className="btn-ghost" onClick={resetForm} disabled={saving}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {error ? <p className="automation-error">{error}</p> : null}
      {message ? <p className="automation-message">{message}</p> : null}
      {loading ? <p className="automation-loading">加载中...</p> : null}

      <section className="automation-section">
        <h3>任务模板</h3>
        <div className="automation-list">
          {sortedTemplates.length === 0 ? <p className="automation-empty">暂无任务模板</p> : null}
          {sortedTemplates.map((template) => (
            <article key={template.id} className="automation-item">
              <div className="automation-item-main">
                <h4>{template.name}</h4>
                <p className="automation-item-meta">已绑定 {Number(template.bindingCount ?? 0)} 个会话</p>
                <p className="automation-item-preview">{template.prompt}</p>
              </div>
              <div className="automation-item-actions">
                <button type="button" className="btn-ghost" onClick={() => setConfigTemplateId(template.id)}>
                  配置会话
                </button>
                <button type="button" className="btn-ghost" onClick={() => handleEditTemplate(template)}>
                  编辑
                </button>
                <button type="button" className="btn-danger" onClick={() => void handleDeleteTemplate(template)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {activeTemplate ? (
        <section className="automation-section automation-bind-section">
          <div className="automation-section-head">
            <div>
              <h3>给会话绑定“{activeTemplate.name}”</h3>
              <p>每个会话只能绑定一个自动化任务；重复绑定会替换原绑定。</p>
            </div>
            <button type="button" className="btn-ghost" onClick={() => setConfigTemplateId("")}>
              收起
            </button>
          </div>
          <div className="automation-conversation-list">
            {bindableHistories.length === 0 ? <p className="automation-empty">暂无可绑定会话</p> : null}
            {bindableHistories.map((conversation) => {
              const binding = bindingByConversationId.get(conversation.id) ?? null;
              const draft = getBindingDraft(conversation.id, binding);
              const isCurrentTemplate = binding?.templateId === activeTemplate.id;
              return (
                <article
                  key={conversation.id}
                  className={`automation-conversation-card ${
                    String(conversation.id) === String(activeConversationId) ? "is-active" : ""
                  } ${binding ? "is-bound" : ""}`}
                >
                  <button
                    type="button"
                    className="automation-conversation-main"
                    onClick={() => onOpenConversation?.(conversation)}
                  >
                    <strong>
                      {binding ? <span className="automation-alarm-icon" title="已绑定自动化">⏰</span> : null}
                      {conversation.title || "未命名会话"}
                    </strong>
                    <small>{conversation.preview || conversation.workplacePath || "暂无预览"}</small>
                  </button>
                  <div className="automation-conversation-config">
                    {binding ? (
                      <span className="automation-binding-chip">
                        {binding.templateName}
                        {binding.enabled ? " · 启用" : " · 暂停"}
                      </span>
                    ) : null}
                    <TimePickerDropdown
                      value={draft.timeOfDay}
                      onChange={(nextValue) =>
                        updateBindingDraft(conversation.id, { timeOfDay: normalizeTimeInput(nextValue) })
                      }
                      ariaLabel="绑定执行时间"
                    />
                    <button type="button" className="btn-primary" onClick={() => void handleBindConversation(conversation)}>
                      {binding ? (isCurrentTemplate ? "更新绑定" : "替换绑定") : "绑定"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="automation-section">
        <h3>已绑定自动化的会话</h3>
        <div className="automation-list">
          {sortedBindings.length === 0 ? <p className="automation-empty">暂无绑定会话</p> : null}
          {sortedBindings.map((binding) => (
            <article key={binding.id} className="automation-item automation-binding-item">
              <button
                type="button"
                className="automation-item-main as-button"
                onClick={() => binding.conversation && onOpenConversation?.(binding.conversation)}
              >
                <h4>
                  <span className="automation-alarm-icon" aria-hidden="true">⏰</span>
                  {binding.conversation?.title || binding.conversationId}
                </h4>
                <p className="automation-item-meta">
                  模板 {binding.templateName} · {binding.enabled ? "启用" : "暂停"} · 时间 {binding.timeOfDay} · 下次 {formatDateTime(binding.nextRunAt)}
                </p>
                <p className="automation-item-meta">
                  上次 {formatDateTime(binding.lastRunAt)}
                  {binding.lastError ? ` · 错误：${binding.lastError}` : ""}
                </p>
              </button>
              <div className="automation-item-actions">
                <button type="button" className="btn-ghost" onClick={() => void handleRunBinding(binding)}>
                  立即执行
                </button>
                <button type="button" className="btn-ghost" onClick={() => void handleToggleBinding(binding)}>
                  {binding.enabled ? "暂停" : "启用"}
                </button>
                <button type="button" className="btn-danger" onClick={() => void handleUnbind(binding)}>
                  解绑
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
