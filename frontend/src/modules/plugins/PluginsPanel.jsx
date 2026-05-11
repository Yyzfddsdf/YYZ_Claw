import { useEffect, useMemo, useState } from "react";

import { fetchPlugins, refreshPlugins } from "../../api/pluginsApi";
import "./plugins.css";

function normalizePluginsResponse(response) {
  return {
    rootDir: String(response?.rootDir ?? ""),
    plugins: Array.isArray(response?.plugins) ? response.plugins : [],
    errors: Array.isArray(response?.errors) ? response.errors : []
  };
}

function ComponentBadge({ active, label }) {
  return (
    <span className={`plugin-component-badge ${active ? "is-active" : ""}`}>
      {label}
    </span>
  );
}

function normalizeBrandColor(value) {
  const text = String(value ?? "").trim();
  if (
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^rgba?\([^)]+\)$/i.test(text) ||
    /^hsla?\([^)]+\)$/i.test(text)
  ) {
    return text;
  }
  return "";
}

function isDirectIconSource(value) {
  return /^(?:https?:|data:image\/|blob:|\/)/i.test(String(value ?? "").trim());
}

function buildPluginAssetUrl(plugin, assetPath) {
  const normalizedAssetPath = String(assetPath ?? "").trim();
  const pluginName = String(plugin?.name ?? "").trim();
  if (!normalizedAssetPath || !pluginName) {
    return "";
  }
  if (isDirectIconSource(normalizedAssetPath)) {
    return normalizedAssetPath;
  }

  const query = new URLSearchParams({
    filePath: normalizedAssetPath
  });
  return `/api/plugins/${encodeURIComponent(pluginName)}/assets?${query.toString()}`;
}

function getPluginInitial(plugin) {
  const label = String(plugin?.interface?.displayName || plugin?.displayName || plugin?.name || "?").trim();
  return label.slice(0, 1).toUpperCase() || "?";
}

function PluginIcon({ plugin }) {
  const iconSrc = buildPluginAssetUrl(
    plugin,
    plugin?.interface?.composerIcon || plugin?.interface?.logo
  );
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [iconSrc]);

  if (!iconSrc || imageFailed) {
    return <span className="plugin-icon is-fallback">{getPluginInitial(plugin)}</span>;
  }

  return (
    <span className="plugin-icon">
      <img
        src={iconSrc}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}

export function PluginsPanel({ chat, onNavigate }) {
  const [state, setState] = useState(() => normalizePluginsResponse(null));
  const [loading, setLoading] = useState(true);
  const [savingPluginName, setSavingPluginName] = useState("");
  const [error, setError] = useState("");
  const activeConversationPlugins = Array.isArray(chat?.activeConversationPlugins)
    ? chat.activeConversationPlugins
    : [];
  const activeConversationPluginSet = useMemo(
    () => new Set(activeConversationPlugins.map((item) => String(item ?? "").trim().toLowerCase())),
    [activeConversationPlugins]
  );

  async function loadPlugins() {
    setLoading(true);
    setError("");
    try {
      setState(normalizePluginsResponse(await fetchPlugins()));
    } catch (loadError) {
      setError(loadError?.message || "加载插件失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPlugins();
  }, []);

  const enabledCount = useMemo(
    () => state.plugins.filter((plugin) =>
      activeConversationPluginSet.has(String(plugin.name ?? "").trim().toLowerCase())
    ).length,
    [state.plugins, activeConversationPluginSet]
  );

  async function handleRefresh() {
    setLoading(true);
    setError("");
    try {
      await refreshPlugins();
      setState(normalizePluginsResponse(await fetchPlugins()));
    } catch (refreshError) {
      setError(refreshError?.message || "刷新插件失败");
    } finally {
      setLoading(false);
    }
  }

  async function togglePlugin(plugin) {
    const pluginName = String(plugin?.name ?? "").trim();
    if (!pluginName) {
      return;
    }

    setSavingPluginName(pluginName);
    setError("");
    try {
      const currentlyEnabled = activeConversationPluginSet.has(pluginName.toLowerCase());
      const nextPlugins = currentlyEnabled
        ? activeConversationPlugins.filter((item) => String(item ?? "").trim().toLowerCase() !== pluginName.toLowerCase())
        : [...activeConversationPlugins, pluginName];
      await chat?.setConversationPlugins?.(nextPlugins);
      await chat?.reloadSkillCatalog?.();
    } catch (saveError) {
      setError(saveError?.message || "更新插件失败");
    } finally {
      setSavingPluginName("");
    }
  }

  return (
    <div className="plugins-panel">
      <header className="plugins-panel-header">
        <div className="plugins-panel-header-left">
          <button
            type="button"
            className="back-button mode-pill"
            onClick={() => onNavigate("chat")}
          >
            ← 返回会话
          </button>
          <div>
            <h2>插件中心</h2>
            <p>{state.rootDir || "用户主目录 .yyz/plugins"}</p>
          </div>
        </div>
        <div className="plugins-panel-header-right">
          <span className="plugins-count">
            当前会话已启用: {enabledCount} / {state.plugins.length}
          </span>
          <button
            type="button"
            className="refresh-button mode-pill"
            onClick={handleRefresh}
            disabled={loading}
          >
            刷新插件
          </button>
        </div>
      </header>

      <main className="plugins-panel-content">
        {error && <div className="plugins-error">{error}</div>}

        {loading ? (
          <div className="empty-note">正在加载插件...</div>
        ) : state.plugins.length === 0 ? (
          <div className="empty-note">暂无插件。将插件目录放入用户主目录 .yyz/plugins 后刷新。</div>
        ) : (
          <div className="plugins-grid">
            {state.plugins.map((plugin) => {
              const components = plugin.components ?? {};
              const displayName = plugin.interface?.displayName || plugin.displayName || plugin.name;
              const description =
                plugin.interface?.shortDescription || plugin.description || "暂无描述";
              const authorName = plugin.author?.name || plugin.interface?.developerName || "";
              const brandColor = normalizeBrandColor(plugin.interface?.brandColor);
              const isEnabled = activeConversationPluginSet.has(String(plugin.name ?? "").trim().toLowerCase());
              const isSaving = savingPluginName === plugin.name;

              return (
                <article
                  key={plugin.name}
                  className={`plugin-card ${isEnabled ? "is-enabled" : ""}`}
                  style={brandColor ? { "--plugin-brand": brandColor } : undefined}
                >
                  <div className="plugin-card-top">
                    <div className="plugin-card-heading">
                      <PluginIcon plugin={plugin} />
                      <div>
                        <h3>{displayName}</h3>
                        <span className="plugin-card-name">
                          {plugin.name} · v{plugin.version}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`plugin-toggle ${isEnabled ? "is-on" : ""}`}
                      onClick={() => togglePlugin(plugin)}
                      disabled={isSaving || !chat?.activeConversationId}
                    >
                      {isEnabled ? "会话启用" : "会话关闭"}
                    </button>
                  </div>

                  <p className="plugin-card-description">{description}</p>

                  <div className="plugin-card-components">
                    <ComponentBadge active={components.skills} label={`skills ${plugin.skillCount || 0}`} />
                    <ComponentBadge active={components.commands} label={`commands ${plugin.commandCount || 0}`} />
                    <ComponentBadge active={components.rules} label={`rules ${plugin.ruleCount || 0}`} />
                    <ComponentBadge active={components.mcp} label="mcp" />
                    <ComponentBadge active={components.hooks} label="hooks" />
                  </div>

                  <div className="plugin-card-footer">
                    <span>{plugin.manifestKind}</span>
                    {authorName && <span>{authorName}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {state.errors.length > 0 && (
          <section className="plugins-load-errors">
            <h3>加载错误</h3>
            {state.errors.map((item) => (
              <div key={`${item.name}-${item.rootDir}`} className="plugins-load-error">
                <strong>{item.name}</strong>
                <span>{item.message}</span>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
