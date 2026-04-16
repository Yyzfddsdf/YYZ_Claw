import { useEffect, useMemo, useState } from "react";

import {
  createMemoryContent,
  createMemoryNode,
  createMemoryNodeRelation,
  createMemoryTopic,
  deleteMemoryContent,
  deleteMemoryNode,
  deleteMemoryTopic,
  fetchMemoryContentById,
  fetchMemoryTopicById,
  fetchMemoryTopics,
  updateMemoryContent,
  updateMemoryNode,
  updateMemoryTopic
} from "../../api/memoryApi";
import "./memory.css";

function formatMetaCount(label, count) {
  return `${label} ${Number(count ?? 0)}`;
}

function formatTimeMeta(createdAt, updatedAt) {
  const created = String(createdAt ?? "").trim();
  const updated = String(updatedAt ?? "").trim();

  if (created && updated) {
    return `创建 ${created} · 更新 ${updated}`;
  }

  return updated || created || "无时间";
}

function createEmptySelection() {
  return {
    topicId: "",
    contentId: "",
    nodeId: ""
  };
}

function normalizeKeywordList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .slice(0, 20)
    )
  );
}

function formatKeywordList(value) {
  const keywords = normalizeKeywordList(value);
  return keywords.length > 0 ? keywords.join("，") : "无关键词";
}

function promptKeywordList(label, initialKeywords = [], exampleKeywords = []) {
  const fallbackExamples =
    exampleKeywords.length > 0
      ? exampleKeywords
      : ["session_search", "hermes", "历史检索"];
  const rawValue = window.prompt(
    `${label} JSON 数组，例如 ${JSON.stringify(fallbackExamples)}`,
    JSON.stringify(normalizeKeywordList(initialKeywords))
  );

  if (rawValue === null) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(rawValue));
  } catch {
    throw new Error("关键词必须是合法 JSON 数组");
  }

  const keywords = normalizeKeywordList(parsed);
  if (keywords.length === 0) {
    throw new Error("关键词至少要有 1 项");
  }

  return keywords;
}

export function MemoryPanel({ onNavigate }) {
  const [topics, setTopics] = useState([]);
  const [selected, setSelected] = useState(createEmptySelection);
  const [topicDetail, setTopicDetail] = useState(null);
  const [contentDetail, setContentDetail] = useState(null);
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [loadingTopicDetail, setLoadingTopicDetail] = useState(false);
  const [loadingContentDetail, setLoadingContentDetail] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");

  const contents = useMemo(
    () => (Array.isArray(topicDetail?.contents) ? topicDetail.contents : []),
    [topicDetail]
  );
  const nodes = useMemo(
    () => (Array.isArray(contentDetail?.nodes) ? contentDetail.nodes : []),
    [contentDetail]
  );

  async function loadTopics(options = {}) {
    setLoadingTopics(true);
    setError("");

    try {
      const response = await fetchMemoryTopics();
      const nextTopics = Array.isArray(response?.topics) ? response.topics : [];
      setTopics(nextTopics);

      if (options.preserveTopicId) {
        const stillExists = nextTopics.some((topic) => topic.id === options.preserveTopicId);
        if (!stillExists) {
          setSelected(createEmptySelection());
          setTopicDetail(null);
          setContentDetail(null);
        }
      }
    } catch (requestError) {
      setError(requestError?.message || "加载记忆主题失败");
    } finally {
      setLoadingTopics(false);
    }
  }

  async function loadTopicDetail(topicId, nextContentId = "") {
    const normalizedTopicId = String(topicId ?? "").trim();
    if (!normalizedTopicId) {
      setSelected(createEmptySelection());
      setTopicDetail(null);
      setContentDetail(null);
      return;
    }

    setLoadingTopicDetail(true);
    setError("");

    try {
      const response = await fetchMemoryTopicById(normalizedTopicId);
      const topic = response?.topic ?? null;
      setTopicDetail(topic);
      setSelected({
        topicId: normalizedTopicId,
        contentId: nextContentId || "",
        nodeId: ""
      });

      if (!nextContentId) {
        setContentDetail(null);
      }
    } catch (requestError) {
      setError(requestError?.message || "加载内容层失败");
    } finally {
      setLoadingTopicDetail(false);
    }
  }

  async function loadContentDetail(contentId) {
    const normalizedContentId = String(contentId ?? "").trim();
    if (!normalizedContentId) {
      setSelected((prev) => ({
        ...prev,
        contentId: "",
        nodeId: ""
      }));
      setContentDetail(null);
      return;
    }

    setLoadingContentDetail(true);
    setError("");

    try {
      const response = await fetchMemoryContentById(normalizedContentId);
      setContentDetail(response?.content ?? null);
      setSelected((prev) => ({
        ...prev,
        contentId: normalizedContentId,
        nodeId: ""
      }));
    } catch (requestError) {
      setError(requestError?.message || "加载记忆节点失败");
    } finally {
      setLoadingContentDetail(false);
    }
  }

  useEffect(() => {
    loadTopics();
  }, []);

  async function handleCreateTopic() {
    const name = window.prompt("新主题名称");
    if (!name || !name.trim()) {
      return;
    }

    setBusyAction("create-topic");
    setError("");
    try {
      const response = await createMemoryTopic({ name: name.trim() });
      await loadTopics();
      if (response?.topic?.id) {
        await loadTopicDetail(response.topic.id);
      }
    } catch (requestError) {
      setError(requestError?.message || "新增主题失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleRenameTopic(topic) {
    const name = window.prompt("修改主题名称", String(topic?.name ?? ""));
    if (!name || !name.trim()) {
      return;
    }

    setBusyAction(`rename-topic-${topic.id}`);
    setError("");
    try {
      await updateMemoryTopic(topic.id, { name: name.trim() });
      await loadTopics({ preserveTopicId: topic.id });
      await loadTopicDetail(topic.id, selected.contentId);
    } catch (requestError) {
      setError(requestError?.message || "修改主题失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteTopic(topic) {
    const confirmed = window.confirm(
      `确定删除主题“${topic.name}”吗？其下内容层和记忆节点会一起删除。`
    );
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-topic-${topic.id}`);
    setError("");
    try {
      await deleteMemoryTopic(topic.id);
      if (selected.topicId === topic.id) {
        setSelected(createEmptySelection());
        setTopicDetail(null);
        setContentDetail(null);
      }
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "删除主题失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleCreateContent() {
    if (!selected.topicId) {
      setError("请先选择一个主题");
      return;
    }

    const name = window.prompt("新内容块名称");
    if (!name || !name.trim()) {
      return;
    }

    const description = window.prompt("内容块说明（可选）", "") ?? "";

    setBusyAction("create-content");
    setError("");
    try {
      const response = await createMemoryContent({
        topicId: selected.topicId,
        name: name.trim(),
        description: description.trim()
      });
      await loadTopicDetail(selected.topicId, response?.content?.id ?? "");
      if (response?.content?.id) {
        await loadContentDetail(response.content.id);
      }
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "新增内容块失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleEditContentName(content) {
    const name = window.prompt("修改内容块名称", String(content?.name ?? ""));
    if (!name || !name.trim()) {
      return;
    }

    setBusyAction(`edit-content-name-${content.id}`);
    setError("");
    try {
      await updateMemoryContent(content.id, {
        name: name.trim()
      });
      await loadTopicDetail(selected.topicId, content.id);
      await loadContentDetail(content.id);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "修改内容块名称失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleEditContentDescription(content) {
    const description = window.prompt(
      "修改内容块说明",
      String(content?.description ?? "")
    );

    if (description === null) {
      return;
    }

    setBusyAction(`edit-content-description-${content.id}`);
    setError("");
    try {
      await updateMemoryContent(content.id, {
        description: String(description).trim()
      });
      await loadTopicDetail(selected.topicId, content.id);
      await loadContentDetail(content.id);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "修改内容块说明失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteContent(content) {
    const confirmed = window.confirm(`确定删除内容块“${content.name}”吗？其下记忆节点会一起删除。`);
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-content-${content.id}`);
    setError("");
    try {
      await deleteMemoryContent(content.id);
      if (selected.contentId === content.id) {
        setContentDetail(null);
        setSelected((prev) => ({
          ...prev,
          contentId: ""
        }));
      }
      await loadTopicDetail(selected.topicId);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "删除内容块失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleCreateNode() {
    if (!selected.contentId) {
      setError("请先选择一个内容块");
      return;
    }

    const name = window.prompt("记忆结点名称");
    if (!name || !name.trim()) {
      return;
    }

    const coreMemory = window.prompt("核心记忆");
    if (!coreMemory || !coreMemory.trim()) {
      return;
    }

    const explanation = window.prompt("解释说明");
    if (!explanation || !explanation.trim()) {
      return;
    }

    let specificKeywords;
    let generalKeywords;
    try {
      specificKeywords = promptKeywordList(
        "具体关键词",
        [],
        ["session_search", "hermes", "FTS5", "OpenAI Responses API"]
      );
      generalKeywords = promptKeywordList(
        "泛化关键词",
        [],
        ["会话检索", "历史搜索", "检索能力", "上下文记忆"]
      );
    } catch (parseError) {
      setError(parseError?.message || "关键词格式错误");
      return;
    }

    if (!specificKeywords || !generalKeywords) {
      return;
    }

    setBusyAction("create-node");
    setError("");
    try {
      await createMemoryNode({
        contentId: selected.contentId,
        name: name.trim(),
        coreMemory: coreMemory.trim(),
        explanation: explanation.trim(),
        specificKeywords,
        generalKeywords
      });
      await loadContentDetail(selected.contentId);
      await loadTopicDetail(selected.topicId, selected.contentId);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "新增记忆节点失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleEditNodeField(node, field, promptLabel) {
    let nextValue;
    if (field === "specificKeywords" || field === "generalKeywords") {
      try {
        nextValue = promptKeywordList(
          field === "specificKeywords" ? "修改具体关键词" : "修改泛化关键词",
          node?.[field],
          field === "specificKeywords"
            ? ["session_search", "hermes", "FTS5", "OpenAI Responses API"]
            : ["会话检索", "历史搜索", "检索能力", "上下文记忆"]
        );
      } catch (parseError) {
        setError(parseError?.message || "关键词格式错误");
        return;
      }
      if (!nextValue) {
        return;
      }
    } else {
      nextValue = window.prompt(promptLabel, String(node?.[field] ?? ""));
      if (nextValue === null) {
        return;
      }

      const trimmedValue = String(nextValue).trim();
      if (!trimmedValue) {
        return;
      }
      nextValue = trimmedValue;
    }

    setBusyAction(`edit-node-${field}-${node.id}`);
    setError("");
    try {
      await updateMemoryNode(node.id, {
        [field]: nextValue
      });
      await loadContentDetail(selected.contentId);
      await loadTopicDetail(selected.topicId, selected.contentId);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "修改记忆节点失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteNode(node) {
    const confirmed = window.confirm(`确定删除记忆结点“${node.name}”吗？`);
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-node-${node.id}`);
    setError("");
    try {
      await deleteMemoryNode(node.id);
      await loadContentDetail(selected.contentId);
      await loadTopicDetail(selected.topicId, selected.contentId);
      await loadTopics({ preserveTopicId: selected.topicId });
    } catch (requestError) {
      setError(requestError?.message || "删除记忆节点失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleLinkNode(node) {
    const targetNodeId = window.prompt("输入目标记忆节点 ID");
    if (!targetNodeId || !targetNodeId.trim()) {
      return;
    }

    const normalizedTargetNodeId = targetNodeId.trim();
    if (normalizedTargetNodeId === String(node?.id ?? "").trim()) {
      setError("不能把节点关联到自己");
      return;
    }

    const reason = window.prompt("关联原因（可选）", "") ?? "";

    setBusyAction(`link-node-${node.id}`);
    setError("");
    try {
      await createMemoryNodeRelation({
        fromNodeId: node.id,
        toNodeId: normalizedTargetNodeId,
        relationType: "related_to",
        reason: reason.trim()
      });
      await loadContentDetail(selected.contentId);
    } catch (requestError) {
      setError(requestError?.message || "建立节点关联失败");
    } finally {
      setBusyAction("");
    }
  }

  async function handleOpenRelatedNode(relatedNode) {
    const nextTopicId = String(relatedNode?.topicId ?? "").trim();
    const nextContentId = String(relatedNode?.contentId ?? "").trim();
    const nextNodeId = String(relatedNode?.memoryNodeId ?? "").trim();

    if (!nextTopicId || !nextContentId || !nextNodeId) {
      return;
    }

    await loadTopicDetail(nextTopicId, nextContentId);
    await loadContentDetail(nextContentId);
    setSelected({
      topicId: nextTopicId,
      contentId: nextContentId,
      nodeId: nextNodeId
    });
  }

  return (
    <div className="memory-panel">
      <header className="memory-panel-header">
        <div className="memory-panel-header-left">
          <button type="button" className="back-button mode-pill" onClick={() => onNavigate("chat")}>
            ← 返回会话
          </button>
          <div className="memory-title-wrap">
            <h2>长期记忆</h2>
            <p>按主题层 → 内容层 → 记忆节点层递进浏览，不做整树展开。</p>
          </div>
        </div>

        <div className="memory-panel-header-right">
          <button
            type="button"
            className="refresh-button mode-pill"
            onClick={() => loadTopics({ preserveTopicId: selected.topicId })}
            disabled={loadingTopics || Boolean(busyAction)}
          >
            刷新
          </button>
        </div>
      </header>

      {error && <div className="memory-banner error">{error}</div>}

      <div className="memory-layout">
        <section className="memory-column">
          <header className="memory-column-head">
            <div>
              <span className="memory-kicker">Layer 1</span>
              <h3>主题层</h3>
            </div>
            <button
              type="button"
              className="memory-action"
              onClick={handleCreateTopic}
              disabled={Boolean(busyAction)}
            >
              新增
            </button>
          </header>

          <div className="memory-column-body">
            {loadingTopics ? (
              <div className="memory-empty">正在加载主题...</div>
            ) : topics.length === 0 ? (
              <div className="memory-empty">暂无主题</div>
            ) : (
              <div className="memory-list">
                {topics.map((topic) => {
                  const isActive = selected.topicId === topic.id;
                  return (
                    <article
                      key={topic.id}
                      className={`memory-list-item ${isActive ? "is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="memory-list-main"
                        onClick={() => loadTopicDetail(topic.id)}
                      >
                        <strong>{topic.name}</strong>
                        <span>
                          {formatMetaCount("内容块", topic.contentCount)} · {formatMetaCount("记忆", topic.nodeCount)}
                        </span>
                        <em>{formatTimeMeta(topic.createdAt, topic.updatedAt)}</em>
                      </button>
                      <div className="memory-list-actions">
                        <button
                          type="button"
                          onClick={() => handleRenameTopic(topic)}
                          disabled={Boolean(busyAction)}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTopic(topic)}
                          disabled={Boolean(busyAction)}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="memory-column">
          <header className="memory-column-head">
            <div>
              <span className="memory-kicker">Layer 2</span>
              <h3>内容层</h3>
              <p>{topicDetail?.name || "先选择左侧主题"}</p>
            </div>
            <button
              type="button"
              className="memory-action"
              onClick={handleCreateContent}
              disabled={!selected.topicId || Boolean(busyAction)}
            >
              新增
            </button>
          </header>

          <div className="memory-column-body">
            {!selected.topicId ? (
              <div className="memory-empty">选择主题后加载内容块</div>
            ) : loadingTopicDetail ? (
              <div className="memory-empty">正在加载内容层...</div>
            ) : contents.length === 0 ? (
              <div className="memory-empty">当前主题下暂无内容块</div>
            ) : (
              <div className="memory-list">
                {contents.map((content) => {
                  const isActive = selected.contentId === content.id;
                  return (
                    <article
                      key={content.id}
                      className={`memory-list-item ${isActive ? "is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="memory-list-main"
                        onClick={() => loadContentDetail(content.id)}
                      >
                        <strong>{content.name}</strong>
                        <span>{content.description || "无说明"}</span>
                        <em>{formatMetaCount("记忆节点", content.nodeCount)}</em>
                        <em>{formatTimeMeta(content.createdAt, content.updatedAt)}</em>
                      </button>
                      <div className="memory-list-actions">
                        <button
                          type="button"
                          onClick={() => handleEditContentName(content)}
                          disabled={Boolean(busyAction)}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEditContentDescription(content)}
                          disabled={Boolean(busyAction)}
                        >
                          改说明
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteContent(content)}
                          disabled={Boolean(busyAction)}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="memory-column memory-column-detail">
          <header className="memory-column-head">
            <div>
              <span className="memory-kicker">Layer 3</span>
              <h3>记忆节点层</h3>
              <p>{contentDetail?.name || "先选择中间内容块"}</p>
            </div>
            <button
              type="button"
              className="memory-action"
              onClick={handleCreateNode}
              disabled={!selected.contentId || Boolean(busyAction)}
            >
              新增
            </button>
          </header>

          <div className="memory-column-body">
            {!selected.contentId ? (
              <div className="memory-empty">选择内容块后加载记忆节点</div>
            ) : loadingContentDetail ? (
              <div className="memory-empty">正在加载记忆节点...</div>
            ) : nodes.length === 0 ? (
              <div className="memory-empty">当前内容块下暂无记忆节点</div>
            ) : (
              <div className="memory-node-list">
                {nodes.map((node) => (
                  <article
                    key={node.id}
                    className={`memory-node ${selected.nodeId === node.id ? "is-focused" : ""}`}
                  >
                    <div className="memory-node-head">
                      <div>
                        <span className="memory-node-label">结点名称</span>
                        <h4>{node.name}</h4>
                        <p className="memory-node-time">{formatTimeMeta(node.createdAt, node.updatedAt)}</p>
                      </div>
                      <div className="memory-list-actions">
                        <button
                          type="button"
                          onClick={() => handleEditNodeField(node, "name", "修改记忆结点名称")}
                          disabled={Boolean(busyAction)}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEditNodeField(node, "coreMemory", "修改核心记忆")}
                          disabled={Boolean(busyAction)}
                        >
                          改核心
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEditNodeField(node, "explanation", "修改解释说明")}
                          disabled={Boolean(busyAction)}
                        >
                          改解释
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleEditNodeField(node, "specificKeywords", "修改具体关键词")
                          }
                          disabled={Boolean(busyAction)}
                        >
                          改具体词
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleEditNodeField(node, "generalKeywords", "修改泛化关键词")
                          }
                          disabled={Boolean(busyAction)}
                        >
                          改泛化词
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLinkNode(node)}
                          disabled={Boolean(busyAction)}
                        >
                          关联
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteNode(node)}
                          disabled={Boolean(busyAction)}
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    <dl className="memory-node-grid">
                      <div>
                        <dt>核心记忆</dt>
                        <dd>{node.coreMemory}</dd>
                      </div>
                      <div>
                        <dt>解释说明</dt>
                        <dd>{node.explanation}</dd>
                      </div>
                      <div>
                        <dt>具体关键词</dt>
                        <dd>{formatKeywordList(node.specificKeywords)}</dd>
                      </div>
                      <div>
                        <dt>泛化关键词</dt>
                        <dd>{formatKeywordList(node.generalKeywords)}</dd>
                      </div>
                    </dl>

                    <div className="memory-related">
                      <div className="memory-related-head">
                        <span>相关记忆</span>
                        <em>
                          {Array.isArray(node.relatedMemoryNodes)
                            ? `共 ${node.relatedMemoryNodes.length} 条`
                            : "共 0 条"}
                        </em>
                      </div>

                      {Array.isArray(node.relatedMemoryNodes) && node.relatedMemoryNodes.length > 0 ? (
                        <div className="memory-related-list">
                          {node.relatedMemoryNodes.map((relation) => (
                            <button
                              key={relation.relationId}
                              type="button"
                              className="memory-related-item"
                              onClick={() => handleOpenRelatedNode(relation)}
                            >
                              <strong>{relation.memoryNodeName}</strong>
                              <span>
                                {relation.topicName} / {relation.contentName}
                              </span>
                              <span>
                                {relation.reason || relation.relationType || "related_to"}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="memory-related-empty">暂无关联节点</div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
