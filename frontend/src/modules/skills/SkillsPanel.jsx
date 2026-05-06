import React, { useEffect, useMemo, useRef, useState } from "react";

import { fetchSkillByName } from "../../api/chatApi";
import { fetchPlugins, refreshPlugins } from "../../api/pluginsApi";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import "./skills.css";

function toSkillIdentifier(skill) {
  return String(skill?.skillKey || skill?.relativePath || skill?.name || "").trim();
}

function normalizeFilePath(filePath) {
  return String(filePath ?? "").trim() || "SKILL.md";
}

function formatSkillContentForDisplay(content) {
  const source = String(content ?? "").replace(/\r\n/g, "\n");
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return source;
  }

  const frontmatter = String(match[1] ?? "").trimEnd().replace(/\n/g, "  \n");
  const body = source.slice(String(match[0] ?? "").length);
  return [`---`, frontmatter, `---`, body].join("\n");
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
  const text = String(value ?? "").trim();
  return /^(?:https?:|data:image\/|blob:|\/)/i.test(text);
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

function PluginIcon({ plugin, size = "small", preferLogo = false }) {
  const iconSrc = buildPluginAssetUrl(
    plugin,
    preferLogo
      ? plugin?.interface?.logo || plugin?.interface?.composerIcon
      : plugin?.interface?.composerIcon || plugin?.interface?.logo
  );
  const className = `plugin-inline-icon plugin-inline-icon-${size}`;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [iconSrc]);

  if (!iconSrc || imageFailed) {
    return <span className={`${className} is-fallback`}>{getPluginInitial(plugin)}</span>;
  }

  return (
    <span className={className}>
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

function buildSkillAssetUrl(skill, iconPath, workspacePath) {
  const normalizedIconPath = String(iconPath ?? "").trim();
  if (!normalizedIconPath) {
    return "";
  }

  if (isDirectIconSource(normalizedIconPath)) {
    return normalizedIconPath;
  }

  const identifier = toSkillIdentifier(skill);
  if (!identifier) {
    return "";
  }

  const query = new URLSearchParams({
    filePath: normalizedIconPath
  });
  const normalizedWorkspacePath = String(workspacePath ?? "").trim();
  if (normalizedWorkspacePath) {
    query.set("workspacePath", normalizedWorkspacePath);
  }

  return `/api/skills/${encodeURIComponent(identifier)}/assets?${query.toString()}`;
}

function resolveSkillIconSrc(skill, size, workspacePath) {
  const preferredPath =
    size === "large"
      ? String(skill?.iconLarge ?? "").trim() || String(skill?.iconSmall ?? "").trim()
      : String(skill?.iconSmall ?? "").trim() || String(skill?.iconLarge ?? "").trim();

  return buildSkillAssetUrl(skill, preferredPath, workspacePath);
}

function getSkillInitial(skill) {
  const label = String(skill?.displayName || skill?.name || "?").trim();
  return label.slice(0, 1).toUpperCase() || "?";
}

function SkillIcon({ skill, size = "small", workspacePath = "" }) {
  const iconSrc = resolveSkillIconSrc(skill, size, workspacePath);
  const className = `skill-icon skill-icon-${size}`;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [iconSrc]);

  if (!iconSrc || imageFailed) {
    return <span className={`${className} is-fallback`}>{getSkillInitial(skill)}</span>;
  }

  return (
    <span className={className}>
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

export function SkillsPanel({ chat, onNavigate }) {
  const [activeTab, setActiveTab] = useState("skills");
  const [activeSkillKey, setActiveSkillKey] = useState("");
  const [skillDetailCache, setSkillDetailCache] = useState({});
  const [skillDetail, setSkillDetail] = useState(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState("");
  const [pluginsState, setPluginsState] = useState({ rootDir: "", plugins: [], errors: [] });
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState("");
  const [activePluginName, setActivePluginName] = useState("");
  const requestIdRef = useRef(0);

  const selectedSkillKeys = useMemo(() => {
    if (!Array.isArray(chat?.activeConversationSkills)) {
      return [];
    }

    return chat.activeConversationSkills.map((key) => String(key ?? "").trim()).filter(Boolean);
  }, [chat?.activeConversationSkills]);

  const catalogList = Array.isArray(chat?.skillCatalog)
    ? chat.skillCatalog.filter((skill) => String(skill?.scope ?? "").trim() !== "plugin")
    : [];
  const pluginList = Array.isArray(pluginsState.plugins) ? pluginsState.plugins : [];
  const activeConversationPlugins = Array.isArray(chat?.activeConversationPlugins)
    ? chat.activeConversationPlugins
    : [];
  const activeConversationPluginSet = useMemo(
    () => new Set(activeConversationPlugins.map((item) => String(item ?? "").trim().toLowerCase())),
    [activeConversationPlugins]
  );

  const skillByIdentifier = useMemo(() => {
    const map = new Map();
    catalogList.forEach((skill) => {
      const identifier = toSkillIdentifier(skill);
      if (identifier) {
        map.set(identifier, skill);
      }
    });
    return map;
  }, [catalogList]);

  const projectSkills = catalogList.filter((skill) => skill.scope === "project" && !skill.isSystem);
  const globalSkills = catalogList.filter((skill) => skill.scope === "global" && !skill.isSystem);
  const systemSkills = catalogList.filter((skill) => skill.isSystem);
  const activePlugin = activePluginName
    ? pluginList.find((plugin) => plugin.name === activePluginName) ?? null
    : pluginList[0] ?? null;
  const activePluginSkills = Array.isArray(activePlugin?.skills) ? activePlugin.skills : [];
  const pluginSkillByIdentifier = useMemo(() => {
    const map = new Map();
    pluginList.forEach((plugin) => {
      (Array.isArray(plugin?.skills) ? plugin.skills : []).forEach((skill) => {
        const identifier = toSkillIdentifier(skill);
        if (identifier) {
          map.set(identifier, skill);
        }
      });
    });
    return map;
  }, [pluginList]);
  const enabledPluginCount = pluginList.filter((plugin) =>
    activeConversationPluginSet.has(String(plugin.name ?? "").trim().toLowerCase())
  ).length;

  async function loadPlugins() {
    setPluginsLoading(true);
    setPluginsError("");
    try {
      const response = await fetchPlugins();
      const nextPlugins = Array.isArray(response?.plugins) ? response.plugins : [];
      setPluginsState({
        rootDir: String(response?.rootDir ?? ""),
        plugins: nextPlugins,
        errors: Array.isArray(response?.errors) ? response.errors : []
      });
      if (!activePluginName && nextPlugins.length > 0) {
        setActivePluginName(String(nextPlugins[0]?.name ?? ""));
      }
    } catch (error) {
      setPluginsError(error?.message || "加载插件失败");
    } finally {
      setPluginsLoading(false);
    }
  }

  useEffect(() => {
    loadPlugins();
  }, []);

  useEffect(() => {
    if (
      activeSkillKey &&
      !skillByIdentifier.has(activeSkillKey) &&
      !pluginSkillByIdentifier.has(activeSkillKey)
    ) {
      setActiveSkillKey("");
      setSkillDetail(null);
      setSkillDetailError("");
      setSkillDetailLoading(false);
    }
  }, [activeSkillKey, skillByIdentifier, pluginSkillByIdentifier]);

  function toggleSkill(identifier) {
    if (!chat?.activeConversationId) {
      return;
    }

    const normalizedIdentifier = String(identifier ?? "").trim();
    if (!normalizedIdentifier) {
      return;
    }

    const current = Array.isArray(chat.activeConversationSkills) ? chat.activeConversationSkills : [];
    const next = current.includes(normalizedIdentifier)
      ? current.filter((item) => item !== normalizedIdentifier)
      : [...current, normalizedIdentifier];

    chat.setConversationSkills(next);
  }

  async function handleRefreshPlugins() {
    setPluginsLoading(true);
    setPluginsError("");
    try {
      await refreshPlugins();
      await loadPlugins();
    } catch (error) {
      setPluginsError(error?.message || "刷新插件失败");
      setPluginsLoading(false);
    }
  }

  function togglePlugin(plugin) {
    const pluginName = String(plugin?.name ?? "").trim();
    if (!pluginName || !chat?.activeConversationId) {
      return;
    }

    const currentlyEnabled = activeConversationPluginSet.has(pluginName.toLowerCase());
    const nextPlugins = currentlyEnabled
      ? activeConversationPlugins.filter((item) => String(item ?? "").trim().toLowerCase() !== pluginName.toLowerCase())
      : [...activeConversationPlugins, pluginName];

    chat.setConversationPlugins(nextPlugins);
  }

  async function loadSkillDetail(identifier, filePath = "SKILL.md", options = {}) {
    const normalizedIdentifier = String(identifier ?? "").trim();
    const normalizedFilePath = normalizeFilePath(filePath);
    if (!normalizedIdentifier) {
      return;
    }

    const cacheKey = `${normalizedIdentifier}::${normalizedFilePath}`;
    const cached = skillDetailCache[cacheKey];
    if (cached) {
      setSkillDetail(cached);
      setSkillDetailError("");
      setSkillDetailLoading(false);
      setActiveSkillKey(normalizedIdentifier);
      return;
    }

    const requestId = ++requestIdRef.current;
    setActiveSkillKey(normalizedIdentifier);
    setSkillDetailLoading(true);
    setSkillDetailError("");

    try {
      const response = await fetchSkillByName(normalizedIdentifier, {
        workspacePath: chat?.activeConversationWorkplace ?? "",
        filePath: normalizedFilePath,
        ...options
      });

      const nextDetail = {
        identifier: normalizedIdentifier,
        filePath: String(response?.filePath ?? normalizedFilePath),
        skill: response?.skill ?? null,
        content: String(response?.content ?? "")
      };

      if (requestId !== requestIdRef.current) {
        return;
      }

      setSkillDetail(nextDetail);
      setSkillDetailCache((previous) => ({
        ...previous,
        [cacheKey]: nextDetail
      }));
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setSkillDetail(null);
      setSkillDetailError(error?.message || "加载技能详情失败");
    } finally {
      if (requestId === requestIdRef.current) {
        setSkillDetailLoading(false);
      }
    }
  }

  function openSkillDetail(skill) {
    const identifier = toSkillIdentifier(skill);
    if (!identifier) {
      return;
    }

    if (activeSkillKey === identifier) {
      return;
    }

    loadSkillDetail(identifier, "SKILL.md");
  }

  function renderSkillCard(skill, fallbackScopeLabel) {
    const identifier = toSkillIdentifier(skill);
    const isSelected = selectedSkillKeys.includes(identifier);
    const isActive = activeSkillKey === identifier;
    const brandColor = normalizeBrandColor(skill?.brandColor);

    return (
      <article
        key={identifier}
        className={`skill-card ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${skill.isSystem ? "is-system" : ""}`}
        style={brandColor ? { "--skill-brand": brandColor } : undefined}
        onClick={() => openSkillDetail(skill)}
      >
        <div className="skill-card-accent" />
        <div className="skill-card-top">
          <div className="skill-card-title-row">
            <SkillIcon
              skill={skill}
              size="small"
              workspacePath={chat?.activeConversationWorkplace ?? ""}
            />
            <h3 className="skill-card-title">{skill.displayName || skill.name}</h3>
          </div>
          <input
            type="checkbox"
            className="skill-card-checkbox"
            checked={isSelected}
            onChange={(event) => {
              event.stopPropagation();
              toggleSkill(identifier);
            }}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
        <div className="skill-card-badges">
          <span className={`skill-badge ${skill.isSystem ? "system" : skill.scope}`}>
            {skill.isSystem ? "系统" : fallbackScopeLabel}
          </span>
          <span className="skill-badge is-meta">点开看全文</span>
        </div>
        <div className="skill-card-body">
          <p className="skill-card-desc">
            {skill.shortDescription || skill.description || "暂无描述"}
          </p>
        </div>
        {skill.relativePath && !skill.isSystem && (
          <div className="skill-card-footer">
            <span className="skill-path" title={skill.relativePath}>
              {skill.relativePath}
            </span>
          </div>
        )}
      </article>
    );
  }

  function renderPluginSkillCard(skill) {
    const identifier = toSkillIdentifier(skill);
    const brandColor = normalizeBrandColor(skill?.brandColor || activePlugin?.interface?.brandColor);
    const isActive = activeSkillKey === identifier;

    return (
      <article
        key={identifier}
        className={`skill-card plugin-skill-card ${isActive ? "is-active" : ""}`}
        style={brandColor ? { "--skill-brand": brandColor } : undefined}
        onClick={() => openSkillDetail(skill)}
      >
        <div className="skill-card-accent" />
        <div className="skill-card-top">
          <div className="skill-card-title-row">
            <SkillIcon
              skill={skill}
              size="small"
              workspacePath={chat?.activeConversationWorkplace ?? ""}
            />
            <h3 className="skill-card-title">{skill.displayName || skill.name}</h3>
          </div>
          <span className="skill-card-plugin-lock">随插件启用</span>
        </div>
        <div className="skill-card-badges">
          <span className="skill-badge plugin">插件技能</span>
          <span className="skill-badge is-meta">点开看全文</span>
        </div>
        <div className="skill-card-body">
          <p className="skill-card-desc">
            {skill.shortDescription || skill.description || "暂无描述"}
          </p>
        </div>
        {skill.relativePath && (
          <div className="skill-card-footer">
            <span className="skill-path" title={identifier}>
              {identifier}
            </span>
          </div>
        )}
      </article>
    );
  }

  const activeCatalogSkill = activeSkillKey
    ? skillByIdentifier.get(activeSkillKey) ?? pluginSkillByIdentifier.get(activeSkillKey)
    : null;
  const enabledCount = selectedSkillKeys.length;
  const detailSkill = skillDetail?.skill || activeCatalogSkill || null;
  const detailScope = detailSkill?.scope || activeCatalogSkill?.scope || "";
  const detailBrandColor = normalizeBrandColor(detailSkill?.brandColor);

  return (
    <div className="skills-panel">
      <header className="skills-panel-header">
        <div className="skills-panel-header-left">
          <button
            type="button"
            className="back-button mode-pill"
            onClick={() => onNavigate("chat")}
          >
            ← 返回会话
          </button>
          <h2>技能库 (Skills)</h2>
        </div>
        <div className="skills-panel-header-right">
          <span className="skills-count">
            技能: {enabledCount} / {projectSkills.length + globalSkills.length + systemSkills.length}
          </span>
          <button
            type="button"
            className="refresh-button mode-pill"
            onClick={() => {
              chat?.reloadSkillCatalog?.();
              handleRefreshPlugins();
            }}
            disabled={!chat?.skillCatalogLoaded || pluginsLoading}
          >
            刷新库
          </button>
        </div>
      </header>

      <div className="skills-panel-content">
        <div className="skills-mode-tabs" role="tablist" aria-label="skills and plugins">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            className={`skills-mode-tab ${activeTab === "skills" ? "is-active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "plugins"}
            className={`skills-mode-tab ${activeTab === "plugins" ? "is-active" : ""}`}
            onClick={() => setActiveTab("plugins")}
          >
            Plugins
            <span>{enabledPluginCount} / {pluginList.length}</span>
          </button>
        </div>

        {!chat?.historyLoaded || !chat?.skillCatalogLoaded ? (
          <div className="empty-note">正在加载技能库...</div>
        ) : activeTab === "skills" && projectSkills.length + globalSkills.length + systemSkills.length === 0 ? (
          <div className="empty-note">暂无可用技能。</div>
        ) : activeTab === "plugins" ? (
          <div className="plugins-inline-layout">
            <aside className="plugins-inline-list">
              <div className="plugins-inline-head">
                <div>
                  <h3>Plugins</h3>
                  <p>{pluginsState.rootDir || "用户主目录 .yyz/plugins"}</p>
                </div>
                <button
                  type="button"
                  className="refresh-button mode-pill"
                  onClick={handleRefreshPlugins}
                  disabled={pluginsLoading}
                >
                  刷新
                </button>
              </div>
              {pluginsError && <div className="skills-detail-error">{pluginsError}</div>}
              {pluginsLoading ? (
                <div className="empty-note">正在加载插件...</div>
              ) : pluginList.length === 0 ? (
                <div className="empty-note">暂无插件。</div>
              ) : (
                <div className="plugins-inline-cards">
                  {pluginList.map((plugin) => {
                    const pluginName = String(plugin.name ?? "").trim();
                    const displayName = plugin.interface?.displayName || plugin.displayName || pluginName;
                    const description = plugin.interface?.shortDescription || plugin.description || "暂无描述";
                    const brandColor = normalizeBrandColor(plugin.interface?.brandColor);
                    const isEnabled = activeConversationPluginSet.has(pluginName.toLowerCase());
                    const isActive = activePlugin?.name === pluginName;

                    return (
                      <article
                        key={pluginName}
                        className={`plugin-inline-card ${isEnabled ? "is-enabled" : ""} ${isActive ? "is-active" : ""}`}
                        style={brandColor ? { "--plugin-brand": brandColor } : undefined}
                        onClick={() => setActivePluginName(pluginName)}
                      >
                        <PluginIcon plugin={plugin} size="small" />
                        <div className="plugin-inline-card-copy">
                          <h4>{displayName}</h4>
                          <p>{description}</p>
                        </div>
                        <button
                          type="button"
                          className={`plugin-inline-toggle ${isEnabled ? "is-on" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            togglePlugin(plugin);
                          }}
                          disabled={!chat?.activeConversationId}
                        >
                          {isEnabled ? "启用" : "关闭"}
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </aside>

            <section className="plugin-detail-pane">
              {activePlugin ? (
                <>
                  <header
                    className="plugin-detail-head"
                    style={normalizeBrandColor(activePlugin.interface?.brandColor) ? { "--plugin-brand": normalizeBrandColor(activePlugin.interface?.brandColor) } : undefined}
                  >
                    <PluginIcon plugin={activePlugin} size="large" preferLogo />
                    <div>
                      <h3>{activePlugin.interface?.displayName || activePlugin.displayName || activePlugin.name}</h3>
                      <p>{activePlugin.interface?.longDescription || activePlugin.description || "暂无描述"}</p>
                      <div className="plugin-detail-meta-line">
                        <span>{activePlugin.name} · v{activePlugin.version}</span>
                        {(activePlugin.author?.name || activePlugin.interface?.developerName) && (
                          <span>{activePlugin.author?.name || activePlugin.interface?.developerName}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`plugin-detail-toggle ${activeConversationPluginSet.has(String(activePlugin.name ?? "").toLowerCase()) ? "is-on" : ""}`}
                      onClick={() => togglePlugin(activePlugin)}
                      disabled={!chat?.activeConversationId}
                    >
                      {activeConversationPluginSet.has(String(activePlugin.name ?? "").toLowerCase()) ? "当前会话启用" : "当前会话关闭"}
                    </button>
                  </header>

                  <div className="plugin-detail-components">
                    <span>skills {activePlugin.skillCount || activePluginSkills.length}</span>
                    <span>rules {activePlugin.ruleCount || 0}</span>
                    {activePlugin.components?.mcp && <span>mcp</span>}
                    {activePlugin.components?.hooks && <span>hooks</span>}
                  </div>

                  <section className="skills-section plugin-detail-skills">
                    <header className="skills-section-header">
                      <h3>插件技能 <span>Plugin Skills</span></h3>
                      <span className="skills-section-count">{activePluginSkills.length}</span>
                    </header>
                    {activePluginSkills.length === 0 ? (
                      <div className="empty-note">这个插件没有提供 skills。</div>
                    ) : (
                      <div className="skills-grid">
                        {activePluginSkills.map((skill) => renderPluginSkillCard(skill))}
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <div className="empty-note">选择一个插件查看详情。</div>
              )}
            </section>
          </div>
        ) : (
          <div className="skills-panel-layout">
            <div className="skills-catalog-pane">
              <div className="skills-groups-wrapper">
                {projectSkills.length > 0 && (
                  <section className="skills-section">
                    <header className="skills-section-header">
                      <h3>项目技能 <span>Project Skills</span></h3>
                      <span className="skills-section-count">{projectSkills.length}</span>
                    </header>
                    <div className="skills-grid">
                      {projectSkills.map((skill) => renderSkillCard(skill, "项目"))}
                    </div>
                  </section>
                )}

                {globalSkills.length > 0 && (
                  <section className="skills-section">
                    <header className="skills-section-header">
                      <h3>全局个人技能 <span>Global Skills</span></h3>
                      <span className="skills-section-count">{globalSkills.length}</span>
                    </header>
                    <div className="skills-grid">
                      {globalSkills.map((skill) => renderSkillCard(skill, "全局"))}
                    </div>
                  </section>
                )}

                {systemSkills.length > 0 && (
                  <section className="skills-section">
                    <header className="skills-section-header">
                      <h3>全局系统技能 <span>System Skills</span></h3>
                      <span className="skills-section-count">{systemSkills.length}</span>
                    </header>
                    <div className="skills-grid">
                      {systemSkills.map((skill) => renderSkillCard(skill, "系统"))}
                    </div>
                  </section>
                )}

              </div>
            </div>

            {false && activeSkillKey && (
              <div
                className="skills-modal-overlay"
                onClick={() => {
                  setActiveSkillKey("");
                  setSkillDetail(null);
                  setSkillDetailError("");
                  setSkillDetailLoading(false);
                }}
              >
                <aside
                  className="skills-detail-modal"
                  style={detailBrandColor ? { "--skill-brand": detailBrandColor } : undefined}
                  onClick={(event) => event.stopPropagation()}
                >
                  <header className="skills-detail-head">
                    <SkillIcon
                      skill={detailSkill}
                      size="large"
                      workspacePath={chat?.activeConversationWorkplace ?? ""}
                    />
                    <div className="skills-detail-title-wrap">
                      <h3>{detailSkill?.displayName || detailSkill?.name || activeSkillKey}</h3>
                      <div className="skills-detail-tags">
                        <span className={`skill-badge ${detailScope || "global"}`}>
                          {detailSkill?.isSystem ? "系统" : (detailScope === "project" ? "项目" : "全局")}
                        </span>
                        {detailSkill?.version && (
                          <span className="skill-badge is-meta">v{detailSkill.version}</span>
                        )}
                        {detailSkill?.author && (
                          <span className="skill-badge is-meta">{detailSkill.author}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="skills-detail-close"
                      onClick={() => {
                        setActiveSkillKey("");
                        setSkillDetail(null);
                        setSkillDetailError("");
                        setSkillDetailLoading(false);
                      }}
                    >
                      关闭
                    </button>
                  </header>

                  <div className="skills-detail-content-scroll">
                    <div className="skills-detail-meta">
                      <div>
                        <span>路径</span>
                        <strong>{detailSkill?.relativePath || activeSkillKey}</strong>
                      </div>
                      {detailSkill?.category && (
                        <div>
                          <span>分类</span>
                          <strong>{detailSkill.category}</strong>
                        </div>
                      )}
                      {detailSkill?.license && (
                        <div>
                          <span>许可证</span>
                          <strong>{detailSkill.license}</strong>
                        </div>
                      )}
                    </div>

                    {detailSkill?.defaultPrompt && (
                      <div className="skills-detail-prompt">
                        <span>default prompt</span>
                        <p>{detailSkill.defaultPrompt}</p>
                      </div>
                    )}

                    {skillDetailLoading && <div className="skills-detail-loading">正在加载全文...</div>}
                    {skillDetailError && <div className="skills-detail-error">{skillDetailError}</div>}

                    {skillDetail && (
                      <div className="skills-detail-body">
                        <div className="skills-detail-filepath">
                          <span>当前路径</span>
                          <strong>{skillDetail.filePath}</strong>
                        </div>

                        <div className="skills-detail-content">
                          <MarkdownMessage
                            content={formatSkillContentForDisplay(skillDetail.content || "")}
                            className="skills-detail-markdown"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </aside>
              </div>
            )}
          </div>
        )}
        {activeSkillKey && (
          <div
            className="skills-modal-overlay"
            onClick={() => {
              setActiveSkillKey("");
              setSkillDetail(null);
              setSkillDetailError("");
              setSkillDetailLoading(false);
            }}
          >
            <aside
              className="skills-detail-modal"
              style={detailBrandColor ? { "--skill-brand": detailBrandColor } : undefined}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="skills-detail-head">
                <SkillIcon
                  skill={detailSkill}
                  size="large"
                  workspacePath={chat?.activeConversationWorkplace ?? ""}
                />
                <div className="skills-detail-title-wrap">
                  <h3>{detailSkill?.displayName || detailSkill?.name || activeSkillKey}</h3>
                  <div className="skills-detail-tags">
                    <span className={`skill-badge ${detailScope || "global"}`}>
                      {detailSkill?.isSystem ? "系统" : (detailScope === "project" ? "项目" : detailScope === "plugin" ? "插件" : "全局")}
                    </span>
                    {detailSkill?.version && (
                      <span className="skill-badge is-meta">v{detailSkill.version}</span>
                    )}
                    {detailSkill?.author && (
                      <span className="skill-badge is-meta">{detailSkill.author}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="skills-detail-close"
                  onClick={() => {
                    setActiveSkillKey("");
                    setSkillDetail(null);
                    setSkillDetailError("");
                    setSkillDetailLoading(false);
                  }}
                >
                  关闭
                </button>
              </header>

              <div className="skills-detail-content-scroll">
                <div className="skills-detail-meta">
                  <div>
                    <span>路径</span>
                    <strong>{detailSkill?.relativePath || activeSkillKey}</strong>
                  </div>
                  {detailSkill?.category && (
                    <div>
                      <span>分类</span>
                      <strong>{detailSkill.category}</strong>
                    </div>
                  )}
                  {detailSkill?.license && (
                    <div>
                      <span>许可证</span>
                      <strong>{detailSkill.license}</strong>
                    </div>
                  )}
                </div>

                {detailSkill?.defaultPrompt && (
                  <div className="skills-detail-prompt">
                    <span>default prompt</span>
                    <p>{detailSkill.defaultPrompt}</p>
                  </div>
                )}

                {skillDetailLoading && <div className="skills-detail-loading">正在加载全文...</div>}
                {skillDetailError && <div className="skills-detail-error">{skillDetailError}</div>}

                {skillDetail && (
                  <div className="skills-detail-body">
                    <div className="skills-detail-filepath">
                      <span>当前路径</span>
                      <strong>{skillDetail.filePath}</strong>
                    </div>

                    <div className="skills-detail-content">
                      <MarkdownMessage
                        content={formatSkillContentForDisplay(skillDetail.content || "")}
                        className="skills-detail-markdown"
                      />
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
