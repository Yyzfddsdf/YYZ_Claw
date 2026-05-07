import { useEffect, useMemo, useState } from "react";

import { createSubagent, deleteSubagent, fetchSubagents, updateSubagent } from "../../api/subagentsApi";
import { confirmAction } from "../../shared/feedback";
import "./subagents.css";

function emptyDraft() {
  return {
    agentType: "",
    displayName: "",
    description: "",
    prompt: "",
    specialty: ""
  };
}

function normalizeDraft(subagent) {
  if (!subagent) {
    return emptyDraft();
  }

  return {
    agentType: String(subagent.agentType ?? ""),
    displayName: String(subagent.displayName ?? ""),
    description: String(subagent.description ?? ""),
    prompt: String(subagent.prompt ?? ""),
    specialty: String(subagent?.metadata?.specialty ?? "")
  };
}

export function SubagentPanel({ onNavigate }) {
  const [subagents, setSubagents] = useState([]);
  const [selectedAgentType, setSelectedAgentType] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedSubagent = useMemo(
    () => subagents.find((item) => item.agentType === selectedAgentType) ?? null,
    [subagents, selectedAgentType]
  );

  async function loadSubagents(preferredAgentType = "") {
    setLoading(true);
    setError("");
    try {
      const response = await fetchSubagents();
      const nextItems = Array.isArray(response?.subagents) ? response.subagents : [];
      setSubagents(nextItems);
      const nextSelected =
        preferredAgentType && nextItems.some((item) => item.agentType === preferredAgentType)
          ? preferredAgentType
          : selectedAgentType && nextItems.some((item) => item.agentType === selectedAgentType)
            ? selectedAgentType
            : nextItems[0]?.agentType ?? "";
      setSelectedAgentType(nextSelected);
    } catch (loadError) {
      setError(loadError?.message || "加载子智能体失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSubagents();
  }, []);

  useEffect(() => {
    setDraft(normalizeDraft(selectedSubagent));
  }, [selectedSubagent]);

  function updateField(field, value) {
    setDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  }

  async function handleCreateNew() {
    setSelectedAgentType("");
    setDraft(emptyDraft());
    setError("");
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const payload = {
        displayName: draft.displayName,
        description: draft.description,
        prompt: draft.prompt,
        metadata: {
          specialty: draft.specialty
        }
      };

      let nextAgentType = draft.agentType;
      if (selectedSubagent) {
        await updateSubagent(selectedSubagent.agentType, payload);
      } else {
        const response = await createSubagent({
          agentType: draft.agentType,
          ...payload
        });
        nextAgentType = String(response?.subagent?.agentType ?? draft.agentType).trim();
      }

      await loadSubagents(nextAgentType);
    } catch (saveError) {
      setError(saveError?.message || "保存子智能体失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedSubagent?.agentType) {
      return;
    }

    const confirmed = await confirmAction({
      title: "删除子智能体",
      message: `确定删除子智能体「${selectedSubagent.displayName || selectedSubagent.agentType}」吗？`,
      confirmLabel: "删除"
    });
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError("");
    try {
      await deleteSubagent(selectedSubagent.agentType);
      setSelectedAgentType("");
      setDraft(emptyDraft());
      await loadSubagents("");
    } catch (deleteError) {
      setError(deleteError?.message || "删除子智能体失败");
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    draft.agentType.trim() &&
    draft.displayName.trim() &&
    draft.description.trim() &&
    draft.prompt.trim() &&
    !saving;

  return (
    <div className="subagent-panel">
      <header className="subagent-panel-header">
        <div>
          <h2>子智能体</h2>
          <p>定义资产写入用户主目录 <code>.yyz/subagents/&lt;agentType&gt;/definition.json</code> 和 <code>prompt.md</code>。</p>
        </div>
        <div className="subagent-header-actions">
          <button type="button" className="subagent-secondary-btn" onClick={() => onNavigate?.("chat")}>
            返回会话
          </button>
          <button type="button" className="subagent-primary-btn" onClick={handleCreateNew}>
            新建智能体
          </button>
        </div>
      </header>

      {error && <div className="subagent-error">{error}</div>}

      <div className="subagent-layout">
        <aside className="subagent-list">
          {loading ? (
            <div className="subagent-empty-list">加载中...</div>
          ) : subagents.length === 0 ? (
            <div className="subagent-empty-list">暂无子智能体。现在新建会自动写入 `.yyz/subagents`。</div>
          ) : (
            subagents.map((subagent) => (
              <button
                key={subagent.agentType}
                type="button"
                className={`subagent-card ${subagent.agentType === selectedAgentType ? "active" : ""}`}
                onClick={() => setSelectedAgentType(subagent.agentType)}
              >
                <div className="subagent-card-head">
                  <strong>{subagent.displayName}</strong>
                  <span>{subagent.agentType}</span>
                </div>
                <small>{subagent.description || "无描述"}</small>
              </button>
            ))
          )}
        </aside>

        <section className="subagent-editor">
          <div className="subagent-editor-card">
            <div className="subagent-editor-top">
              <div>
                <h3>{selectedSubagent ? "编辑智能体" : "新建智能体"}</h3>
                <p>
                  {selectedSubagent
                    ? `当前目录：.yyz/subagents/${selectedSubagent.agentType}`
                    : "保存后会自动创建到 .yyz/subagents/<agentType>"}
                </p>
              </div>
            </div>

            <div className="subagent-editor-scroll">
              <label className="subagent-field">
                <span>agentType</span>
                <input
                  value={draft.agentType}
                  disabled={Boolean(selectedSubagent)}
                  onChange={(event) => updateField("agentType", event.target.value)}
                  placeholder="builder"
                />
              </label>

              <label className="subagent-field">
                <span>displayName</span>
                <input
                  value={draft.displayName}
                  onChange={(event) => updateField("displayName", event.target.value)}
                  placeholder="实现子智能体"
                />
              </label>

              <label className="subagent-field">
                <span>description</span>
                <input
                  value={draft.description}
                  onChange={(event) => updateField("description", event.target.value)}
                  placeholder="擅长局部实现、修补和验证。"
                />
              </label>

              <label className="subagent-field">
                <span>specialty</span>
                <input
                  value={draft.specialty}
                  onChange={(event) => updateField("specialty", event.target.value)}
                  placeholder="implementation"
                />
              </label>

              <label className="subagent-field subagent-prompt-field">
                <span>提示词</span>
                <textarea
                  value={draft.prompt}
                  onChange={(event) => updateField("prompt", event.target.value)}
                  rows={16}
                  placeholder="在这里写子智能体提示词"
                />
              </label>
            </div>

            <div className="subagent-actions">
              <button type="button" className="subagent-primary-btn" disabled={!canSave} onClick={handleSave}>
                {saving ? "保存中..." : selectedSubagent ? "保存修改" : "创建智能体"}
              </button>
              {selectedSubagent && (
                <button type="button" className="subagent-danger-btn" disabled={saving} onClick={handleDelete}>
                  删除
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
