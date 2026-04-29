import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearRemoteControlRecords,
  fetchRemoteControlConfig,
  fetchRemoteControlRecords,
  saveRemoteControlConfig
} from "../../api/remoteControlApi";
import { fetchSkills, selectWorkplaceBySystemDialog } from "../../api/chatApi";
import { fetchPersonas } from "../../api/personasApi";
import { formatTimestamp } from "../../shared/formatTimestamp";
import { confirmAction } from "../../shared/feedback";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { parseToolMessagePayload } from "../chat/toolMessageCodec";
import "./remote-control.css";

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const key = skillName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(skillName);
  }

  return normalized;
}

function getSkillIdentifier(skill) {
  const skillKey = String(skill?.skillKey ?? "").trim();
  if (skillKey) {
    return skillKey;
  }

  const relativePath = String(skill?.relativePath ?? "").trim();
  if (relativePath) {
    return relativePath;
  }

  return String(skill?.name ?? "").trim();
}

function normalizeSkillCatalog(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map((item) => ({
      scope: String(item?.scope ?? ""),
      skillKey: String(item?.skillKey ?? ""),
      name: String(item?.name ?? ""),
      displayName: String(item?.displayName ?? item?.name ?? ""),
      shortDescription: String(item?.shortDescription ?? item?.description ?? ""),
      iconSmall: String(item?.iconSmall ?? ""),
      iconLarge: String(item?.iconLarge ?? ""),
      brandColor: String(item?.brandColor ?? ""),
      description: String(item?.description ?? ""),
      relativePath: String(item?.relativePath ?? ""),
      isSystem: Boolean(item?.isSystem)
    }))
    .filter((item) => getSkillIdentifier(item).length > 0);
}

function getSkillMatchKeys(skill) {
  const keys = [getSkillIdentifier(skill), String(skill?.name ?? "").trim()];
  return Array.from(new Set(keys.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeSkillKeySet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => String(item ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeGlobalConfig(config) {
  return {
    activeProviderKey: String(config?.activeProviderKey ?? "").trim().toLowerCase(),
    workspacePath: String(config?.workspacePath ?? "").trim(),
    personaId: String(config?.personaId ?? "").trim(),
    activeSkillNames: normalizeSkillNames(config?.activeSkillNames)
  };
}

function normalizePersonaCatalog(personas) {
  return (Array.isArray(personas) ? personas : [])
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      name: String(item?.name ?? "").trim(),
      description: String(item?.description ?? "").trim(),
      avatarUrl: String(item?.avatarUrl ?? "").trim(),
      accentColor: String(item?.accentColor ?? "#2563eb").trim() || "#2563eb"
    }))
    .filter((item) => item.id && item.name);
}

function normalizeProviderConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  return {
    ...config
  };
}

function isEmptyProviderConfig(config) {
  return Object.keys(normalizeProviderConfig(config)).length === 0;
}

function normalizeProviders(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => ({
      key: String(item?.key ?? "").trim().toLowerCase(),
      label: String(item?.label ?? "").trim() || String(item?.key ?? "").trim()
    }))
    .filter((item) => item.key);
}

function getRecordKind(record) {
  return String(record?.meta?.kind ?? "").trim();
}

function getRecordTimestamp(record) {
  const timestamp = Number(record?.timestamp ?? 0);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp;
  }
  const createdAt = Number(record?.createdAt ?? 0);
  if (Number.isFinite(createdAt) && createdAt > 0) {
    return createdAt;
  }
  return 0;
}

function getRoleLabel(record) {
  const kind = getRecordKind(record);
  if (kind === "runtime_hook_injected" || kind === "runtime_hook") {
    return "Runtime Hook";
  }

  const source = String(record?.source ?? "").trim().toLowerCase();
  if (source === "runtime_hook") {
    return "Runtime Hook";
  }

  const role = String(record?.role ?? "").trim().toLowerCase();
  if (role === "user") {
    return "User";
  }
  if (role === "assistant") {
    return "Assistant";
  }
  if (role === "tool") {
    return "Tool";
  }
  return "System";
}

function getRecordClassName(record) {
  const kind = getRecordKind(record);
  if (kind === "runtime_error") {
    return "rc-record is-error";
  }
  if (kind === "runtime_hook" || kind === "runtime_hook_injected") {
    return "rc-record is-hook";
  }
  if (kind === "tool_event") {
    return "rc-record is-tool";
  }
  if (String(record?.role ?? "").trim() === "user") {
    return "rc-record is-user";
  }
  return "rc-record";
}

function getToolPayload(record) {
  const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
  if (String(meta.kind ?? "").trim() === "tool_event") {
    return meta;
  }
  if (String(record?.role ?? "").trim() !== "tool") {
    return null;
  }
  return parseToolMessagePayload(record?.content ?? "");
}

function formatProviderLabel(key, providers) {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized) {
    return "未启用";
  }
  const match = providers.find((item) => item.key === normalized);
  return match?.label || normalized;
}

function isRenderableProviderField(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function RecordAttachments({ record }) {
  const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="rc-attachments">
      {attachments.map((attachment, index) => {
        const dataUrl = String(attachment?.dataUrl ?? attachment?.url ?? "").trim();
        const mimeType = String(attachment?.mimeType ?? "").trim();
        const name = String(attachment?.name ?? `image_${index + 1}`).trim() || `image_${index + 1}`;
        if (!dataUrl || !mimeType.startsWith("image/")) {
          return null;
        }

        return (
          <figure key={`${name}_${index}`} className="rc-attachment">
            <img src={dataUrl} alt={name} loading="lazy" />
            <figcaption>{name}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function RecordParsedFiles({ record }) {
  const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
  const parsedFiles = Array.isArray(meta.parsedFiles) ? meta.parsedFiles : [];
  if (parsedFiles.length === 0) {
    return null;
  }

  return (
    <div className="rc-files">
      {parsedFiles.map((file, index) => {
        const name = String(file?.name ?? `file_${index + 1}`).trim() || `file_${index + 1}`;
        const parseStatus = String(file?.parseStatus ?? "parsed").trim() || "parsed";
        const note = String(file?.note ?? "").trim();
        const extractedText = String(file?.extractedText ?? "").trim();
        const displayText = extractedText || note;

        return (
          <article key={`${name}_${index}`} className="rc-file-card">
            <header>
              <strong>{name}</strong>
              <span>{parseStatus}</span>
            </header>
            {displayText && <pre>{displayText}</pre>}
          </article>
        );
      })}
    </div>
  );
}

function RuntimeHookRecord({ record }) {
  const level = String(record?.meta?.level ?? "hint").trim();
  const summary =
    level === "warning"
      ? "Runtime Hook 提醒（warning）"
      : level === "strong"
        ? "Runtime Hook 提醒（strong）"
        : "Runtime Hook 提醒";
  return (
    <div className={`rc-hook level-${level}`}>
      <strong>{summary}</strong>
    </div>
  );
}

function ToolRecord({ record }) {
  const payload = getToolPayload(record);
  if (!payload) {
    return <MarkdownMessage content={String(record?.content ?? "")} />;
  }

  const toolName = String(payload?.toolName ?? record?.toolName ?? "unknown").trim() || "unknown";
  const resultText = String(payload?.result ?? record?.content ?? "").trim();
  const hooks = Array.isArray(payload?.hooks) ? payload.hooks : [];

  return (
    <div className="rc-tool-card">
      <header>
        <strong>{toolName}</strong>
        <span>{payload?.isError ? "失败" : "完成"}</span>
      </header>
      {resultText && <pre>{resultText}</pre>}
      {hooks.length > 0 && (
        <div className="rc-tool-hooks">
          {hooks.map((hook, index) => (
            <div
              key={String(hook?.id ?? `tool_hook_${index + 1}`)}
              className={`rc-hook-item ${String(hook?.level ?? "hint").trim()}`}
            >
              <span>{String(hook?.level ?? "hint").trim()}</span>
              <p>{String(hook?.message ?? "").trim()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RemoteRecordItem({ record }) {
  const kind = getRecordKind(record);
  const providerKey = String(record?.providerKey ?? "").trim().toLowerCase();
  const timestamp = getRecordTimestamp(record);
  const turnStatus = String(record?.turnStatus ?? "").trim().toLowerCase();

  return (
    <article className={getRecordClassName(record)}>
      <header className="rc-record-head">
        <strong>{getRoleLabel(record)}</strong>
        <div>
          <span>#{Number(record?.seq ?? 0)}</span>
          {timestamp > 0 && <span>{formatTimestamp(timestamp)}</span>}
          {providerKey && <span className="rc-pill">{providerKey}</span>}
          {kind && <span className="rc-pill">{kind}</span>}
          {turnStatus && <span className="rc-pill">{turnStatus}</span>}
        </div>
      </header>

      {kind === "runtime_hook" || kind === "runtime_hook_injected" ? (
        <RuntimeHookRecord record={record} />
      ) : kind === "tool_event" || String(record?.role ?? "").trim() === "tool" ? (
        <ToolRecord record={record} />
      ) : (
        <MarkdownMessage content={String(record?.content ?? "")} />
      )}

      <RecordAttachments record={record} />
      <RecordParsedFiles record={record} />
    </article>
  );
}

export function RemoteControlPanel() {
  const [globalConfig, setGlobalConfig] = useState(() =>
    normalizeGlobalConfig({
      activeProviderKey: "",
      workspacePath: "",
      personaId: "",
      activeSkillNames: []
    })
  );
  const [providerConfig, setProviderConfig] = useState(() => normalizeProviderConfig({}));
  const [providers, setProviders] = useState([]);
  const [skillCatalog, setSkillCatalog] = useState([]);
  const [skillCatalogLoaded, setSkillCatalogLoaded] = useState(false);
  const [skillCatalogRefreshing, setSkillCatalogRefreshing] = useState(false);
  const [personaCatalog, setPersonaCatalog] = useState([]);
  const [personaCatalogLoaded, setPersonaCatalogLoaded] = useState(false);
  const [workplaceSelecting, setWorkplaceSelecting] = useState(false);
  const [records, setRecords] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [status, setStatus] = useState({
    running: false,
    queuedCount: 0,
    activeTurnId: 0,
    lastRunError: "",
    lastRunAt: 0
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearingRecords, setClearingRecords] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [personaMenuOpen, setPersonaMenuOpen] = useState(false);
  const skillCatalogRequestIdRef = useRef(0);
  const personaCatalogRequestIdRef = useRef(0);
  const providerMenuRef = useRef(null);
  const personaMenuRef = useRef(null);

  const sortedRecords = useMemo(
    () => [...records].sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0)),
    [records]
  );
  const providerFields = useMemo(
    () => Object.entries(providerConfig).filter(([, value]) => isRenderableProviderField(value)),
    [providerConfig]
  );
  const projectSkills = useMemo(
    () => skillCatalog.filter((item) => item.scope === "project" && !item.isSystem),
    [skillCatalog]
  );
  const globalSkills = useMemo(
    () => skillCatalog.filter((item) => item.scope === "global" && !item.isSystem),
    [skillCatalog]
  );
  const systemSkills = useMemo(() => skillCatalog.filter((item) => item.isSystem), [skillCatalog]);
  const selectedSkillKeySet = useMemo(
    () => normalizeSkillKeySet(globalConfig.activeSkillNames),
    [globalConfig.activeSkillNames]
  );
  const knownSkillKeySet = useMemo(() => {
    const result = new Set();
    for (const skill of skillCatalog) {
      for (const key of getSkillMatchKeys(skill)) {
        result.add(key.toLowerCase());
      }
    }
    return result;
  }, [skillCatalog]);
  const unknownSelectedSkills = useMemo(
    () =>
      globalConfig.activeSkillNames.filter(
        (item) => !knownSkillKeySet.has(String(item ?? "").trim().toLowerCase())
      ),
    [globalConfig.activeSkillNames, knownSkillKeySet]
  );
  const providerOptions = useMemo(
    () => [
      { key: "", label: "不启用" },
      ...providers.map((provider) => ({
        key: provider.key,
        label: provider.label
      }))
    ],
    [providers]
  );
  const activePersona = useMemo(
    () => personaCatalog.find((item) => item.id === globalConfig.personaId) ?? null,
    [personaCatalog, globalConfig.personaId]
  );

  useEffect(() => {
    function handleGlobalPointerDown(event) {
      if (providerMenuRef.current && !providerMenuRef.current.contains(event.target)) {
        setProviderMenuOpen(false);
      }
      if (personaMenuRef.current && !personaMenuRef.current.contains(event.target)) {
        setPersonaMenuOpen(false);
      }
    }

    function handleGlobalKeyDown(event) {
      if (event.key === "Escape") {
        setProviderMenuOpen(false);
        setPersonaMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", handleGlobalPointerDown);
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown);
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  async function refreshSkillCatalog({ workspacePath = globalConfig.workspacePath, silent = false } = {}) {
    const requestId = ++skillCatalogRequestIdRef.current;
    if (!silent) {
      setSkillCatalogRefreshing(true);
    }

    try {
      const response = await fetchSkills({
        workspacePath,
        includeGlobal: true,
        includeProject: true,
        includeSystem: true
      });

      if (requestId !== skillCatalogRequestIdRef.current) {
        return;
      }

      setSkillCatalog(normalizeSkillCatalog(response?.skills));
    } catch {
      if (requestId !== skillCatalogRequestIdRef.current) {
        return;
      }

      setSkillCatalog([]);
    } finally {
      if (requestId === skillCatalogRequestIdRef.current) {
        setSkillCatalogLoaded(true);
        setSkillCatalogRefreshing(false);
      }
    }
  }

  async function refreshPersonaCatalog({ silent = false } = {}) {
    const requestId = ++personaCatalogRequestIdRef.current;
    if (!silent) {
      setPersonaCatalogLoaded(false);
    }

    try {
      const response = await fetchPersonas();
      if (requestId !== personaCatalogRequestIdRef.current) {
        return;
      }
      setPersonaCatalog(normalizePersonaCatalog(response?.personas));
    } catch {
      if (requestId !== personaCatalogRequestIdRef.current) {
        return;
      }
      setPersonaCatalog([]);
    } finally {
      if (requestId === personaCatalogRequestIdRef.current) {
        setPersonaCatalogLoaded(true);
      }
    }
  }

  async function loadConfig() {
    const response = await fetchRemoteControlConfig();
    const normalizedConfig = normalizeGlobalConfig(response?.config ?? {});
    setGlobalConfig(normalizedConfig);
    setProviderConfig((prev) => {
      const next = normalizeProviderConfig(response?.providerConfig ?? {});
      if (normalizedConfig.activeProviderKey) {
        return next;
      }

      return isEmptyProviderConfig(next) ? normalizeProviderConfig(prev) : next;
    });
    setProviders(normalizeProviders(response?.providers));
    await Promise.all([
      refreshSkillCatalog({ workspacePath: normalizedConfig.workspacePath, silent: true }),
      refreshPersonaCatalog({ silent: true })
    ]);
  }

  async function loadRecords({ append = false } = {}) {
    const response = await fetchRemoteControlRecords({
      limit: 30,
      cursor: append ? nextCursor : null
    });

    const incoming = Array.isArray(response?.records) ? response.records : [];
    setRecords((prev) => {
      const merged = append ? [...prev, ...incoming] : incoming;
      const bySeq = new Map();
      for (const item of merged) {
        const seq = Number(item?.seq ?? 0);
        if (!Number.isFinite(seq) || seq <= 0) {
          continue;
        }
        bySeq.set(seq, item);
      }
      return Array.from(bySeq.values());
    });

    setNextCursor(Number.isFinite(Number(response?.nextCursor)) ? Number(response.nextCursor) : null);
    if (response?.status && typeof response.status === "object") {
      setStatus({
        running: Boolean(response.status.running),
        queuedCount: Number(response.status.queuedCount ?? 0),
        activeTurnId: Number(response.status.activeTurnId ?? 0),
        lastRunError: String(response.status.lastRunError ?? ""),
        lastRunAt: Number(response.status.lastRunAt ?? 0)
      });
    }
  }

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        await loadConfig();
        await loadRecords();
      } catch (loadError) {
        if (!mounted) {
          return;
        }
        setError(String(loadError?.message ?? "加载远程控制模块失败"));
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  function updateProviderField(fieldKey, nextValue) {
    const key = String(fieldKey ?? "").trim();
    if (!key) {
      return;
    }

    setProviderConfig((prev) => ({
      ...prev,
      [key]: nextValue
    }));
  }

  function updateGlobalField(fieldKey, nextValue) {
    const key = String(fieldKey ?? "").trim();
    if (!key) {
      return;
    }

    setGlobalConfig((prev) => ({
      ...prev,
      [key]: nextValue
    }));
  }

  function handleProviderSelect(nextProviderKey) {
    updateGlobalField("activeProviderKey", nextProviderKey);
    setProviderMenuOpen(false);
  }

  async function handleSaveConfig(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const normalizedActiveProviderKey = String(globalConfig.activeProviderKey ?? "").trim().toLowerCase();
      const payload = {
        activeProviderKey: globalConfig.activeProviderKey,
        workspacePath: globalConfig.workspacePath,
        personaId: globalConfig.personaId,
        activeSkillNames: normalizeSkillNames(globalConfig.activeSkillNames)
      };
      if (normalizedActiveProviderKey && !isEmptyProviderConfig(providerConfig)) {
        payload.providerConfig = providerConfig;
      }
      const response = await saveRemoteControlConfig({
        ...payload
      });
      const normalizedConfig = normalizeGlobalConfig(response?.config ?? globalConfig);
      setGlobalConfig(normalizedConfig);
      setProviderConfig(normalizeProviderConfig(response?.providerConfig ?? providerConfig));
      setProviders(normalizeProviders(response?.providers ?? providers));
      await Promise.all([
        refreshSkillCatalog({ workspacePath: normalizedConfig.workspacePath, silent: true }),
        refreshPersonaCatalog({ silent: true })
      ]);
      setMessage("远程控制配置已保存");
      await loadRecords();
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh() {
    setError("");
    try {
      await loadConfig();
      await loadRecords();
    } catch (refreshError) {
      setError(String(refreshError?.message ?? "刷新失败"));
    }
  }

  async function handleClearRecords() {
    if (clearingRecords) {
      return;
    }

    const confirmed = await confirmAction({
      title: "清空远程控制历史",
      message: "确认清空远程控制历史记录吗？此操作不可恢复。",
      confirmLabel: "清空"
    });
    if (!confirmed) {
      return;
    }

    setClearingRecords(true);
    setError("");
    setMessage("");

    try {
      const result = await clearRemoteControlRecords();
      const deletedMessages = Number(result?.deletedMessages ?? 0);
      const deletedTurns = Number(result?.deletedTurns ?? 0);
      await loadRecords();
      setMessage(`已清空远程历史：${deletedMessages} 条消息，${deletedTurns} 个回合`);
    } catch (clearError) {
      setError(String(clearError?.message ?? "清空历史失败"));
    } finally {
      setClearingRecords(false);
    }
  }

  async function handleSelectWorkspace() {
    if (saving) {
      return;
    }

    setWorkplaceSelecting(true);
    setError("");

    try {
      const response = await selectWorkplaceBySystemDialog(globalConfig.workspacePath);
      if (response?.canceled) {
        return;
      }

      const selectedPath = String(response?.selectedPath ?? "").trim();
      if (!selectedPath) {
        setError("未获取到目录绝对路径");
        return;
      }

      updateGlobalField("workspacePath", selectedPath);
      await refreshSkillCatalog({ workspacePath: selectedPath, silent: true });
    } catch (workplaceError) {
      if (workplaceError?.name === "AbortError") {
        return;
      }

      setError(workplaceError?.message || "打开系统目录选择器失败");
    } finally {
      setWorkplaceSelecting(false);
    }
  }

  async function handleResetWorkspace() {
    if (saving) {
      return;
    }

    updateGlobalField("workspacePath", "");
    await refreshSkillCatalog({ workspacePath: "", silent: true });
  }

  function toggleSkillSelection(skill) {
    const identifier = getSkillIdentifier(skill);
    const matchKeys = getSkillMatchKeys(skill).map((item) => item.toLowerCase());
    if (!identifier) {
      return;
    }

    setGlobalConfig((previous) => {
      const current = normalizeSkillNames(previous.activeSkillNames);
      const currentSet = new Set(current.map((item) => item.toLowerCase()));
      const hasSelected = matchKeys.some((key) => currentSet.has(key));
      const next = hasSelected
        ? current.filter((item) => !matchKeys.includes(String(item ?? "").trim().toLowerCase()))
        : normalizeSkillNames([...current, identifier]);

      return {
        ...previous,
        activeSkillNames: next
      };
    });
  }

  function removeUnknownSkill(skillName) {
    const normalized = String(skillName ?? "").trim().toLowerCase();
    if (!normalized) {
      return;
    }

    setGlobalConfig((previous) => ({
      ...previous,
      activeSkillNames: normalizeSkillNames(previous.activeSkillNames).filter(
        (item) => String(item ?? "").trim().toLowerCase() !== normalized
      )
    }));
  }

  function renderSkillGroup(title, scopeLabel, list) {
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }

    return (
      <section className="rc-skills-group" key={title}>
        <header>
          <strong>{title}</strong>
          <span>{list.length}</span>
        </header>
        <div className="rc-skills-list">
          {list.map((skill) => {
            const identifier = getSkillIdentifier(skill);
            const matchKeys = getSkillMatchKeys(skill).map((item) => item.toLowerCase());
            const isSelected = matchKeys.some((key) => selectedSkillKeySet.has(key));
            const skillLabel = skill.displayName || skill.name || identifier;

            return (
              <label
                key={identifier}
                className={`rc-skill-item ${isSelected ? "is-selected" : ""} ${
                  skill.isSystem ? "is-system" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSkillSelection(skill)}
                  disabled={saving}
                />
                <span className="rc-skill-item-main">
                  <strong>{skillLabel}</strong>
                  <small>{skill.shortDescription || skill.description || identifier}</small>
                </span>
                <span className="rc-skill-item-tag">{scopeLabel}</span>
              </label>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="rc-module">
      <div className="module-title-wrap rc-title-wrap">
        <div>
          <h2>远程控制</h2>
          <p>统一 Provider 配置与历史回放，远程消息由真实渠道触发执行。</p>
        </div>
        <div className="rc-title-metrics">
          <span className={`rc-metric ${status.running ? "is-running" : ""}`}>
            {status.running ? "运行中" : "空闲"}
          </span>
          <span className="rc-metric">队列 {Number(status.queuedCount ?? 0)}</span>
          <span className="rc-metric">
            Provider：{formatProviderLabel(globalConfig.activeProviderKey, providers)}
          </span>
        </div>
      </div>

      <section className="rc-card rc-card-settings">
        <header>
          <h3>连接与运行配置</h3>
          <p>支持设置工作区路径与主智能体同款提示词，工具默认全开不单独配置。</p>
        </header>

        <form className="rc-settings-form" onSubmit={handleSaveConfig}>
          <div className="rc-settings-grid">
            <section className="rc-settings-column">
              <label>
                <span>启用 Provider</span>
                <div className="rc-provider-picker" ref={providerMenuRef}>
                  <button
                    type="button"
                    className={`rc-provider-trigger ${providerMenuOpen ? "is-open" : ""}`}
                    onClick={() => setProviderMenuOpen((prev) => !prev)}
                    disabled={saving}
                    aria-haspopup="listbox"
                    aria-expanded={providerMenuOpen}
                  >
                    <span className="rc-provider-trigger-label">
                      {formatProviderLabel(globalConfig.activeProviderKey, providers)}
                    </span>
                    <span className="rc-select-caret" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                  </button>
                  {providerMenuOpen && (
                    <div className="rc-provider-menu" role="listbox" aria-label="选择 Provider">
                      {providerOptions.map((option) => {
                        const selected = option.key === globalConfig.activeProviderKey;
                        return (
                          <button
                            key={option.key || "__none__"}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`rc-provider-option ${selected ? "is-selected" : ""}`}
                            onClick={() => handleProviderSelect(option.key)}
                          >
                            <span>{option.label}</span>
                            {selected && <small>已选中</small>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </label>

              <label>
                <span>工作区路径</span>
                <div className="rc-workspace-picker">
                  <div className="rc-workspace-meta">
                    <span className="rc-workspace-path">
                      {globalConfig.workspacePath || "未设置（默认系统工作区）"}
                    </span>
                  </div>
                  <div className="rc-workspace-actions">
                    <button
                      type="button"
                      className="rc-workspace-open"
                      onClick={handleSelectWorkspace}
                      disabled={saving || workplaceSelecting}
                    >
                      {workplaceSelecting ? "打开中..." : "选择目录"}
                    </button>
                    <button
                      type="button"
                      className="rc-workspace-reset"
                      onClick={handleResetWorkspace}
                      disabled={saving || workplaceSelecting || !globalConfig.workspacePath}
                    >
                      使用默认
                    </button>
                  </div>
                </div>
              </label>

              <div className="rc-skills-picker">
                <div className="rc-skills-picker-head">
                  <div>
                    <span className="rc-skills-picker-title">启用 Skills</span>
                    <span className="rc-skills-selected-count">
                      已选 {normalizeSkillNames(globalConfig.activeSkillNames).length}
                    </span>
                    <p>与聊天页同款目录化选择，不再手动输入。</p>
                  </div>
                  <button
                    type="button"
                    className="rc-skills-refresh"
                    onClick={() => refreshSkillCatalog()}
                    disabled={saving || skillCatalogRefreshing}
                  >
                    {skillCatalogRefreshing ? "刷新中..." : "刷新库"}
                  </button>
                </div>

                {!skillCatalogLoaded ? (
                  <div className="rc-empty-inline">技能目录加载中...</div>
                ) : skillCatalog.length === 0 ? (
                  <div className="rc-empty-inline">当前目录下未发现可用技能。</div>
                ) : (
                  <div className="rc-skills-groups">
                    {renderSkillGroup("项目技能", "项目", projectSkills)}
                    {renderSkillGroup("全局个人技能", "全局", globalSkills)}
                    {renderSkillGroup("全局系统技能", "系统", systemSkills)}
                  </div>
                )}

                {unknownSelectedSkills.length > 0 && (
                  <div className="rc-skills-unknown">
                    <span>以下已启用项未在当前目录中找到：</span>
                    <div className="rc-skill-chip-list">
                      {unknownSelectedSkills.map((skillName) => (
                        <button
                          type="button"
                          key={skillName}
                          className="rc-skill-chip"
                          onClick={() => removeUnknownSkill(skillName)}
                          disabled={saving}
                          title="点击移除"
                        >
                          {skillName}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {providerFields.length > 0 ? (
                <div className="rc-provider-fields">
                  {providerFields.map(([fieldKey, fieldValue]) => {
                    const valueType = typeof fieldValue;
                    if (valueType === "boolean") {
                      return (
                        <label key={fieldKey} className="rc-provider-field">
                          <span>{fieldKey}</span>
                          <input
                            type="checkbox"
                            checked={Boolean(fieldValue)}
                            onChange={(event) => updateProviderField(fieldKey, event.target.checked)}
                            disabled={saving}
                          />
                        </label>
                      );
                    }

                    return (
                      <label key={fieldKey} className="rc-provider-field">
                        <span>{fieldKey}</span>
                        <input
                          type={fieldKey.toLowerCase().includes("secret") ? "password" : "text"}
                          value={fieldValue === null ? "" : String(fieldValue)}
                          onChange={(event) => updateProviderField(fieldKey, event.target.value)}
                          disabled={saving}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rc-empty-inline">当前 Provider 无需额外初始化字段。</div>
              )}
            </section>

            <section className="rc-settings-column">
              <div className="rc-persona-picker-block">
                <div className="rc-persona-picker-head">
                  <div>
                    <span className="rc-persona-picker-title">Agent 身份</span>
                    <p>复用 Chat 的身份资产，远程回合运行时只注入选中的 persona prompt。</p>
                  </div>
                  <button
                    type="button"
                    className="rc-skills-refresh"
                    onClick={() => refreshPersonaCatalog()}
                    disabled={saving || !personaCatalogLoaded}
                  >
                    刷新身份
                  </button>
                </div>

                <div
                  className="rc-persona-picker"
                  ref={personaMenuRef}
                  style={{ "--persona-accent": activePersona?.accentColor || "#2563eb" }}
                >
                  <button
                    type="button"
                    className={`rc-persona-trigger ${personaMenuOpen ? "is-open" : ""}`}
                    onClick={() => setPersonaMenuOpen((prev) => !prev)}
                    disabled={saving || !personaCatalogLoaded}
                    aria-haspopup="listbox"
                    aria-expanded={personaMenuOpen}
                  >
                    <span className="rc-persona-avatar">
                      {activePersona?.avatarUrl ? (
                        <img src={activePersona.avatarUrl} alt="" />
                      ) : (
                        <span>{activePersona?.name?.slice(0, 2) || "AI"}</span>
                      )}
                    </span>
                    <span className="rc-persona-trigger-copy">
                      <strong>{activePersona?.name || "不使用身份"}</strong>
                      <small>
                        {activePersona?.description ||
                          (personaCatalogLoaded ? `${personaCatalog.length} 个可用身份` : "身份加载中...")}
                      </small>
                    </span>
                    <span className="rc-select-caret" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                  </button>

                  {personaMenuOpen && (
                    <div className="rc-persona-menu" role="listbox" aria-label="选择 Agent 身份">
                      <button
                        type="button"
                        role="option"
                        aria-selected={!activePersona}
                        className={`rc-persona-option ${!activePersona ? "is-selected" : ""}`}
                        onClick={() => {
                          updateGlobalField("personaId", "");
                          setPersonaMenuOpen(false);
                        }}
                      >
                        <span className="rc-persona-avatar is-muted">AI</span>
                        <span className="rc-persona-option-copy">
                          <strong>不使用身份</strong>
                          <small>只使用 YYZ_CLAW 默认远程行为</small>
                        </span>
                        {!activePersona && <small className="rc-persona-selected-mark">已选</small>}
                      </button>

                      {personaCatalog.map((persona) => {
                        const selected = persona.id === globalConfig.personaId;
                        return (
                          <button
                            key={persona.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`rc-persona-option ${selected ? "is-selected" : ""}`}
                            style={{ "--persona-accent": persona.accentColor || "#2563eb" }}
                            onClick={() => {
                              updateGlobalField("personaId", persona.id);
                              setPersonaMenuOpen(false);
                            }}
                          >
                            {persona.avatarUrl ? (
                              <img className="rc-persona-avatar" src={persona.avatarUrl} alt="" />
                            ) : (
                              <span className="rc-persona-avatar">{persona.name.slice(0, 2).toUpperCase()}</span>
                            )}
                            <span className="rc-persona-option-copy">
                              <strong>{persona.name}</strong>
                              <small>{persona.description || persona.id}</small>
                            </span>
                            {selected && <small className="rc-persona-selected-mark">已选</small>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {activePersona ? (
                  <div
                    className="rc-persona-preview"
                    style={{ "--persona-accent": activePersona.accentColor || "#2563eb" }}
                  >
                    {activePersona.avatarUrl && (
                      <img className="rc-persona-preview-avatar" src={activePersona.avatarUrl} alt="" />
                    )}
                    <div>
                      <strong>{activePersona.name}</strong>
                      <p>{activePersona.description || "这个身份没有描述。"}</p>
                    </div>
                  </div>
                ) : (
                  <div className="rc-empty-inline">当前远程回合不会额外注入身份 prompt。</div>
                )}
              </div>
              <p className="rc-inline-note">
                远程链路已对齐主智能体多层 system 注入（persona / AGENTS / workplace / long-term-memory / skills），且不注入 memory_summary。
              </p>
            </section>
          </div>

          <div className="rc-settings-actions">
            <button type="submit" disabled={saving}>
              {saving ? "保存中..." : "保存配置"}
            </button>
            <button type="button" onClick={handleRefresh} disabled={loading || saving}>
              刷新
            </button>
          </div>
        </form>
      </section>

      <section className="rc-card rc-card-records">
        <header className="rc-records-head">
          <div>
            <h3>统一运行记录</h3>
            <p>跨 Provider 合并展示，按序号回放完整过程。</p>
          </div>
          <div className="rc-records-actions">
            <button
              type="button"
              className="is-danger"
              onClick={handleClearRecords}
              disabled={loading || saving || clearingRecords || records.length === 0}
            >
              {clearingRecords ? "清空中..." : "清空历史记录"}
            </button>
            <button type="button" onClick={() => loadRecords({ append: true })} disabled={!nextCursor || loading}>
              {nextCursor ? "加载更早记录" : "没有更多记录"}
            </button>
          </div>
        </header>

        <div className="rc-records">
          {sortedRecords.length === 0 && <div className="rc-empty">暂无远程控制记录</div>}
          {sortedRecords.map((record) => (
            <RemoteRecordItem key={`${record.seq}_${record.id}`} record={record} />
          ))}
        </div>
      </section>

      {message && <p className="status-note success">{message}</p>}
      {error && <p className="status-note error">{error}</p>}
    </div>
  );
}
