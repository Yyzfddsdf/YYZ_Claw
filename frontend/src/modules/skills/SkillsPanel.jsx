import React, { useEffect, useMemo, useRef, useState } from "react";

import { fetchSkillByName } from "../../api/chatApi";
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
  const [activeSkillKey, setActiveSkillKey] = useState("");
  const [skillDetailCache, setSkillDetailCache] = useState({});
  const [skillDetail, setSkillDetail] = useState(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState("");
  const requestIdRef = useRef(0);

  const selectedSkillKeys = useMemo(() => {
    if (!Array.isArray(chat?.activeConversationSkills)) {
      return [];
    }

    return chat.activeConversationSkills.map((key) => String(key ?? "").trim()).filter(Boolean);
  }, [chat?.activeConversationSkills]);

  const catalogList = Array.isArray(chat?.skillCatalog) ? chat.skillCatalog : [];

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

  useEffect(() => {
    if (activeSkillKey && !skillByIdentifier.has(activeSkillKey)) {
      setActiveSkillKey("");
      setSkillDetail(null);
      setSkillDetailError("");
      setSkillDetailLoading(false);
    }
  }, [activeSkillKey, skillByIdentifier]);

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

  const activeCatalogSkill = activeSkillKey ? skillByIdentifier.get(activeSkillKey) : null;
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
            已启用: {enabledCount} / {catalogList.length}
          </span>
          <button
            type="button"
            className="refresh-button mode-pill"
            onClick={() => chat?.reloadSkillCatalog?.()}
            disabled={!chat?.skillCatalogLoaded}
          >
            刷新库
          </button>
        </div>
      </header>

      <div className="skills-panel-content">
        {!chat?.historyLoaded || !chat?.skillCatalogLoaded ? (
          <div className="empty-note">正在加载技能库...</div>
        ) : catalogList.length === 0 ? (
          <div className="empty-note">暂无可用技能。</div>
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
      </div>
    </div>
  );
}
