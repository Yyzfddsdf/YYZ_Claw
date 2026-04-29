import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRemoteControlConfig,
  fetchRemoteControlStatus,
  saveRemoteControlConfig
} from "../../api/remoteControlApi";
import { fetchHistories } from "../../api/chatApi";
import { notify } from "../../shared/feedback";
import "./remote-control.css";

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeConfig(config = {}) {
  return {
    activeProviderKey: normalizeProviderKey(config.activeProviderKey),
    targetConversationId: String(config.targetConversationId ?? "").trim()
  };
}

function normalizeProviderConfig(config = {}) {
  return config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
}

function normalizeProviders(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      key: normalizeProviderKey(item?.key),
      label: String(item?.label ?? item?.key ?? "").trim()
    }))
    .filter((item) => item.key);
}

function normalizeHistories(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      title: String(item?.title ?? "未命名会话").trim() || "未命名会话",
      preview: String(item?.preview ?? "").trim(),
      source: String(item?.source ?? "").trim().toLowerCase(),
      updatedAt: Number(item?.updatedAt ?? item?.createdAt ?? 0)
    }))
    .filter((item) => item.id && item.source !== "subagent");
}

function isEmptyProviderConfig(config) {
  return Object.keys(normalizeProviderConfig(config)).length === 0;
}

function formatProviderLabel(providerKey, providers) {
  const key = normalizeProviderKey(providerKey);
  if (!key) {
    return "未启用";
  }

  return providers.find((item) => item.key === key)?.label || key;
}

function formatTime(value) {
  const timestamp = Number(value ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "暂无";
  }

  return new Date(timestamp).toLocaleString();
}

function formatShortTime(value) {
  const timestamp = Number(value ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "无时间";
  }

  return new Date(timestamp).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function RemoteSelect({
  label,
  value,
  options,
  placeholder,
  disabled,
  emptyText,
  onChange
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const normalizedOptions = Array.isArray(options) ? options : [];
  const selectedOption =
    normalizedOptions.find((item) => String(item.value ?? "") === String(value ?? "")) ?? null;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!rootRef.current || rootRef.current.contains(event.target)) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function selectValue(nextValue) {
    onChange?.(nextValue);
    setOpen(false);
  }

  return (
    <div className="rc-smart-field" ref={rootRef}>
      <span className="rc-smart-label">{label}</span>
      <button
        type="button"
        className={`rc-smart-trigger ${open ? "is-open" : ""} ${selectedOption ? "has-value" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="rc-smart-trigger-copy">
          <strong>{selectedOption?.label || placeholder}</strong>
          <small>{selectedOption?.description || emptyText}</small>
        </span>
        {selectedOption?.badge ? <span className="rc-smart-badge">{selectedOption.badge}</span> : null}
        <svg className="rc-smart-caret" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="rc-smart-menu" role="listbox">
          {normalizedOptions.length === 0 ? (
            <div className="rc-smart-empty">{emptyText}</div>
          ) : (
            normalizedOptions.map((option) => {
              const optionValue = String(option.value ?? "");
              const selected = optionValue === String(value ?? "");
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  key={optionValue || "__empty__"}
                  className={`rc-smart-option ${selected ? "is-selected" : ""}`}
                  onClick={() => selectValue(optionValue)}
                >
                  <span className="rc-smart-option-main">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  {option.badge ? <span className="rc-smart-option-badge">{option.badge}</span> : null}
                  {selected ? <span className="rc-smart-check">已选</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProviderConfigFields({ providerConfig, disabled, onChange }) {
  const entries = Object.entries(normalizeProviderConfig(providerConfig));
  if (entries.length === 0) {
    return (
      <p className="rc-muted">
        当前 provider 没有额外配置项。飞书等 IM 的独有密钥仍在各自 provider 配置里保存。
      </p>
    );
  }

  return (
    <div className="rc-provider-fields">
      {entries.map(([key, value]) => (
        <label key={key} className="rc-field">
          <span>{key}</span>
          <input
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(event) => onChange(key, event.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

export function RemoteControlPanel() {
  const [config, setConfig] = useState(() => normalizeConfig());
  const [providerConfig, setProviderConfig] = useState(() => ({}));
  const [providers, setProviders] = useState([]);
  const [histories, setHistories] = useState([]);
  const [status, setStatus] = useState({
    running: false,
    queuedCount: 0,
    activeConversationId: "",
    lastRunError: "",
    lastRunAt: 0
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedHistory = useMemo(
    () => histories.find((item) => item.id === config.targetConversationId) ?? null,
    [histories, config.targetConversationId]
  );
  const providerOptions = useMemo(
    () => [
      {
        value: "",
        label: "未启用",
        description: "暂停接收远程 IM 消息",
        badge: "OFF"
      },
      ...providers.map((provider) => ({
        value: provider.key,
        label: provider.label || provider.key,
        description:
          provider.key === config.activeProviderKey
            ? "当前远程入口，会把消息投递到绑定会话"
            : "切换后保存配置才会生效",
        badge: provider.key.toUpperCase()
      }))
    ],
    [providers, config.activeProviderKey]
  );
  const historyOptions = useMemo(
    () => [
      {
        value: "",
        label: "未绑定",
        description: "远程消息暂时不会进入 Chat",
        badge: "空"
      },
      ...histories.map((history) => ({
        value: history.id,
        label: history.title,
        description: history.preview || "这个会话暂无预览内容",
        badge: formatShortTime(history.updatedAt)
      }))
    ],
    [histories]
  );

  async function refreshStatus() {
    const response = await fetchRemoteControlStatus();
    const nextStatus = response?.status && typeof response.status === "object" ? response.status : {};
    setStatus({
      running: Boolean(nextStatus.running),
      queuedCount: Number(nextStatus.queuedCount ?? 0),
      activeConversationId: String(nextStatus.activeConversationId ?? ""),
      lastRunError: String(nextStatus.lastRunError ?? ""),
      lastRunAt: Number(nextStatus.lastRunAt ?? 0)
    });
  }

  async function loadAll() {
    setError("");
    const [configResponse, historiesResponse] = await Promise.all([
      fetchRemoteControlConfig(),
      fetchHistories()
    ]);

    setConfig(normalizeConfig(configResponse?.config));
    setProviderConfig(normalizeProviderConfig(configResponse?.providerConfig));
    setProviders(normalizeProviders(configResponse?.providers));
    setHistories(normalizeHistories(historiesResponse?.histories));
    await refreshStatus();
  }

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      setLoading(true);
      try {
        await loadAll();
      } catch (loadError) {
        if (mounted) {
          setError(String(loadError?.message ?? "加载远程控制配置失败"));
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    const timer = setInterval(() => {
      refreshStatus().catch(() => {});
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  function updateProviderConfigField(key, value) {
    setProviderConfig((previous) => ({
      ...previous,
      [key]: value
    }));
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const payload = {
        activeProviderKey: config.activeProviderKey,
        targetConversationId: config.targetConversationId
      };
      if (config.activeProviderKey && !isEmptyProviderConfig(providerConfig)) {
        payload.providerConfig = providerConfig;
      }

      const response = await saveRemoteControlConfig(payload);
      setConfig(normalizeConfig(response?.config));
      setProviderConfig(normalizeProviderConfig(response?.providerConfig ?? providerConfig));
      setProviders(normalizeProviders(response?.providers ?? providers));
      await refreshStatus();
      notify({
        tone: "success",
        title: "远程接收已保存",
        message: "之后 IM 消息会作为普通 user 消息进入绑定会话。"
      });
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rc-module">
        <div className="module-title-wrap rc-title-wrap">
          <div>
            <h2>远程控制</h2>
            <p>正在加载远程通道配置...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rc-module">
      <div className="module-title-wrap rc-title-wrap">
        <div>
          <h2>远程控制</h2>
          <p>远程消息不再维护独立历史，而是投递到一个普通 chat 会话。</p>
        </div>
        <div className="rc-title-metrics">
          <span className={`rc-metric ${status.running ? "is-running" : ""}`}>
            {status.running ? "后台运行中" : "空闲"}
          </span>
          <span className="rc-metric">队列 {Number(status.queuedCount ?? 0)}</span>
          <span className="rc-metric">
            Provider：{formatProviderLabel(config.activeProviderKey, providers)}
          </span>
        </div>
      </div>

      {error ? <div className="rc-alert is-error">{error}</div> : null}

      <section className="rc-card rc-card-settings">
        <header>
          <h3>远程接收配置</h3>
          <p>选择一个会话作为 IM 消息接收方。消息会按普通 user 落库、自动压缩、后台运行。</p>
        </header>

        <form className="rc-settings-form" onSubmit={handleSave}>
          <div className="rc-settings-grid">
            <section className="rc-settings-column">
              <RemoteSelect
                label="Provider"
                value={config.activeProviderKey}
                options={providerOptions}
                placeholder="选择远程入口"
                emptyText="暂无可用 Provider"
                disabled={saving}
                onChange={(nextValue) =>
                  setConfig((previous) => ({
                    ...previous,
                    activeProviderKey: normalizeProviderKey(nextValue)
                  }))
                }
              />

              <RemoteSelect
                label="远程接收会话"
                value={config.targetConversationId}
                options={historyOptions}
                placeholder="选择一个 Chat 会话"
                emptyText="暂无可绑定会话"
                disabled={saving}
                onChange={(nextValue) =>
                  setConfig((previous) => ({
                    ...previous,
                    targetConversationId: nextValue
                  }))
                }
              />
            </section>

            <section className="rc-settings-column">
              <h4>Provider 独有配置</h4>
              <ProviderConfigFields
                providerConfig={providerConfig}
                disabled={saving}
                onChange={updateProviderConfigField}
              />
            </section>
          </div>

          <div className="rc-actions">
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "保存中..." : "保存远程配置"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                loadAll().catch((refreshError) => {
                  setError(String(refreshError?.message ?? "刷新失败"));
                });
              }}
            >
              刷新
            </button>
          </div>
        </form>
      </section>

      <section className="rc-card">
        <header>
          <h3>当前绑定</h3>
          <p>这里只显示路由状态；具体消息请回到会话工作台查看。</p>
        </header>

        <div className="rc-target-summary">
          <strong>{selectedHistory?.title || "未绑定会话"}</strong>
          <span>{selectedHistory?.preview || "远程消息暂时没有接收位置"}</span>
          <small>最近运行：{formatTime(status.lastRunAt)}</small>
          {status.activeConversationId ? (
            <small>当前运行会话：{status.activeConversationId}</small>
          ) : null}
          {status.lastRunError ? <small className="rc-error-text">{status.lastRunError}</small> : null}
        </div>
      </section>
    </div>
  );
}
