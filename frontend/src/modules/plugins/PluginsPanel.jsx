import { useEffect, useState } from "react";

import {
  addPluginMarketplace,
  fetchMarketplacePlugins,
  fetchPluginMarketplaces,
  fetchPlugins,
  installMarketplacePlugin,
  refreshPlugins
} from "../../api/pluginsApi";
import "./plugins.css";

function normalizePluginsResponse(response) {
  return {
    rootDir: String(response?.rootDir ?? ""),
    plugins: Array.isArray(response?.plugins) ? response.plugins : [],
    errors: Array.isArray(response?.errors) ? response.errors : []
  };
}

function normalizeMarketplaceResponse(response) {
  return {
    marketplaces: Array.isArray(response?.marketplaces) ? response.marketplaces : [],
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

function getMarketplaceKey(marketplace) {
  return String(marketplace?.id || marketplace?.name || marketplace?.source || "unknown").trim();
}

function getMarketplaceLabel(marketplace) {
  return String(marketplace?.displayName || marketplace?.name || marketplace?.id || "未知市场").trim();
}

function pluginMatchesSearch(plugin, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return [
    plugin?.name,
    plugin?.displayName,
    plugin?.description,
    plugin?.version,
    plugin?.marketplace?.displayName,
    plugin?.marketplace?.name
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .some((value) => value.includes(normalizedQuery));
}

export function PluginsPanel({ chat, onNavigate }) {
  const [state, setState] = useState(() => normalizePluginsResponse(null));
  const [loading, setLoading] = useState(true);
  const [marketLoading, setMarketLoading] = useState(true);
  const [installingPluginName, setInstallingPluginName] = useState("");
  const [error, setError] = useState("");
  const [marketplaceState, setMarketplaceState] = useState(() => normalizeMarketplaceResponse(null));
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  const [expandedMarketplaces, setExpandedMarketplaces] = useState(() => new Set());

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

  async function loadMarketplace() {
    setMarketLoading(true);
    try {
      const [marketplacesResponse, pluginsResponse] = await Promise.all([
        fetchPluginMarketplaces(),
        fetchMarketplacePlugins()
      ]);
      setMarketplaceState({
        marketplaces: Array.isArray(marketplacesResponse?.marketplaces)
          ? marketplacesResponse.marketplaces
          : [],
        plugins: Array.isArray(pluginsResponse?.plugins) ? pluginsResponse.plugins : [],
        errors: Array.isArray(pluginsResponse?.errors) ? pluginsResponse.errors : []
      });
    } catch (loadError) {
      setError(loadError?.message || "加载插件市场失败");
    } finally {
      setMarketLoading(false);
    }
  }

  useEffect(() => {
    loadPlugins();
    loadMarketplace();
  }, []);

  async function handleRefresh() {
    setLoading(true);
    setError("");
    try {
      await refreshPlugins();
      setState(normalizePluginsResponse(await fetchPlugins()));
      await loadMarketplace();
    } catch (refreshError) {
      setError(refreshError?.message || "刷新插件失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddMarketplace(event) {
    event.preventDefault();
    const source = marketplaceSource.trim();
    if (!source) {
      return;
    }
    setError("");
    try {
      await addPluginMarketplace({ source });
      setMarketplaceSource("");
      await loadMarketplace();
    } catch (addError) {
      setError(addError?.message || "添加市场失败");
    }
  }

  async function handleInstallMarketplacePlugin(plugin) {
    const pluginName = String(plugin?.name ?? "").trim();
    if (!pluginName) {
      return;
    }
    setInstallingPluginName(pluginName);
    setError("");
    try {
      await installMarketplacePlugin(plugin);
      setState(normalizePluginsResponse(await fetchPlugins()));
      await chat?.refreshPluginCatalog?.();
    } catch (installError) {
      setError(installError?.message || "安装插件失败");
    } finally {
      setInstallingPluginName("");
    }
  }

  function toggleMarketplaceCollapse(marketplaceKey) {
    setExpandedMarketplaces((previous) => {
      const next = new Set(previous);
      if (next.has(marketplaceKey)) {
        next.delete(marketplaceKey);
      } else {
        next.add(marketplaceKey);
      }
      return next;
    });
  }

  const installedPluginNameSet = new Set(
    state.plugins.map((item) => String(item?.name ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const marketplaceGroups = marketplaceState.marketplaces.map((marketplace) => {
    const marketplaceKey = getMarketplaceKey(marketplace);
    const plugins = marketplaceState.plugins.filter(
      (plugin) => getMarketplaceKey(plugin?.marketplace) === marketplaceKey
    );
    const filteredPlugins = plugins.filter((plugin) => pluginMatchesSearch(plugin, marketplaceSearch));
    return {
      marketplace,
      marketplaceKey,
      plugins,
      filteredPlugins
    };
  });
  const visibleMarketplaceGroups = marketplaceGroups.filter((group) =>
    marketplaceSearch.trim() ? group.filteredPlugins.length > 0 : true
  );

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
            已安装插件: {state.plugins.length}
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

        <section className="marketplace-section">
          <div className="marketplace-section-header">
            <div>
              <h3>插件市场</h3>
              <p>市场是插件目录索引，安装后插件才会进入本地插件中心。</p>
            </div>
            <span>{marketplaceState.marketplaces.length} 个市场</span>
          </div>

          <form className="marketplace-add-form" onSubmit={handleAddMarketplace}>
            <input
              value={marketplaceSource}
              onChange={(event) => setMarketplaceSource(event.target.value)}
              placeholder="GitHub 市场，如 anthropics/claude-plugins-official，或本地 marketplace 根目录"
            />
            <button type="submit" className="mode-pill" disabled={!marketplaceSource.trim()}>
              添加市场
            </button>
          </form>

          <div className="marketplace-toolbar">
            <input
              value={marketplaceSearch}
              onChange={(event) => setMarketplaceSearch(event.target.value)}
              placeholder="搜索插件名称、描述或市场"
            />
            <span>
              {visibleMarketplaceGroups.reduce((sum, group) => sum + group.filteredPlugins.length, 0)}
              {" / "}
              {marketplaceState.plugins.length}
            </span>
          </div>

          {marketLoading ? (
            <div className="empty-note">正在加载市场...</div>
          ) : marketplaceState.plugins.length === 0 ? (
            <div className="empty-note">暂无市场插件。添加 marketplace 后刷新。</div>
          ) : visibleMarketplaceGroups.length === 0 ? (
            <div className="empty-note">没有匹配的插件。</div>
          ) : (
            <div className="marketplace-group-list">
              {visibleMarketplaceGroups.map(({ marketplace, marketplaceKey, plugins, filteredPlugins }) => {
                const expanded = marketplaceSearch.trim() || expandedMarketplaces.has(marketplaceKey);
                return (
                  <section key={marketplaceKey} className="marketplace-group">
                    <button
                      type="button"
                      className="marketplace-group-header"
                      onClick={() => toggleMarketplaceCollapse(marketplaceKey)}
                      aria-expanded={expanded}
                    >
                      <div>
                        <strong>{getMarketplaceLabel(marketplace)}</strong>
                        <span>{marketplace.source}</span>
                      </div>
                      <em>
                        {filteredPlugins.length} / {plugins.length}
                        <span>{expanded ? "收起" : "展开"}</span>
                      </em>
                    </button>
                    {expanded && (
                      <div className="marketplace-plugin-list">
                        {filteredPlugins.map((plugin) => {
                          const pluginName = String(plugin?.name ?? "").trim();
                          const installed = installedPluginNameSet.has(pluginName.toLowerCase());
                          const canInstall = Boolean(plugin?.path || plugin?.localPath || plugin?.source);
                          const installing = installingPluginName === pluginName;
                          return (
                            <article key={`${plugin?.marketplace?.id}-${plugin.entry}`} className="marketplace-plugin-card">
                              <div>
                                <h4>{plugin.displayName || pluginName}</h4>
                                <p>{plugin.description || "暂无描述"}</p>
                                <span>
                                  {pluginName} {plugin.version ? `· v${plugin.version}` : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="mode-pill"
                                disabled={installed || installing || !canInstall}
                                onClick={() => handleInstallMarketplacePlugin(plugin)}
                              >
                                {installed ? "已安装" : installing ? "安装中" : canInstall ? "安装" : "暂不支持"}
                              </button>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}

          {marketplaceState.errors.length > 0 && (
            <div className="plugins-load-errors">
              {marketplaceState.errors.map((item) => (
                <div key={`${item.marketplaceId}-${item.source}`} className="plugins-load-error">
                  <strong>{item.marketplaceName || item.marketplaceId}</strong>
                  <span>{item.message}</span>
                </div>
              ))}
            </div>
          )}
        </section>

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
              return (
                <article
                  key={plugin.name}
                  className="plugin-card"
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
