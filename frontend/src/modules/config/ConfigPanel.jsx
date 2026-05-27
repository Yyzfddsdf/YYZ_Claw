import { useEffect, useMemo, useState } from "react";
import {
  MODEL_PROVIDER_OPTIONS,
  getModelProviderOption,
  normalizeModelProvider
} from "../../shared/modelProviders";
import { NumericInput } from "../../shared/NumericInput";
import "./config.css";

const HOOK_EVENT_OPTIONS = [
  { key: "SessionStart", label: "SessionStart", desc: "会话第一条用户消息进入时触发一次。" },
  { key: "UserPromptSubmitted", label: "UserPromptSubmitted", desc: "每次用户提交消息时触发。" },
  { key: "PreToolUse", label: "PreToolUse", desc: "工具执行前触发。" },
  { key: "PermissionRequest", label: "PermissionRequest", desc: "工具进入审批前触发。" },
  { key: "PostToolUse", label: "PostToolUse", desc: "工具执行后触发。" },
  { key: "Stop", label: "Stop", desc: "当前 agent 回合结束时触发。" }
];

function normalizeConfig(config) {
  const profiles = Array.isArray(config?.modelProfiles)
    ? config.modelProfiles.map((profile, index) => ({
        id: String(profile?.id ?? `model_${index + 1}`).trim() || `model_${index + 1}`,
        provider: normalizeModelProvider(profile?.provider),
        name: String(profile?.name ?? "").trim(),
        model: String(profile?.model ?? "").trim(),
        baseURL: String(profile?.baseURL ?? "").trim(),
        apiKey: String(profile?.apiKey ?? "").trim(),
        maxContextWindow:
          profile?.maxContextWindow === undefined || profile?.maxContextWindow === null
            ? ""
            : String(profile.maxContextWindow),
        maxOutputTokens:
          profile?.maxOutputTokens === undefined || profile?.maxOutputTokens === null
            ? ""
            : String(profile.maxOutputTokens),
        supportsVision: profile?.supportsVision !== false
      }))
    : [];
  const firstProfileId = profiles[0]?.id ?? "";
  const firstVisionProfileId = profiles.find((profile) => profile.supportsVision)?.id ?? "";
  return {
    modelProfiles: profiles,
    defaultMainModelProfileId: config?.defaultMainModelProfileId ?? firstProfileId,
    defaultSubagentModelProfileId: config?.defaultSubagentModelProfileId ?? firstProfileId,
    defaultCompressionModelProfileId: config?.defaultCompressionModelProfileId ?? firstProfileId,
    defaultVisionModelProfileId: config?.defaultVisionModelProfileId ?? firstVisionProfileId,
    tavilyApiKey: config?.tavilyApiKey ?? "",
    compressionMaxOutputTokens:
      config?.compressionMaxOutputTokens === undefined || config?.compressionMaxOutputTokens === null
        ? ""
        : String(config.compressionMaxOutputTokens),
    sttProvider: "cloudflare",
    sttCloudflareApiToken: config?.sttCloudflareApiToken ?? "",
    sttCloudflareAccountId: config?.sttCloudflareAccountId ?? "",
    sttCloudflareModel: config?.sttCloudflareModel ?? "@cf/openai/whisper-large-v3-turbo"
  };
}

function createModelProfile(index = 1) {
  return {
    id: `model_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    provider: "openai-completion",
    name: `模型 ${index}`,
    model: "",
    baseURL: "",
    apiKey: "",
    maxContextWindow: "",
    maxOutputTokens: "",
    supportsVision: true
  };
}

function normalizeMcpConfig(config) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  return servers.map(s => ({
    name: s.name ?? "",
    transport: s.transport ?? "stdio",
    cwd: s.cwd ?? "",
    command: s.command ?? "",
    args: Array.isArray(s.args) ? s.args : [],
    url: s.url ?? "",
    env: s.env && typeof s.env === 'object' ? Object.entries(s.env).map(([k, v]) => ({ key: k, value: String(v) })) : [],
    headers: s.httpHeaders && typeof s.httpHeaders === 'object' ? Object.entries(s.httpHeaders).map(([k, v]) => ({ key: k, value: String(v) })) : [],
    enabled: s.enabled !== false,
    startupTimeoutMs: s.startupTimeoutMs ?? "",
    requestTimeoutMs: s.requestTimeoutMs ?? ""
  }));
}

function formatStatusText(status) {
  if (!status) return "尚未加载 MCP 配置";
  const toolCount = Number(status.toolCount ?? 0);
  const errorCount = Number(status.errorCount ?? 0);
  return `已加载 ${toolCount} 个工具${errorCount > 0 ? `，${errorCount} 个失败` : ""}`;
}

function normalizeMcpStatusServers(status) {
  return Array.isArray(status?.servers)
    ? status.servers
        .map((server, index) => ({
          key: String(server?.name ?? `server_${index + 1}`).trim() || `server_${index + 1}`,
          name: String(server?.name ?? "").trim(),
          displayName: String(server?.displayName ?? server?.name ?? "").trim(),
          pluginName: String(server?.pluginName ?? "").trim(),
          sourceType: String(server?.sourceType ?? "global").trim() || "global",
          transport: String(server?.transport ?? "").trim(),
          command: String(server?.command ?? "").trim(),
          url: String(server?.url ?? "").trim(),
          status: String(server?.status ?? "").trim(),
          error: String(server?.error ?? "").trim(),
          toolCount: Number(server?.toolCount ?? 0)
        }))
        .filter((server) => server.name || server.displayName)
    : [];
}

function formatMcpServerStatus(status) {
  const normalized = String(status ?? "").trim();
  if (!normalized) return "unknown";
  if (normalized === "ready") return "ready";
  if (normalized === "error") return "error";
  if (normalized === "loading") return "loading";
  return normalized;
}

function normalizeHookSettings(settings) {
  const source = settings?.events ?? {};
  return {
    events: Object.fromEntries(
      HOOK_EVENT_OPTIONS.map((item) => [
        item.key,
        {
          enabled: source?.[item.key]?.enabled !== false
        }
      ])
    )
  };
}

export function ConfigPanel({
  initialConfig,
  initialMcpConfig,
  initialHookSettings,
  mcpStatus,
  loading,
  saving,
  mcpLoading,
  mcpSaving,
  hookSettingsLoading,
  hookSettingsSaving,
  error,
  mcpError,
  hookSettingsError,
  onSave,
  onSaveMcpConfig,
  onSaveHookSettings
}) {
  const [form, setForm] = useState(() => normalizeConfig(initialConfig));
  const [localError, setLocalError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [mcpServers, setMcpServers] = useState(() => normalizeMcpConfig(initialMcpConfig));
  const [mcpLocalError, setMcpLocalError] = useState("");
  const [mcpSaveMessage, setMcpSaveMessage] = useState("");
  const [hookSettings, setHookSettings] = useState(() => normalizeHookSettings(initialHookSettings));
  const [hookSettingsLocalError, setHookSettingsLocalError] = useState("");
  const [hookSettingsSaveMessage, setHookSettingsSaveMessage] = useState("");
  const [expandedServers, setExpandedServers] = useState({});
  const [expandedModelProfiles, setExpandedModelProfiles] = useState({});
  const [openTransportMenuIndex, setOpenTransportMenuIndex] = useState(-1);
  const [openProfileMenu, setOpenProfileMenu] = useState("");
  const [openProviderMenuIndex, setOpenProviderMenuIndex] = useState(-1);

  useEffect(() => {
    setForm(normalizeConfig(initialConfig));
    setExpandedModelProfiles({});
  }, [initialConfig]);

  useEffect(() => {
    setMcpServers(normalizeMcpConfig(initialMcpConfig));
  }, [initialMcpConfig]);

  useEffect(() => {
    setHookSettings(normalizeHookSettings(initialHookSettings));
  }, [initialHookSettings]);

  useEffect(() => {
    function handleDocumentPointerDown(event) {
      if (event?.target?.closest?.(".select-container")) {
        return;
      }
      setOpenTransportMenuIndex(-1);
      setOpenProfileMenu("");
      setOpenProviderMenuIndex(-1);
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
    };
  }, []);

  const mcpStatusText = useMemo(() => formatStatusText(mcpStatus), [mcpStatus]);
  const mcpStatusServers = useMemo(() => normalizeMcpStatusServers(mcpStatus), [mcpStatus]);
  const globalMcpStatusServers = useMemo(
    () => mcpStatusServers.filter((server) => server.sourceType !== "plugin"),
    [mcpStatusServers]
  );
  const pluginMcpStatusServers = useMemo(
    () => mcpStatusServers.filter((server) => server.sourceType === "plugin"),
    [mcpStatusServers]
  );
  const transportOptions = useMemo(
    () => [
      { value: "stdio", label: "Stdio (本地进程)" },
      { value: "http", label: "SSE (远程 HTTP)" }
    ],
    []
  );
  const profileOptions = useMemo(
    () =>
      form.modelProfiles.map((profile) => ({
        value: profile.id,
        label: profile.name || profile.model || profile.id
      })),
    [form.modelProfiles]
  );
  const visionProfileOptions = useMemo(
    () =>
      form.modelProfiles
        .filter((profile) => profile.supportsVision)
        .map((profile) => ({
          value: profile.id,
          label: profile.name || profile.model || profile.id
        })),
    [form.modelProfiles]
  );

  function updateModelProfile(index, field, value) {
    setForm((prev) => {
      const profiles = [...prev.modelProfiles];
      profiles[index] = { ...profiles[index], [field]: value };
      const selectedVisionProfile = profiles.find(
        (profile) => profile.id === prev.defaultVisionModelProfileId
      );
      const nextVisionProfileId =
        selectedVisionProfile?.supportsVision
          ? prev.defaultVisionModelProfileId
          : profiles.find((profile) => profile.supportsVision)?.id ?? "";
      return {
        ...prev,
        modelProfiles: profiles,
        defaultVisionModelProfileId: nextVisionProfileId
      };
    });
  }

  function addModelProfile() {
    const nextProfile = createModelProfile(form.modelProfiles.length + 1);
    setForm((prev) => {
      const nextProfiles = [...prev.modelProfiles, nextProfile];
      return {
        ...prev,
        modelProfiles: nextProfiles,
        defaultMainModelProfileId: prev.defaultMainModelProfileId || nextProfile.id,
        defaultSubagentModelProfileId: prev.defaultSubagentModelProfileId || nextProfile.id,
        defaultCompressionModelProfileId: prev.defaultCompressionModelProfileId || nextProfile.id,
        defaultVisionModelProfileId: prev.defaultVisionModelProfileId || nextProfile.id
      };
    });
    setExpandedModelProfiles((prev) => ({ ...prev, [nextProfile.id]: true }));
  }

  function removeModelProfile(index) {
    const removedProfileId = form.modelProfiles[index]?.id;
    setForm((prev) => {
      const targetId = prev.modelProfiles[index]?.id;
      const nextProfiles = prev.modelProfiles.filter((_, itemIndex) => itemIndex !== index);
      const firstProfileId = nextProfiles[0]?.id ?? "";
      const firstVisionProfileId = nextProfiles.find((profile) => profile.supportsVision)?.id ?? "";
      const keepDefault = (value) => (value && value !== targetId ? value : firstProfileId);
      const keepVisionDefault = (value) =>
        value &&
        value !== targetId &&
        nextProfiles.some((profile) => profile.id === value && profile.supportsVision)
          ? value
          : firstVisionProfileId;
      return {
        ...prev,
        modelProfiles: nextProfiles,
        defaultMainModelProfileId: keepDefault(prev.defaultMainModelProfileId),
        defaultSubagentModelProfileId: keepDefault(prev.defaultSubagentModelProfileId),
        defaultCompressionModelProfileId: keepDefault(prev.defaultCompressionModelProfileId),
        defaultVisionModelProfileId: keepVisionDefault(prev.defaultVisionModelProfileId)
      };
    });
    if (removedProfileId) {
      setExpandedModelProfiles((prev) => {
        const next = { ...prev };
        delete next[removedProfileId];
        return next;
      });
    }
  }

  function toggleModelProfile(profileId) {
    setExpandedModelProfiles((prev) => ({
      ...prev,
      [profileId]: !prev[profileId]
    }));
  }

  async function handleConfigSubmit(event) {
    event.preventDefault();
    const finalProfiles = form.modelProfiles.map((profile) => ({
      id: profile.id,
      provider: normalizeModelProvider(profile.provider),
      name: profile.name.trim(),
      model: profile.model.trim(),
      baseURL: profile.baseURL.trim(),
      apiKey: profile.apiKey.trim(),
      maxContextWindow: profile.maxContextWindow ? Number(profile.maxContextWindow) : undefined,
      maxOutputTokens: profile.maxOutputTokens ? Number(profile.maxOutputTokens) : undefined,
      supportsVision: Boolean(profile.supportsVision)
    }));

    if (finalProfiles.length === 0) {
      setLocalError("至少需要添加一个模型配置");
      return;
    }
    if (finalProfiles.some((profile) => !profile.name || !profile.model || !profile.baseURL || !profile.apiKey)) {
      setLocalError("每个模型配置的名称 / Model / Base URL / API Key 均为必填项");
      return;
    }
    if (finalProfiles.some((profile) => !Number.isFinite(Number(profile.maxOutputTokens)) || Number(profile.maxOutputTokens) <= 0)) {
      setLocalError("每个模型配置都必须填写最大输出 Token 数，且必须大于 0");
      return;
    }
    if (!form.defaultMainModelProfileId || !form.defaultSubagentModelProfileId || !form.defaultCompressionModelProfileId || !form.defaultVisionModelProfileId) {
      setLocalError("主模型、子智能体模型、压缩模型、视觉工具模型默认项都必须选择");
      return;
    }
    const selectedVisionProfile = finalProfiles.find(
      (profile) => profile.id === form.defaultVisionModelProfileId
    );
    if (!selectedVisionProfile?.supportsVision) {
      setLocalError("视觉工具模型必须选择已启用图片识别的模型配置");
      return;
    }
    setLocalError("");
    setSaveMessage("");
    try {
      const payload = {
        modelProfiles: finalProfiles,
        defaultMainModelProfileId: form.defaultMainModelProfileId,
        defaultSubagentModelProfileId: form.defaultSubagentModelProfileId,
        defaultCompressionModelProfileId: form.defaultCompressionModelProfileId,
        defaultVisionModelProfileId: form.defaultVisionModelProfileId,
        tavilyApiKey: form.tavilyApiKey,
        compressionMaxOutputTokens: form.compressionMaxOutputTokens
          ? Number(form.compressionMaxOutputTokens)
          : undefined,
        sttProvider: "cloudflare",
        sttCloudflareApiToken: form.sttCloudflareApiToken,
        sttCloudflareAccountId: form.sttCloudflareAccountId,
        sttCloudflareModel: form.sttCloudflareModel
      };
      await onSave(payload);
      setSaveMessage("配置已成功保存");
    } catch { /* error handled by parent */ }
  }

  async function handleMcpSubmit(event) {
    event.preventDefault();
    const finalServers = mcpServers.map(s => {
      const server = {
        name: s.name.trim(),
        transport: s.transport,
        enabled: s.enabled,
        startupTimeoutMs: s.startupTimeoutMs ? Number(s.startupTimeoutMs) : undefined,
        requestTimeoutMs: s.requestTimeoutMs ? Number(s.requestTimeoutMs) : undefined
      };

      if (s.transport === 'stdio') {
        const envObj = {};
        s.env.forEach(item => { if (item.key.trim()) envObj[item.key.trim()] = item.value; });
        server.cwd = s.cwd.trim();
        server.command = s.command.trim();
        server.args = Array.isArray(s.args) ? s.args : String(s.args || "").split(/\s+/).filter(Boolean);
        server.env = envObj;
      } else {
        const headerObj = {};
        s.headers.forEach(item => { if (item.key.trim()) headerObj[item.key.trim()] = item.value; });
        server.url = s.url.trim();
        server.httpHeaders = headerObj;
      }
      return server;
    });

    for (const s of finalServers) {
      if (!s.name) { setMcpLocalError("Server 名称不能为空"); return; }
      if (s.transport === 'stdio' && !s.command) { setMcpLocalError(`Server [${s.name}] 的命令不能为空`); return; }
      if (s.transport === 'http' && !s.url) { setMcpLocalError(`Server [${s.name}] 的 URL 不能为空`); return; }
    }

    setMcpLocalError("");
    setMcpSaveMessage("");
    try {
      await onSaveMcpConfig({ servers: finalServers });
      setMcpSaveMessage("MCP 配置已成功应用");
    } catch { /* error handled by parent */ }
  }

  async function handleHookSettingsSubmit(event) {
    event.preventDefault();
    setHookSettingsLocalError("");
    setHookSettingsSaveMessage("");

    try {
      await onSaveHookSettings(normalizeHookSettings(hookSettings));
      setHookSettingsSaveMessage("全局 Hook 开关已成功应用");
    } catch { /* error handled by parent */ }
  }

  function updateHookEventEnabled(eventKey, enabled) {
    setHookSettings((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [eventKey]: {
          enabled
        }
      }
    }));
  }

  function addMcpServer() {
    const newIndex = mcpServers.length;
    setMcpServers(prev => [...prev, { name: "", transport: "stdio", cwd: "", command: "", args: [], url: "", env: [], headers: [], enabled: true, startupTimeoutMs: "", requestTimeoutMs: "" }]);
    setExpandedServers(prev => ({ ...prev, [newIndex]: true }));
  }

  function updateMcpServer(index, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function toggleServerExpand(index) {
    setExpandedServers(prev => ({ ...prev, [index]: !prev[index] }));
  }

  function addMcpEnv(serverIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextEnv = [...next[serverIndex].env, { key: "", value: "" }];
      next[serverIndex] = { ...next[serverIndex], env: nextEnv };
      return next;
    });
  }

  function updateMcpEnv(serverIndex, envIndex, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextEnv = [...next[serverIndex].env];
      nextEnv[envIndex] = { ...nextEnv[envIndex], [field]: value };
      next[serverIndex] = { ...next[serverIndex], env: nextEnv };
      return next;
    });
  }

  function removeMcpEnv(serverIndex, envIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      next[serverIndex] = { ...next[serverIndex], env: next[serverIndex].env.filter((_, i) => i !== envIndex) };
      return next;
    });
  }

  function addMcpHeader(serverIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextHeaders = [...(next[serverIndex].headers || []), { key: "", value: "" }];
      next[serverIndex] = { ...next[serverIndex], headers: nextHeaders };
      return next;
    });
  }

  function updateMcpHeader(serverIndex, headerIndex, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextHeaders = [...next[serverIndex].headers];
      nextHeaders[headerIndex] = { ...nextHeaders[headerIndex], [field]: value };
      next[serverIndex] = { ...next[serverIndex], headers: nextHeaders };
      return next;
    });
  }

  function removeMcpHeader(serverIndex, headerIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      next[serverIndex] = { ...next[serverIndex], headers: next[serverIndex].headers.filter((_, i) => i !== headerIndex) };
      return next;
    });
  }

  return (
    <div className="config-module">
      <div className="module-title-wrap">
        <h2>智能体配置</h2>
        <p>管理全局运行参数与 MCP 扩展能力。</p>
      </div>

      <form onSubmit={handleConfigSubmit}>
        <div className="config-section">
          <div className="config-section-header">
            <h3>模型配置组</h3>
            <button type="button" className="text-btn-brand" onClick={addModelProfile} disabled={loading || saving}>
              + 添加模型
            </button>
          </div>
          <div className="config-section-body">
            {form.modelProfiles.length === 0 && (
              <div className="config-empty-state">
                还没有模型配置。添加一个云端模型后，再设置主模型、子智能体模型、压缩模型和视觉工具模型默认项。
              </div>
            )}
            {form.modelProfiles.map((profile, index) => {
              const isExpanded = Boolean(expandedModelProfiles[profile.id]);
              return (
                <div key={profile.id} className={`model-profile-card ${isExpanded ? "is-expanded" : "is-collapsed"}`}>
                  <div className="model-profile-head">
                    <div className="model-profile-summary">
                      <strong>{profile.name || `模型 ${index + 1}`}</strong>
                      <span>{profile.model || "未填写 model"}</span>
                      <div className="model-profile-badges">
                        <em>{getModelProviderOption(profile.provider).label}</em>
                        {profile.supportsVision && <em>图片识别</em>}
                        {profile.maxContextWindow && <em>{profile.maxContextWindow} ctx</em>}
                        {profile.maxOutputTokens && <em>{profile.maxOutputTokens} out</em>}
                      </div>
                    </div>
                    <div className="model-profile-actions">
                      <button
                        type="button"
                        className="text-btn-brand"
                        onClick={() => toggleModelProfile(profile.id)}
                        disabled={loading || saving}
                      >
                        {isExpanded ? "收起" : "编辑"}
                      </button>
                      <button
                        type="button"
                        className="text-btn-danger"
                        onClick={() => removeModelProfile(index)}
                        disabled={loading || saving}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="model-profile-grid">
                  <input
                    value={profile.name}
                    onChange={(event) => updateModelProfile(index, "name", event.target.value)}
                    placeholder="配置名称，例如 GPT-5 主力"
                    disabled={loading || saving}
                  />
                  <div className="select-container model-provider-select">
                    <button
                      type="button"
                      className={`select-trigger ${openProviderMenuIndex === index ? "is-active" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenProviderMenuIndex((prev) => (prev === index ? -1 : index));
                      }}
                      disabled={loading || saving}
                    >
                      <span>{getModelProviderOption(profile.provider).label}</span>
                    </button>
                    {openProviderMenuIndex === index && (
                      <div className="select-dropdown" onClick={(event) => event.stopPropagation()}>
                        {MODEL_PROVIDER_OPTIONS.map((option) => (
                          <div
                            key={`${profile.id}_${option.value}`}
                            role="button"
                            tabIndex={0}
                            className={`select-option ${
                              normalizeModelProvider(profile.provider) === option.value ? "is-selected" : ""
                            }`}
                            onClick={() => {
                              updateModelProfile(index, "provider", option.value);
                              setOpenProviderMenuIndex(-1);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                updateModelProfile(index, "provider", option.value);
                                setOpenProviderMenuIndex(-1);
                              }
                            }}
                          >
                            <span>{option.label}</span>
                            <small>{option.description}</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <input
                    value={profile.model}
                    onChange={(event) => updateModelProfile(index, "model", event.target.value)}
                    placeholder="Model，例如 gpt-5.2"
                    disabled={loading || saving}
                  />
                  <input
                    value={profile.baseURL}
                    onChange={(event) => updateModelProfile(index, "baseURL", event.target.value)}
                    placeholder="Base URL，例如 https://api.openai.com/v1"
                    disabled={loading || saving}
                  />
                  <input
                    type="password"
                    value={profile.apiKey}
                    onChange={(event) => updateModelProfile(index, "apiKey", event.target.value)}
                    placeholder="API Key"
                    disabled={loading || saving}
                  />
                  <NumericInput
                    value={profile.maxContextWindow}
                    onChange={(value) => updateModelProfile(index, "maxContextWindow", value)}
                    placeholder="上下文窗口，例如 128000"
                    disabled={loading || saving}
                  />
                  <NumericInput
                    value={profile.maxOutputTokens}
                    onChange={(value) => updateModelProfile(index, "maxOutputTokens", value)}
                    placeholder="最大输出 Token，例如 128000"
                    disabled={loading || saving}
                  />
                  <div className="model-capability-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={profile.supportsVision}
                        onChange={(event) => updateModelProfile(index, "supportsVision", event.target.checked)}
                        disabled={loading || saving}
                      />
                      支持图片识别
                    </label>
                  </div>
                </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="config-section">
          <div className="config-section-header"><h3>默认模型分配</h3></div>
          <div className="config-section-body">
            <ProfileSelectRow
              label="主智能体默认"
              desc="新建普通会话时使用，之后每个会话可单独切换。"
              value={form.defaultMainModelProfileId}
              options={profileOptions}
              menuKey="main"
              openMenu={openProfileMenu}
              setOpenMenu={setOpenProfileMenu}
              onChange={(value) => setForm({ ...form, defaultMainModelProfileId: value })}
              disabled={loading || saving}
            />
            <ProfileSelectRow
              label="子智能体默认"
              desc="创建子对话时使用，子对话创建后也可独立切换。"
              value={form.defaultSubagentModelProfileId}
              options={profileOptions}
              menuKey="subagent"
              openMenu={openProfileMenu}
              setOpenMenu={setOpenProfileMenu}
              onChange={(value) => setForm({ ...form, defaultSubagentModelProfileId: value })}
              disabled={loading || saving}
            />
            <ProfileSelectRow
              label="压缩模型"
              desc="全局统一使用，不跟随单个会话临时选择。"
              value={form.defaultCompressionModelProfileId}
              options={profileOptions}
              menuKey="compression"
              openMenu={openProfileMenu}
              setOpenMenu={setOpenProfileMenu}
              onChange={(value) => setForm({ ...form, defaultCompressionModelProfileId: value })}
              disabled={loading || saving}
            />
            <ProfileSelectRow
              label="视觉工具模型"
              desc="供图片识别工具调用；这里只能选择已启用图片识别的模型。"
              value={form.defaultVisionModelProfileId}
              options={visionProfileOptions}
              menuKey="vision"
              openMenu={openProfileMenu}
              setOpenMenu={setOpenProfileMenu}
              onChange={(value) => setForm({ ...form, defaultVisionModelProfileId: value })}
              disabled={loading || saving || visionProfileOptions.length === 0}
            />
            <ConfigRow
              label="压缩输出上限"
              desc="可选；限制压缩摘要生成的最大输出 token。"
              value={form.compressionMaxOutputTokens}
              onChange={v => setForm({ ...form, compressionMaxOutputTokens: v })}
              type="number"
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="config-section">
          <div className="config-section-header"><h3>辅助功能 (Optional)</h3></div>
          <div className="config-section-body">
            <ConfigRow label="Search Key" desc="Tavily 搜索 API Key" value={form.tavilyApiKey} onChange={v => setForm({...form, tavilyApiKey: v})} isPassword disabled={loading || saving} />
            <div className="config-item">
              <div className="config-item-info">
                <span className="config-item-label">STT 云端</span>
                <span className="config-item-desc">语音转文字只使用 Cloudflare Workers AI，所有语音识别请求都会走云端配置。</span>
              </div>
            </div>

            <ConfigRow
              label="STT Cloudflare Token"
              desc="Cloudflare API Token（Workers AI 权限）"
              value={form.sttCloudflareApiToken}
              onChange={v => setForm({ ...form, sttCloudflareApiToken: v })}
              isPassword
              disabled={loading || saving}
            />
            <ConfigRow
              label="STT Cloudflare Account"
              desc="Cloudflare Account ID"
              value={form.sttCloudflareAccountId}
              onChange={v => setForm({ ...form, sttCloudflareAccountId: v })}
              disabled={loading || saving}
            />
            <ConfigRow
              label="STT Cloudflare Model"
              desc="示例：@cf/openai/whisper-large-v3-turbo"
              value={form.sttCloudflareModel}
              onChange={v => setForm({ ...form, sttCloudflareModel: v })}
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="config-footer">
          {saveMessage && <span className="status-note success">{saveMessage}</span>}
          {(localError || error) && <span className="status-note error">{localError || error}</span>}
          <button type="submit" className="btn-primary" disabled={loading || saving}>{saving ? "保存中..." : "保存核心配置"}</button>
        </div>
      </form>

      <div className="config-divider" style={{ margin: '1.25rem 0' }} />

      <div className="module-title-wrap">
        <h2>MCP 服务器</h2>
        <p>扩展智能体的工具集。支持本地标准输入输出 (Stdio) 和远程 SSE (HTTP)。</p>
      </div>

      <div className="config-section">
        <div className="config-section-header">
          <h3>当前已加载状态</h3>
        </div>
        <div className="config-section-body">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">运行时总览</span>
              <span className="config-item-desc">这里显示后端当前已经加载的全局 MCP 和插件级 MCP。</span>
            </div>
            <div className="config-item-control">
              <span className="status-note">{mcpStatusText}</span>
            </div>
          </div>

          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">全局 MCP</span>
              <span className="config-item-desc">来自 `config/mcp.json` 的服务器状态。</span>
            </div>
            <div className="config-item-control">
              {globalMcpStatusServers.length === 0 ? (
                <div className="config-empty-state config-inline-empty-state">当前没有已加载的全局 MCP。</div>
              ) : (
                <div className="mcp-status-list">
                  {globalMcpStatusServers.map((server) => (
                    <div key={`global_${server.key}`} className="mcp-status-card">
                      <div className="mcp-status-card-head">
                        <strong>{server.displayName || server.name}</strong>
                        <div className="mcp-status-badges">
                          <span className="server-type-badge">{server.transport || "stdio"}</span>
                          <span className={`mcp-status-badge is-${formatMcpServerStatus(server.status)}`}>
                            {formatMcpServerStatus(server.status)}
                          </span>
                        </div>
                      </div>
                      <div className="mcp-status-meta">
                        <span>name: {server.name || "-"}</span>
                        <span>tools: {server.toolCount}</span>
                      </div>
                      {server.command ? <div className="mcp-status-path">command: {server.command}</div> : null}
                      {server.url ? <div className="mcp-status-path">url: {server.url}</div> : null}
                      {server.error ? <div className="mcp-status-error">{server.error}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">插件级 MCP</span>
              <span className="config-item-desc">来自插件 `/.mcp.json` 的服务器状态；这里只读展示，不在这里编辑。</span>
            </div>
            <div className="config-item-control">
              {pluginMcpStatusServers.length === 0 ? (
                <div className="config-empty-state config-inline-empty-state">当前没有已加载的插件级 MCP。</div>
              ) : (
                <div className="mcp-status-list">
                  {pluginMcpStatusServers.map((server) => (
                    <div key={`plugin_${server.key}`} className="mcp-status-card">
                      <div className="mcp-status-card-head">
                        <strong>{server.displayName || server.name}</strong>
                        <div className="mcp-status-badges">
                          <span className="server-type-badge">{server.transport || "stdio"}</span>
                          <span className="server-type-badge mcp-plugin-badge">
                            plugin: {server.pluginName || "-"}
                          </span>
                          <span className={`mcp-status-badge is-${formatMcpServerStatus(server.status)}`}>
                            {formatMcpServerStatus(server.status)}
                          </span>
                        </div>
                      </div>
                      <div className="mcp-status-meta">
                        <span>name: {server.name || "-"}</span>
                        <span>tools: {server.toolCount}</span>
                      </div>
                      {server.command ? <div className="mcp-status-path">command: {server.command}</div> : null}
                      {server.url ? <div className="mcp-status-path">url: {server.url}</div> : null}
                      {server.error ? <div className="mcp-status-error">{server.error}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleMcpSubmit}>
        {mcpServers.map((server, sIndex) => {
          const isExpanded = expandedServers[sIndex];
          return (
            <div key={sIndex} className={`config-section collapsible ${isExpanded ? '' : 'collapsed'}`}>
              <div className="config-section-header" onClick={() => toggleServerExpand(sIndex)}>
                <div className="header-main">
                  <input 
                    type="checkbox" 
                    checked={server.enabled} 
                    onClick={e => e.stopPropagation()} 
                    onChange={e => updateMcpServer(sIndex, 'enabled', e.target.checked)} 
                    style={{ width: 'auto' }} 
                  />
                  <h3 style={{ margin: 0, opacity: server.enabled ? 1 : 0.5 }}>{server.name || "未命名 Server"}</h3>
                  <span className="server-type-badge">{server.transport}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <button 
                    type="button" 
                    onClick={(e) => { e.stopPropagation(); setMcpServers(prev => prev.filter((_, i) => i !== sIndex)); }} 
                    className="text-btn-danger"
                  >
                    移除
                  </button>
                  <svg className="chevron icon" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"/></svg>
                </div>
              </div>

              <div className="config-section-body">
                <ConfigRow label="名称" desc="Server 唯一标识" value={server.name} onChange={v => updateMcpServer(sIndex, 'name', v)} disabled={mcpSaving} />
                
                <div className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">传输类型</span>
                    <span className="config-item-desc">选择连接方式</span>
                  </div>
                  <div className="config-item-control">
                    <div className="select-container">
                      <button
                        type="button"
                        className={`select-trigger ${openTransportMenuIndex === sIndex ? "is-active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenTransportMenuIndex((prev) => (prev === sIndex ? -1 : sIndex));
                        }}
                        disabled={mcpSaving}
                      >
                        <span>
                          {transportOptions.find((option) => option.value === server.transport)?.label ||
                            "Stdio (本地进程)"}
                        </span>
                      </button>
                      {openTransportMenuIndex === sIndex && (
                        <div className="select-dropdown" onClick={(event) => event.stopPropagation()}>
                          {transportOptions.map((option) => (
                            <div
                              key={`${sIndex}_${option.value}`}
                              role="button"
                              tabIndex={0}
                              className={`select-option ${
                                server.transport === option.value ? "is-selected" : ""
                              }`}
                              onClick={() => {
                                updateMcpServer(sIndex, "transport", option.value);
                                setOpenTransportMenuIndex(-1);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  updateMcpServer(sIndex, "transport", option.value);
                                  setOpenTransportMenuIndex(-1);
                                }
                              }}
                            >
                              {option.label}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {server.transport === 'stdio' ? (
                  <>
                    <ConfigRow label="工作目录 (cwd)" desc="MCP 进程启动时的基准目录；不填则继承宿主当前目录" value={server.cwd} onChange={v => updateMcpServer(sIndex, 'cwd', v)} placeholder="例如 D:\\mcp\\filesystem-server" disabled={mcpSaving} />
                    <ConfigRow label="命令" desc="可执行程序 (node, npx, python)" value={server.command} onChange={v => updateMcpServer(sIndex, 'command', v)} disabled={mcpSaving} />
                    <ConfigRow label="参数" desc="命令行参数 (空格分隔)" value={Array.isArray(server.args) ? server.args.join(' ') : server.args} onChange={v => updateMcpServer(sIndex, 'args', v)} disabled={mcpSaving} />
                    
                    <div className="config-item">
                      <div className="config-item-info">
                        <span className="config-item-label">环境变量 (Env)</span>
                        <span className="config-item-desc">配置 API Key 或其他运行参数</span>
                      </div>
                      <div className="config-item-control">
                        {server.env.map((env, eIndex) => (
                          <div key={eIndex} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <input placeholder="KEY" value={env.key} onChange={e => updateMcpEnv(sIndex, eIndex, 'key', e.target.value)} style={{ flex: 1 }} />
                            <input placeholder="VALUE" value={env.value} onChange={e => updateMcpEnv(sIndex, eIndex, 'value', e.target.value)} style={{ flex: 2 }} />
                            <button type="button" onClick={() => removeMcpEnv(sIndex, eIndex)} className="text-btn">×</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => addMcpEnv(sIndex)} className="text-btn-brand" style={{ width: 'fit-content' }}>+ 添加变量</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <ConfigRow label="URL" desc="远程 SSE 服务地址" value={server.url} onChange={v => updateMcpServer(sIndex, 'url', v)} placeholder="http://localhost:3001/sse" disabled={mcpSaving} />
                    <div className="config-item">
                      <div className="config-item-info">
                        <span className="config-item-label">请求头 (Headers)</span>
                        <span className="config-item-desc">配置 Authorization 或其他鉴权信息</span>
                      </div>
                      <div className="config-item-control">
                        {(server.headers || []).map((header, hIndex) => (
                          <div key={hIndex} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <input placeholder="Header-Name" value={header.key} onChange={e => updateMcpHeader(sIndex, hIndex, 'key', e.target.value)} style={{ flex: 1 }} />
                            <input placeholder="Value" value={header.value} onChange={e => updateMcpHeader(sIndex, hIndex, 'value', e.target.value)} style={{ flex: 2 }} />
                            <button type="button" onClick={() => removeMcpHeader(sIndex, hIndex)} className="text-btn">×</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => addMcpHeader(sIndex)} className="text-btn-brand" style={{ width: 'fit-content' }}>+ 添加 Header</button>
                      </div>
                    </div>
                  </>
                )}

                <div className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">超时设置 (ms)</span>
                    <span className="config-item-desc">配置启动与请求的超时时间（毫秒）</span>
                  </div>
                  <div className="config-item-control" style={{ flexDirection: 'row', gap: '1rem' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>启动超时</span>
                      <NumericInput value={server.startupTimeoutMs} onChange={value => updateMcpServer(sIndex, 'startupTimeoutMs', value)} placeholder="默认 10000" disabled={mcpSaving} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>请求超时</span>
                      <NumericInput value={server.requestTimeoutMs} onChange={value => updateMcpServer(sIndex, 'requestTimeoutMs', value)} placeholder="默认 60000" disabled={mcpSaving} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        <button type="button" onClick={addMcpServer} className="btn-add-section">+ 添加新的 MCP 服务器</button>

        <div className="config-footer">
          <span className="status-note">{mcpStatusText}</span>
          {mcpSaveMessage && <span className="status-note success">{mcpSaveMessage}</span>}
          {(mcpLocalError || mcpError) && <span className="status-note error">{mcpLocalError || mcpError}</span>}
          <button type="submit" className="btn-primary" disabled={mcpSaving}>{mcpSaving ? "正在应用..." : "应用 MCP 配置"}</button>
        </div>
      </form>

      <div className="config-divider" style={{ margin: '1.25rem 0' }} />

      <div className="module-title-wrap">
        <h2>全局 Hook 开关</h2>
        <p>这里只控制全局 6 个 Hook 事件是否启用，不影响插件级 Hook。</p>
      </div>

      <form onSubmit={handleHookSettingsSubmit}>
        <div className="config-section">
          <div className="config-section-header">
            <h3>事件级开关</h3>
          </div>
          <div className="config-section-body">
            {HOOK_EVENT_OPTIONS.map((item) => {
              const enabled = hookSettings?.events?.[item.key]?.enabled !== false;
              return (
                <div key={item.key} className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">{item.label}</span>
                    <span className="config-item-desc">{item.desc}</span>
                  </div>
                  <div className="config-item-control">
                    <button
                      type="button"
                      className={`pet-enable-toggle ${enabled ? "is-on" : ""}`}
                      onClick={() => updateHookEventEnabled(item.key, !enabled)}
                      disabled={hookSettingsLoading || hookSettingsSaving}
                    >
                      {enabled ? "已开启" : "已关闭"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="config-footer">
          {hookSettingsSaveMessage && <span className="status-note success">{hookSettingsSaveMessage}</span>}
          {(hookSettingsLocalError || hookSettingsError) && (
            <span className="status-note error">{hookSettingsLocalError || hookSettingsError}</span>
          )}
          <button type="submit" className="btn-primary" disabled={hookSettingsLoading || hookSettingsSaving}>
            {hookSettingsSaving ? "保存中..." : "应用 Hook 开关"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProfileSelectRow({
  label,
  desc,
  value,
  options,
  menuKey,
  openMenu,
  setOpenMenu,
  onChange,
  disabled
}) {
  const selected = options.find((option) => option.value === value);
  const isOpen = openMenu === menuKey;

  return (
    <div className="config-item">
      <div className="config-item-info">
        <span className="config-item-label">{label}</span>
        <span className="config-item-desc">{desc}</span>
      </div>
      <div className="config-item-control">
        <div className="select-container">
          <button
            type="button"
            className={`select-trigger ${isOpen ? "is-active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(isOpen ? "" : menuKey);
            }}
            disabled={disabled || options.length === 0}
          >
            <span>{selected?.label || "请选择模型配置"}</span>
          </button>
          {isOpen && (
            <div className="select-dropdown" onClick={(event) => event.stopPropagation()}>
              {options.map((option) => (
                <div
                  key={`${menuKey}_${option.value}`}
                  role="button"
                  tabIndex={0}
                  className={`select-option ${value === option.value ? "is-selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpenMenu("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onChange(option.value);
                      setOpenMenu("");
                    }
                  }}
                >
                  {option.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigRow({ label, desc, value, onChange, placeholder, isPassword, type = "text", disabled, isMulti, values, onChanges }) {
  return (
    <div className="config-item">
      <div className="config-item-info">
        <span className="config-item-label">{label}</span>
        <span className="config-item-desc">{desc}</span>
      </div>
      <div className="config-item-control">
        {isMulti ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {values.map((v, i) => (
              <input key={i} value={v} onChange={e => onChanges[i](e.target.value)} placeholder={i === 0 ? "Model" : i === 1 ? "URL" : "Key"} type={i === 2 ? "password" : "text"} disabled={disabled} />
            ))}
          </div>
        ) : type === "number" ? (
          <NumericInput value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
        ) : (
          <input type={isPassword ? "password" : type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
        )}
      </div>
    </div>
  );
}
