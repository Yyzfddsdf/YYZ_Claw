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
        content: String(response?.content ?? ""),
        bundleFiles: Array.isArray(response?.bundleFiles) ? response.bundleFiles : []
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

  const activeCatalogSkill = activeSkillKey ? skillByIdentifier.get(activeSkillKey) : null;
  const enabledCount = selectedSkillKeys.length;
  const detailSkill = skillDetail?.skill || activeCatalogSkill || null;
  const detailScope = detailSkill?.scope || activeCatalogSkill?.scope || "";

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
                      {projectSkills.map((skill) => {
                        const identifier = toSkillIdentifier(skill);
                        const isSelected = selectedSkillKeys.includes(identifier);
                        const isActive = activeSkillKey === identifier;

                        return (
                          <article
                            key={identifier}
                            className={`skill-card ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${skill.isSystem ? "is-system" : ""}`}
                            onClick={() => openSkillDetail(skill)}
                          >
                            <div className="skill-card-top">
                              <h3 className="skill-card-title">{skill.displayName || skill.name}</h3>
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
                              <span className={`skill-badge ${skill.scope}`}>
                                {skill.scope === "project" ? "项目" : skill.scope}
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
                      })}
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
                      {globalSkills.map((skill) => {
                        const identifier = toSkillIdentifier(skill);
                        const isSelected = selectedSkillKeys.includes(identifier);
                        const isActive = activeSkillKey === identifier;

                        return (
                          <article
                            key={identifier}
                            className={`skill-card ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${skill.isSystem ? "is-system" : ""}`}
                            onClick={() => openSkillDetail(skill)}
                          >
                            <div className="skill-card-top">
                              <h3 className="skill-card-title">{skill.displayName || skill.name}</h3>
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
                              <span className={`skill-badge ${skill.scope}`}>
                                {skill.scope === "global" ? "全局" : skill.scope}
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
                      })}
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
                      {systemSkills.map((skill) => {
                        const identifier = toSkillIdentifier(skill);
                        const isSelected = selectedSkillKeys.includes(identifier);
                        const isActive = activeSkillKey === identifier;

                        return (
                          <article
                            key={identifier}
                            className={`skill-card ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${skill.isSystem ? "is-system" : ""}`}
                            onClick={() => openSkillDetail(skill)}
                          >
                            <div className="skill-card-top">
                              <h3 className="skill-card-title">{skill.displayName || skill.name}</h3>
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
                              <span className="skill-badge system">系统</span>
                              <span className="skill-badge is-meta">点开看全文</span>
                            </div>
                            <div className="skill-card-body">
                              <p className="skill-card-desc">
                                {skill.shortDescription || skill.description || "暂无描述"}
                              </p>
                            </div>
                          </article>
                        );
                      })}
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
                  onClick={(event) => event.stopPropagation()}
                >
                  <header className="skills-detail-head">
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
                      <div>
                        <span>平台</span>
                        <strong>
                          {Array.isArray(detailSkill?.platforms) && detailSkill.platforms.length > 0
                            ? detailSkill.platforms.join(" · ")
                            : "所有平台"}
                        </strong>
                      </div>
                      <div>
                        <span>相关 skill</span>
                        <strong>{Array.isArray(detailSkill?.relatedSkills) ? detailSkill.relatedSkills.length : 0}</strong>
                      </div>
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
                            content={skillDetail.content || ""}
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
