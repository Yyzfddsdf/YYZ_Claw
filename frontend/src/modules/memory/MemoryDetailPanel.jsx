import { useEffect, useMemo, useState } from "react";

import {
  buildTreeStats,
  createRootSelection,
  formatKeywordList,
  formatTimeMeta,
  keywordsToEditorText,
  parseKeywordEditorText
} from "./memoryShared";

function createEmptyContentForm() {
  return {
    name: "",
    description: ""
  };
}

function createEmptyNodeForm() {
  return {
    name: "",
    coreMemory: "",
    explanation: "",
    specificKeywordsText: "",
    generalKeywordsText: ""
  };
}

function createEmptyRelationForm() {
  return {
    targetNodeId: "",
    reason: ""
  };
}

function createNodePayloadFromDraft(draft) {
  return {
    name: String(draft?.name ?? "").trim(),
    coreMemory: String(draft?.coreMemory ?? "").trim(),
    explanation: String(draft?.explanation ?? "").trim(),
    specificKeywords: parseKeywordEditorText(draft?.specificKeywordsText),
    generalKeywords: parseKeywordEditorText(draft?.generalKeywordsText)
  };
}

function MemoryField({ label, children, hint }) {
  return (
    <label className="memory-detail-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function MemoryReadonlyField({ label, value }) {
  return (
    <div className="memory-detail-readonly">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  );
}

export function MemoryDetailPanel({
  topics,
  selection,
  topic,
  content,
  node,
  busyAction,
  onCreateTopic,
  onUpdateTopic,
  onDeleteTopic,
  onCreateContent,
  onUpdateContent,
  onDeleteContent,
  onCreateNode,
  onUpdateNode,
  onDeleteNode,
  onCreateRelation,
  onOpenRelatedNode
}) {
  const [panelError, setPanelError] = useState("");
  const [newTopicName, setNewTopicName] = useState("");
  const [topicNameDraft, setTopicNameDraft] = useState("");
  const [newContentForm, setNewContentForm] = useState(createEmptyContentForm);
  const [contentDraft, setContentDraft] = useState(createEmptyContentForm);
  const [newNodeForm, setNewNodeForm] = useState(createEmptyNodeForm);
  const [nodeDraft, setNodeDraft] = useState(createEmptyNodeForm);
  const [relationForm, setRelationForm] = useState(createEmptyRelationForm);

  const stats = useMemo(() => buildTreeStats(topics), [topics]);
  const isBusy = Boolean(busyAction);
  const normalizedSelection = selection && typeof selection === "object" ? selection : createRootSelection();

  useEffect(() => {
    setPanelError("");
  }, [normalizedSelection.kind, normalizedSelection.topicId, normalizedSelection.contentId, normalizedSelection.nodeId]);

  useEffect(() => {
    setTopicNameDraft(String(topic?.name ?? ""));
  }, [topic?.id, topic?.name]);

  useEffect(() => {
    setContentDraft({
      name: String(content?.name ?? ""),
      description: String(content?.description ?? "")
    });
  }, [content?.id, content?.name, content?.description]);

  useEffect(() => {
    setNodeDraft({
      name: String(node?.name ?? ""),
      coreMemory: String(node?.coreMemory ?? ""),
      explanation: String(node?.explanation ?? ""),
      specificKeywordsText: keywordsToEditorText(node?.specificKeywords),
      generalKeywordsText: keywordsToEditorText(node?.generalKeywords)
    });
  }, [node?.id, node?.name, node?.coreMemory, node?.explanation, node?.specificKeywords, node?.generalKeywords]);

  async function submitCreateTopic(event) {
    event.preventDefault();
    const name = newTopicName.trim();
    if (!name) {
      setPanelError("主题名称不能为空");
      return;
    }
    setPanelError("");
    await onCreateTopic({ name });
    setNewTopicName("");
  }

  async function submitUpdateTopic(event) {
    event.preventDefault();
    if (!topic?.id) {
      return;
    }
    const name = topicNameDraft.trim();
    if (!name) {
      setPanelError("主题名称不能为空");
      return;
    }
    setPanelError("");
    await onUpdateTopic(topic.id, { name });
  }

  async function submitCreateContent(event) {
    event.preventDefault();
    if (!topic?.id) {
      return;
    }
    const name = newContentForm.name.trim();
    if (!name) {
      setPanelError("内容块名称不能为空");
      return;
    }
    setPanelError("");
    await onCreateContent({
      topicId: topic.id,
      name,
      description: newContentForm.description.trim()
    });
    setNewContentForm(createEmptyContentForm());
  }

  async function submitUpdateContent(event) {
    event.preventDefault();
    if (!content?.id) {
      return;
    }
    const name = contentDraft.name.trim();
    if (!name) {
      setPanelError("内容块名称不能为空");
      return;
    }
    setPanelError("");
    await onUpdateContent(content.id, {
      name,
      description: contentDraft.description.trim()
    });
  }

  async function submitCreateNode(event) {
    event.preventDefault();
    if (!content?.id) {
      return;
    }
    const payload = createNodePayloadFromDraft(newNodeForm);
    if (
      !payload.name ||
      !payload.coreMemory ||
      !payload.explanation ||
      payload.specificKeywords.length === 0 ||
      payload.generalKeywords.length === 0
    ) {
      setPanelError("记忆节点名称、核心记忆、解释、两组关键词都不能为空");
      return;
    }
    setPanelError("");
    await onCreateNode({
      contentId: content.id,
      ...payload
    });
    setNewNodeForm(createEmptyNodeForm());
  }

  async function submitUpdateNode(event) {
    event.preventDefault();
    if (!node?.id) {
      return;
    }
    const payload = createNodePayloadFromDraft(nodeDraft);
    if (
      !payload.name ||
      !payload.coreMemory ||
      !payload.explanation ||
      payload.specificKeywords.length === 0 ||
      payload.generalKeywords.length === 0
    ) {
      setPanelError("记忆节点名称、核心记忆、解释、两组关键词都不能为空");
      return;
    }
    setPanelError("");
    await onUpdateNode(node.id, payload);
  }

  async function submitCreateRelation(event) {
    event.preventDefault();
    if (!node?.id) {
      return;
    }
    const targetNodeId = relationForm.targetNodeId.trim();
    if (!targetNodeId) {
      setPanelError("目标节点 ID 不能为空");
      return;
    }
    setPanelError("");
    await onCreateRelation({
      fromNodeId: node.id,
      toNodeId: targetNodeId,
      relationType: "related_to",
      reason: relationForm.reason.trim()
    });
    setRelationForm(createEmptyRelationForm());
  }

  return (
    <aside className="memory-detail-panel">
      <div className="memory-detail-panel-inner">
        <header className="memory-detail-header">
          <span className="memory-detail-kicker">
            {normalizedSelection.kind === "root"
              ? "Memory Root"
              : normalizedSelection.kind === "topic"
                ? "Topic"
                : normalizedSelection.kind === "content"
                  ? "Content"
                  : "Node"}
          </span>
          <h3>
            {normalizedSelection.kind === "root"
              ? "记忆库"
              : normalizedSelection.kind === "topic"
                ? topic?.name || "主题"
                : normalizedSelection.kind === "content"
                  ? content?.name || "内容块"
                  : node?.name || "记忆节点"}
          </h3>
          <p>
            {normalizedSelection.kind === "root"
              ? "右侧面板承接所有详情和 CRUD，图谱区只做浏览与导航。"
              : normalizedSelection.kind === "topic"
                ? formatTimeMeta(topic?.createdAt, topic?.updatedAt)
                : normalizedSelection.kind === "content"
                  ? formatTimeMeta(content?.createdAt, content?.updatedAt)
                  : formatTimeMeta(node?.createdAt, node?.updatedAt)}
          </p>
        </header>

        {panelError ? <div className="memory-detail-banner error">{panelError}</div> : null}

        {normalizedSelection.kind === "root" && (
          <>
            <section className="memory-detail-card memory-detail-stats">
              <div>
                <strong>{stats.topicCount}</strong>
                <span>主题</span>
              </div>
              <div>
                <strong>{stats.contentCount}</strong>
                <span>内容块</span>
              </div>
              <div>
                <strong>{stats.nodeCount}</strong>
                <span>记忆节点</span>
              </div>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>新增主题</h4>
                <p>根节点只做一级主题的创建入口。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitCreateTopic}>
                <MemoryField label="主题名称">
                  <input
                    value={newTopicName}
                    onChange={(event) => setNewTopicName(event.target.value)}
                    placeholder="例如：偏好 / 经历 / 项目经验"
                    disabled={isBusy}
                  />
                </MemoryField>
                <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                  {isBusy ? "处理中..." : "创建主题"}
                </button>
              </form>
            </section>
          </>
        )}

        {normalizedSelection.kind === "topic" && topic && (
          <>
            <section className="memory-detail-card memory-detail-stats">
              <div>
                <strong>{topic.contentCount}</strong>
                <span>内容块</span>
              </div>
              <div>
                <strong>{topic.nodeCount}</strong>
                <span>记忆节点</span>
              </div>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>编辑主题</h4>
                <p>主题层只保留名称和删除操作。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitUpdateTopic}>
                <MemoryField label="主题名称">
                  <input
                    value={topicNameDraft}
                    onChange={(event) => setTopicNameDraft(event.target.value)}
                    disabled={isBusy}
                  />
                </MemoryField>
                <div className="memory-detail-actions">
                  <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                    保存主题
                  </button>
                  <button
                    type="button"
                    className="memory-detail-danger"
                    onClick={() => onDeleteTopic(topic)}
                    disabled={isBusy}
                  >
                    删除主题
                  </button>
                </div>
              </form>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>新增内容块</h4>
                <p>点击图中的主题节点，只懒加载当前主题下的内容块。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitCreateContent}>
                <MemoryField label="内容块名称">
                  <input
                    value={newContentForm.name}
                    onChange={(event) =>
                      setNewContentForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="例如：输出风格 / 架构偏好"
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="内容块说明">
                  <textarea
                    value={newContentForm.description}
                    onChange={(event) =>
                      setNewContentForm((prev) => ({ ...prev, description: event.target.value }))
                    }
                    placeholder="说明该内容块承载哪一类记忆"
                    disabled={isBusy}
                    rows={4}
                  />
                </MemoryField>
                <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                  创建内容块
                </button>
              </form>
            </section>
          </>
        )}

        {normalizedSelection.kind === "content" && content && (
          <>
            <section className="memory-detail-card memory-detail-stats">
              <div>
                <strong>{content.nodeCount}</strong>
                <span>记忆节点</span>
              </div>
              <div>
                <strong>{content.topicName || "未归类"}</strong>
                <span>所属主题</span>
              </div>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>编辑内容块</h4>
                <p>内容块是主题和底层记忆节点之间的懒加载中继层。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitUpdateContent}>
                <MemoryField label="内容块名称">
                  <input
                    value={contentDraft.name}
                    onChange={(event) =>
                      setContentDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="内容块说明">
                  <textarea
                    value={contentDraft.description}
                    onChange={(event) =>
                      setContentDraft((prev) => ({ ...prev, description: event.target.value }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <div className="memory-detail-actions">
                  <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                    保存内容块
                  </button>
                  <button
                    type="button"
                    className="memory-detail-danger"
                    onClick={() => onDeleteContent(content)}
                    disabled={isBusy}
                  >
                    删除内容块
                  </button>
                </div>
              </form>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>新增记忆节点</h4>
                <p>底层节点直接参与 recall，支持两组关键词。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitCreateNode}>
                <MemoryField label="节点名称">
                  <input
                    value={newNodeForm.name}
                    onChange={(event) =>
                      setNewNodeForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="例如：喜欢直接简洁回复"
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="核心记忆">
                  <textarea
                    value={newNodeForm.coreMemory}
                    onChange={(event) =>
                      setNewNodeForm((prev) => ({ ...prev, coreMemory: event.target.value }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="解释说明">
                  <textarea
                    value={newNodeForm.explanation}
                    onChange={(event) =>
                      setNewNodeForm((prev) => ({ ...prev, explanation: event.target.value }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="具体关键词" hint="每行一个，或用逗号/分号分隔">
                  <textarea
                    value={newNodeForm.specificKeywordsText}
                    onChange={(event) =>
                      setNewNodeForm((prev) => ({
                        ...prev,
                        specificKeywordsText: event.target.value
                      }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="泛化关键词" hint="每行一个，或用逗号/分号分隔">
                  <textarea
                    value={newNodeForm.generalKeywordsText}
                    onChange={(event) =>
                      setNewNodeForm((prev) => ({
                        ...prev,
                        generalKeywordsText: event.target.value
                      }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                  创建记忆节点
                </button>
              </form>
            </section>
          </>
        )}

        {normalizedSelection.kind === "node" && node && (
          <>
            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>记忆节点详情</h4>
                <p>
                  {node.topicName} / {node.contentName}
                </p>
              </div>
              <div className="memory-detail-grid">
                <MemoryReadonlyField label="核心记忆" value={node.coreMemory} />
                <MemoryReadonlyField label="解释说明" value={node.explanation} />
                <MemoryReadonlyField
                  label="具体关键词"
                  value={formatKeywordList(node.specificKeywords)}
                />
                <MemoryReadonlyField
                  label="泛化关键词"
                  value={formatKeywordList(node.generalKeywords)}
                />
              </div>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>编辑节点</h4>
                <p>修改后会刷新当前内容块和图谱节点文本。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitUpdateNode}>
                <MemoryField label="节点名称">
                  <input
                    value={nodeDraft.name}
                    onChange={(event) =>
                      setNodeDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="核心记忆">
                  <textarea
                    value={nodeDraft.coreMemory}
                    onChange={(event) =>
                      setNodeDraft((prev) => ({ ...prev, coreMemory: event.target.value }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="解释说明">
                  <textarea
                    value={nodeDraft.explanation}
                    onChange={(event) =>
                      setNodeDraft((prev) => ({ ...prev, explanation: event.target.value }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="具体关键词" hint="每行一个，或用逗号/分号分隔">
                  <textarea
                    value={nodeDraft.specificKeywordsText}
                    onChange={(event) =>
                      setNodeDraft((prev) => ({
                        ...prev,
                        specificKeywordsText: event.target.value
                      }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="泛化关键词" hint="每行一个，或用逗号/分号分隔">
                  <textarea
                    value={nodeDraft.generalKeywordsText}
                    onChange={(event) =>
                      setNodeDraft((prev) => ({
                        ...prev,
                        generalKeywordsText: event.target.value
                      }))
                    }
                    rows={4}
                    disabled={isBusy}
                  />
                </MemoryField>
                <div className="memory-detail-actions">
                  <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                    保存节点
                  </button>
                  <button
                    type="button"
                    className="memory-detail-danger"
                    onClick={() => onDeleteNode(node)}
                    disabled={isBusy}
                  >
                    删除节点
                  </button>
                </div>
              </form>
            </section>

            <section className="memory-detail-card">
              <div className="memory-detail-section-head">
                <h4>关联记忆</h4>
                <p>支持通过目标节点 ID 直接建立 related_to 关系。</p>
              </div>
              <form className="memory-detail-form" onSubmit={submitCreateRelation}>
                <MemoryField label="目标节点 ID">
                  <input
                    value={relationForm.targetNodeId}
                    onChange={(event) =>
                      setRelationForm((prev) => ({ ...prev, targetNodeId: event.target.value }))
                    }
                    placeholder="memory_node_xxx"
                    disabled={isBusy}
                  />
                </MemoryField>
                <MemoryField label="关联原因">
                  <textarea
                    value={relationForm.reason}
                    onChange={(event) =>
                      setRelationForm((prev) => ({ ...prev, reason: event.target.value }))
                    }
                    rows={3}
                    disabled={isBusy}
                  />
                </MemoryField>
                <button type="submit" className="memory-detail-primary" disabled={isBusy}>
                  建立关联
                </button>
              </form>

              <div className="memory-related-block">
                {Array.isArray(node.relatedMemoryNodes) && node.relatedMemoryNodes.length > 0 ? (
                  node.relatedMemoryNodes.map((relation) => (
                    <button
                      key={relation.relationId}
                      type="button"
                      className="memory-related-card"
                      onClick={() => onOpenRelatedNode(relation)}
                    >
                      <strong>{relation.memoryNodeName}</strong>
                      <span>
                        {relation.topicName} / {relation.contentName}
                      </span>
                      <em>{relation.reason || relation.relationType || "related_to"}</em>
                    </button>
                  ))
                ) : (
                  <div className="memory-detail-empty">当前节点还没有关联记忆。</div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
