import { useEffect, useMemo, useState } from "react";

import {
  createPersona,
  deletePersona,
  updatePersona,
  uploadPersonaAvatar
} from "../../api/personasApi";
import { confirmAction } from "../../shared/feedback";
import "./personas.css";

function emptyDraft() {
  return {
    id: "",
    name: "",
    description: "",
    prompt: "",
    accentColor: "#2563eb",
    avatarUrl: ""
  };
}

function normalizePersonaDraft(persona) {
  if (!persona) {
    return emptyDraft();
  }

  return {
    id: String(persona.id ?? ""),
    name: String(persona.name ?? ""),
    description: String(persona.description ?? ""),
    prompt: String(persona.prompt ?? ""),
    accentColor: String(persona.accentColor ?? "#2563eb") || "#2563eb",
    avatarUrl: String(persona.avatarUrl ?? "")
  };
}

export function PersonaPanel({ chat, onNavigate }) {
  const personas = Array.isArray(chat?.personaCatalog) ? chat.personaCatalog : [];
  const [selectedPersonaId, setSelectedPersonaId] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedPersona = useMemo(
    () => personas.find((persona) => persona.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId]
  );

  useEffect(() => {
    if (!selectedPersonaId && personas.length > 0) {
      setSelectedPersonaId(personas[0].id);
      return;
    }

    if (selectedPersonaId && !personas.some((persona) => persona.id === selectedPersonaId)) {
      setSelectedPersonaId(personas[0]?.id ?? "");
    }
  }, [personas, selectedPersonaId]);

  useEffect(() => {
    setDraft(normalizePersonaDraft(selectedPersona));
  }, [selectedPersona]);

  function updateField(field, value) {
    setDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
        accentColor: draft.accentColor
      };

      const response = draft.id
        ? await updatePersona(draft.id, payload)
        : await createPersona(payload);
      const nextPersonaId = String(response?.persona?.id ?? draft.id ?? "");
      await chat?.reloadPersonaCatalog?.();
      if (draft.id && draft.id !== nextPersonaId && chat?.activeConversationPersonaId === draft.id) {
        await chat?.setConversationPersona?.(nextPersonaId);
      }
      setSelectedPersonaId(nextPersonaId);
    } catch (saveError) {
      setError(saveError?.message || "保存身份失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateNew() {
    setSelectedPersonaId("");
    setDraft(emptyDraft());
    setError("");
  }

  async function handleDelete() {
    if (!draft.id) {
      return;
    }

    const confirmed = await confirmAction({
      title: "删除 Agent 身份",
      message: `确定删除身份「${draft.name || draft.id}」吗？`,
      confirmLabel: "删除"
    });
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError("");
    try {
      await deletePersona(draft.id);
      await chat?.reloadPersonaCatalog?.();
      setSelectedPersonaId("");
      setDraft(emptyDraft());
    } catch (deleteError) {
      setError(deleteError?.message || "删除身份失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!draft.id || !file) {
      return;
    }

    setSaving(true);
    setError("");
    try {
      await uploadPersonaAvatar(draft.id, file);
      await chat?.reloadPersonaCatalog?.();
    } catch (uploadError) {
      setError(uploadError?.message || "上传头像失败");
    } finally {
      setSaving(false);
    }
  }

  const canSave = draft.name.trim() && draft.prompt.trim() && !saving;

  return (
    <div className="persona-panel">
      <header className="persona-panel-header">
        <div>
          <h2>Agent 身份</h2>
          <p>身份是资产文件里的 prompt + 头像。删掉记录后不会被系统自动恢复。</p>
        </div>
        <div className="persona-header-actions">
          <button type="button" className="persona-secondary-btn" onClick={() => onNavigate?.("chat")}>
            返回会话
          </button>
          <button type="button" className="persona-primary-btn" onClick={handleCreateNew}>
            新建身份
          </button>
        </div>
      </header>

      {error && <div className="persona-error">{error}</div>}

      <div className="persona-layout">
        <aside className="persona-list">
          {personas.length === 0 ? (
            <div className="persona-empty-list">暂无身份。可以新建，也可以直接编辑用户主目录 `.yyz/personas/身份目录/persona.json`。</div>
          ) : (
            personas.map((persona) => (
              <button
                key={persona.id}
                type="button"
                className={`persona-card ${persona.id === selectedPersonaId ? "active" : ""}`}
                onClick={() => setSelectedPersonaId(persona.id)}
                style={{ "--persona-accent": persona.accentColor || "#2563eb" }}
              >
                {persona.avatarUrl ? (
                  <img src={persona.avatarUrl} alt="" />
                ) : (
                  <span>{persona.name.slice(0, 2).toUpperCase()}</span>
                )}
                <div>
                  <strong>{persona.name}</strong>
                  <small>{persona.description || persona.id}</small>
                </div>
              </button>
            ))
          )}
        </aside>

        <section className="persona-editor">
          <div className="persona-editor-card" style={{ "--persona-accent": draft.accentColor || "#2563eb" }}>
            <div className="persona-editor-top">
              <div className="persona-avatar-large">
                {draft.avatarUrl ? <img src={draft.avatarUrl} alt="" /> : <span>{draft.name.slice(0, 2) || "AI"}</span>}
              </div>
              <div>
                <h3>{draft.id ? "编辑身份" : "新建身份"}</h3>
                <p>{draft.id ? draft.id : "保存后会写入用户主目录 .yyz/personas/身份名称/persona.json"}</p>
                {draft.id && (
                  <label className="persona-upload-btn">
                    上传头像
                    <input type="file" accept=".png,.svg,image/png,image/svg+xml" onChange={handleAvatarUpload} />
                  </label>
                )}
              </div>
            </div>

            <label className="persona-field">
              <span>名称</span>
              <input value={draft.name} onChange={(event) => updateField("name", event.target.value)} />
            </label>

            <label className="persona-field">
              <span>描述</span>
              <input value={draft.description} onChange={(event) => updateField("description", event.target.value)} />
            </label>

            <label className="persona-field">
              <span>强调色</span>
              <input value={draft.accentColor} onChange={(event) => updateField("accentColor", event.target.value)} />
            </label>

            <label className="persona-field">
              <span>身份 Prompt</span>
              <textarea
                value={draft.prompt}
                onChange={(event) => updateField("prompt", event.target.value)}
                rows={12}
              />
            </label>

            <div className="persona-actions">
              <button type="button" className="persona-primary-btn" disabled={!canSave} onClick={handleSave}>
                {saving ? "保存中..." : "保存身份"}
              </button>
              {draft.id && (
                <button type="button" className="persona-danger-btn" disabled={saving} onClick={handleDelete}>
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
