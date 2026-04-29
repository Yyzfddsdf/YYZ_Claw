import { startTransition, useCallback, useEffect, useMemo, useState } from "react";

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
import { MemoryActionDock } from "./MemoryActionDock";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
import { MemoryMap } from "./MemoryMap";
import {
  buildTreeStats,
  clipText,
  createContentSelection,
  createNodeSelection,
  createRootSelection,
  createTopicSelection,
  getSelectionKey
} from "./memoryShared";
import { confirmAction } from "../../shared/feedback";
import "./memory.css";

function createPlaceholderBranch(key, label, subtitle = "") {
  return {
    key,
    id: key,
    type: "loading",
    label,
    subtitle,
    isPlaceholder: true,
    children: []
  };
}

function buildMemoryTreeData({
  topics,
  topicCache,
  contentCache,
  expandedTopicId,
  expandedContentId,
  loadingTopicId,
  loadingContentId
}) {
  const stats = buildTreeStats(topics);

  return {
    key: "root:memory",
    id: "memory-root",
    type: "root",
    label: "长期记忆库",
    subtitle: `${stats.topicCount} 个主题 · ${stats.contentCount} 个内容块 · ${stats.nodeCount} 个记忆节点`,
    children: (Array.isArray(topics) ? topics : []).map((topic) => {
      const isExpandedTopic = String(expandedTopicId ?? "").trim() === String(topic.id ?? "").trim();
      const topicDetail = topicCache[String(topic.id ?? "").trim()] ?? null;
      let children = [];

      if (isExpandedTopic) {
        if (!topicDetail && String(loadingTopicId ?? "").trim() === String(topic.id ?? "").trim()) {
          children = [
            createPlaceholderBranch(
              `loading-topic:${topic.id}`,
              "正在读取内容块",
              "懒加载中"
            )
          ];
        } else if (Array.isArray(topicDetail?.contents)) {
          children = topicDetail.contents.map((content) => {
            const isExpandedContent =
              String(expandedContentId ?? "").trim() === String(content.id ?? "").trim();
            const contentDetail = contentCache[String(content.id ?? "").trim()] ?? null;
            let nodeChildren = [];

            if (isExpandedContent) {
              if (
                !contentDetail &&
                String(loadingContentId ?? "").trim() === String(content.id ?? "").trim()
              ) {
                nodeChildren = [
                  createPlaceholderBranch(
                    `loading-content:${content.id}`,
                    "正在读取记忆节点",
                    "懒加载中"
                  )
                ];
              } else if (Array.isArray(contentDetail?.nodes)) {
                nodeChildren = contentDetail.nodes.map((node) => ({
                  key: `node:${node.id}`,
                  id: node.id,
                  type: "node",
                  topicId: node.topicId,
                  contentId: node.contentId,
                  nodeId: node.id,
                  label: node.name,
                  subtitle:
                    clipText(node.coreMemory, 44) ||
                    clipText((node.keywords || []).join(" · "), 44) ||
                    "记忆节点",
                  meta: String((node.keywords || []).length || ""),
                  children: []
                }));
              }
            }

            return {
              key: `content:${content.id}`,
              id: content.id,
              type: "content",
              topicId: content.topicId,
              contentId: content.id,
              label: content.name,
              subtitle:
                clipText(content.description, 48) ||
                `${content.nodeCount} 个记忆节点`,
              meta: String(content.nodeCount ?? 0),
              children: nodeChildren
            };
          });
        }
      }

      return {
        key: `topic:${topic.id}`,
        id: topic.id,
        type: "topic",
        topicId: topic.id,
        label: topic.name,
        subtitle: `${topic.contentCount} 个内容块 · ${topic.nodeCount} 个记忆节点`,
        meta: String(topic.contentCount ?? 0),
        children
      };
    })
  };
}

export function MemoryPanel({ onNavigate }) {
  const [topics, setTopics] = useState([]);
  const [topicCache, setTopicCache] = useState({});
  const [contentCache, setContentCache] = useState({});
  const [selection, setSelection] = useState(createRootSelection);
  const [expandedTopicId, setExpandedTopicId] = useState("");
  const [expandedContentId, setExpandedContentId] = useState("");
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [loadingTopicId, setLoadingTopicId] = useState("");
  const [loadingContentId, setLoadingContentId] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [fitToken, setFitToken] = useState(0);
  const [error, setError] = useState("");

  const bumpFitToken = useCallback(() => {
    setFitToken((prev) => prev + 1);
  }, []);

  const selectedTopic = useMemo(() => {
    if (!selection.topicId) {
      return null;
    }
    return (
      topicCache[selection.topicId] ??
      topics.find((topic) => String(topic?.id ?? "").trim() === selection.topicId) ??
      null
    );
  }, [selection.topicId, topicCache, topics]);

  const selectedContent = useMemo(() => {
    if (!selection.contentId) {
      return null;
    }
    return (
      contentCache[selection.contentId] ??
      selectedTopic?.contents?.find(
        (content) => String(content?.id ?? "").trim() === selection.contentId
      ) ??
      null
    );
  }, [contentCache, selectedTopic?.contents, selection.contentId]);

  const selectedNode = useMemo(() => {
    if (!selection.nodeId || !Array.isArray(selectedContent?.nodes)) {
      return null;
    }
    return (
      selectedContent.nodes.find((node) => String(node?.id ?? "").trim() === selection.nodeId) ?? null
    );
  }, [selectedContent?.nodes, selection.nodeId]);

  const treeData = useMemo(
    () =>
      buildMemoryTreeData({
        topics,
        topicCache,
        contentCache,
        expandedTopicId,
        expandedContentId,
        loadingTopicId,
        loadingContentId
      }),
    [contentCache, expandedContentId, expandedTopicId, loadingContentId, loadingTopicId, topicCache, topics]
  );

  const selectedKey = useMemo(() => getSelectionKey(selection), [selection]);

  const loadTopics = useCallback(
    async ({ forceResetSelection = false } = {}) => {
      setLoadingTopics(true);
      setError("");

      try {
        const response = await fetchMemoryTopics();
        const nextTopics = Array.isArray(response?.topics) ? response.topics : [];
        setTopics(nextTopics);

        if (forceResetSelection) {
          startTransition(() => {
            setSelection(createRootSelection());
            setExpandedTopicId("");
            setExpandedContentId("");
          });
          return nextTopics;
        }

        const currentTopicId = String(selection.topicId ?? "").trim();
        if (currentTopicId && !nextTopics.some((topic) => String(topic?.id ?? "").trim() === currentTopicId)) {
          startTransition(() => {
            setSelection(createRootSelection());
            setExpandedTopicId("");
            setExpandedContentId("");
          });
        }

        return nextTopics;
      } catch (requestError) {
        setError(requestError?.message || "加载记忆主题失败");
        return [];
      } finally {
        setLoadingTopics(false);
      }
    },
    [selection.topicId]
  );

  const loadTopicDetail = useCallback(
    async (topicId, options = {}) => {
      const normalizedTopicId = String(topicId ?? "").trim();
      if (!normalizedTopicId) {
        startTransition(() => {
          setSelection(createRootSelection());
          setExpandedTopicId("");
          setExpandedContentId("");
        });
        return null;
      }

      const { forceRefresh = false, focusContentId = "", focusNodeId = "" } = options;

      setLoadingTopicId(normalizedTopicId);
      setError("");

      try {
        const topicDetail =
          !forceRefresh && topicCache[normalizedTopicId]
            ? topicCache[normalizedTopicId]
            : (await fetchMemoryTopicById(normalizedTopicId))?.topic ?? null;

        if (topicDetail) {
          setTopicCache((prev) => ({
            ...prev,
            [normalizedTopicId]: topicDetail
          }));

          startTransition(() => {
            setExpandedTopicId(normalizedTopicId);
            setExpandedContentId(String(focusContentId ?? "").trim());
            if (focusNodeId) {
              setSelection(
                createNodeSelection(normalizedTopicId, String(focusContentId ?? "").trim(), focusNodeId)
              );
            } else if (focusContentId) {
              setSelection(createContentSelection(normalizedTopicId, focusContentId));
            } else {
              setSelection(createTopicSelection(normalizedTopicId));
            }
          });
        }

        return topicDetail;
      } catch (requestError) {
        setError(requestError?.message || "加载内容块失败");
        return null;
      } finally {
        setLoadingTopicId("");
      }
    },
    [topicCache]
  );

  const loadContentDetail = useCallback(
    async (topicId, contentId, options = {}) => {
      const normalizedTopicId = String(topicId ?? "").trim();
      const normalizedContentId = String(contentId ?? "").trim();
      if (!normalizedContentId) {
        startTransition(() => {
          setExpandedContentId("");
          setSelection(normalizedTopicId ? createTopicSelection(normalizedTopicId) : createRootSelection());
        });
        return null;
      }

      const { forceRefresh = false, focusNodeId = "" } = options;

      setLoadingContentId(normalizedContentId);
      setError("");

      try {
        const contentDetail =
          !forceRefresh && contentCache[normalizedContentId]
            ? contentCache[normalizedContentId]
            : (await fetchMemoryContentById(normalizedContentId))?.content ?? null;

        if (contentDetail) {
          setContentCache((prev) => ({
            ...prev,
            [normalizedContentId]: contentDetail
          }));

          startTransition(() => {
            setExpandedTopicId(normalizedTopicId || String(contentDetail.topicId ?? "").trim());
            setExpandedContentId(normalizedContentId);
            if (focusNodeId) {
              setSelection(
                createNodeSelection(
                  normalizedTopicId || contentDetail.topicId,
                  normalizedContentId,
                  focusNodeId
                )
              );
            } else {
              setSelection(
                createContentSelection(normalizedTopicId || contentDetail.topicId, normalizedContentId)
              );
            }
          });
        }

        return contentDetail;
      } catch (requestError) {
        setError(requestError?.message || "加载记忆节点失败");
        return null;
      } finally {
        setLoadingContentId("");
      }
    },
    [contentCache]
  );

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  const handleRefresh = useCallback(async () => {
    await loadTopics();
    if (expandedTopicId) {
      await loadTopicDetail(expandedTopicId, {
        forceRefresh: true,
        focusContentId: expandedContentId,
        focusNodeId: selection.nodeId
      });
    }
    if (expandedContentId) {
      await loadContentDetail(expandedTopicId, expandedContentId, {
        forceRefresh: true,
        focusNodeId: selection.nodeId
      });
    }
    bumpFitToken();
  }, [
    bumpFitToken,
    expandedContentId,
    expandedTopicId,
    loadContentDetail,
    loadTopicDetail,
    loadTopics,
    selection.nodeId
  ]);

  const handleNodeActivate = useCallback(
    async (nodeData) => {
      if (!nodeData || nodeData.isPlaceholder) {
        return;
      }

      if (nodeData.type === "root") {
        startTransition(() => {
          setSelection(createRootSelection());
        });
        return;
      }

      if (nodeData.type === "topic") {
        await loadTopicDetail(nodeData.topicId || nodeData.id);
        bumpFitToken();
        return;
      }

      if (nodeData.type === "content") {
        await loadContentDetail(nodeData.topicId, nodeData.contentId || nodeData.id);
        bumpFitToken();
        return;
      }

      if (nodeData.type === "node") {
        startTransition(() => {
          setExpandedTopicId(String(nodeData.topicId ?? "").trim());
          setExpandedContentId(String(nodeData.contentId ?? "").trim());
          setSelection(
            createNodeSelection(nodeData.topicId, nodeData.contentId, nodeData.nodeId || nodeData.id)
          );
        });
      }
    },
    [bumpFitToken, loadContentDetail, loadTopicDetail]
  );

  const handleSelectRoot = useCallback(() => {
    startTransition(() => {
      setSelection(createRootSelection());
    });
  }, []);

  async function handleCreateTopic(payload) {
    setBusyAction("create-topic");
    setError("");
    try {
      const response = await createMemoryTopic(payload);
      await loadTopics();
      if (response?.topic?.id) {
        await loadTopicDetail(response.topic.id, { forceRefresh: true });
      }
      bumpFitToken();
    } catch (requestError) {
      setError(requestError?.message || "新增主题失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleUpdateTopic(topicId, payload) {
    setBusyAction(`update-topic:${topicId}`);
    setError("");
    try {
      await updateMemoryTopic(topicId, payload);
      await loadTopics();
      await loadTopicDetail(topicId, {
        forceRefresh: true,
        focusContentId: selection.contentId,
        focusNodeId: selection.nodeId
      });
    } catch (requestError) {
      setError(requestError?.message || "更新主题失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteTopic(topicToDelete) {
    const confirmed = await confirmAction({
      title: "删除记忆主题",
      message: `确定删除主题“${topicToDelete?.name ?? ""}”吗？其下内容块和记忆节点会一起删除。`,
      confirmLabel: "删除"
    });
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-topic:${topicToDelete?.id ?? ""}`);
    setError("");
    try {
      await deleteMemoryTopic(topicToDelete.id);
      setTopicCache((prev) => {
        const next = { ...prev };
        delete next[String(topicToDelete.id ?? "").trim()];
        return next;
      });
      await loadTopics({
        forceResetSelection:
          String(selection.topicId ?? "").trim() === String(topicToDelete.id ?? "").trim()
      });
      bumpFitToken();
    } catch (requestError) {
      setError(requestError?.message || "删除主题失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleCreateContent(payload) {
    setBusyAction(`create-content:${payload.topicId}`);
    setError("");
    try {
      const response = await createMemoryContent(payload);
      await loadTopics();
      await loadTopicDetail(payload.topicId, {
        forceRefresh: true,
        focusContentId: response?.content?.id ?? ""
      });
      if (response?.content?.id) {
        await loadContentDetail(payload.topicId, response.content.id, { forceRefresh: true });
      }
      bumpFitToken();
    } catch (requestError) {
      setError(requestError?.message || "新增内容块失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleUpdateContent(contentId, payload) {
    setBusyAction(`update-content:${contentId}`);
    setError("");
    try {
      const response = await updateMemoryContent(contentId, payload);
      const nextTopicId = String(response?.content?.topicId ?? selection.topicId ?? "").trim();
      await loadTopics();
      if (nextTopicId) {
        await loadTopicDetail(nextTopicId, {
          forceRefresh: true,
          focusContentId: contentId,
          focusNodeId: selection.nodeId
        });
      }
      await loadContentDetail(nextTopicId, contentId, {
        forceRefresh: true,
        focusNodeId: selection.nodeId
      });
    } catch (requestError) {
      setError(requestError?.message || "更新内容块失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteContent(contentToDelete) {
    const confirmed = await confirmAction({
      title: "删除内容块",
      message: `确定删除内容块“${contentToDelete?.name ?? ""}”吗？其下记忆节点会一起删除。`,
      confirmLabel: "删除"
    });
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-content:${contentToDelete?.id ?? ""}`);
    setError("");
    try {
      await deleteMemoryContent(contentToDelete.id);
      setContentCache((prev) => {
        const next = { ...prev };
        delete next[String(contentToDelete.id ?? "").trim()];
        return next;
      });
      await loadTopics();
      await loadTopicDetail(contentToDelete.topicId, { forceRefresh: true });
      if (String(selection.contentId ?? "").trim() === String(contentToDelete.id ?? "").trim()) {
        startTransition(() => {
          setExpandedContentId("");
          setSelection(createTopicSelection(contentToDelete.topicId));
        });
      }
      bumpFitToken();
    } catch (requestError) {
      setError(requestError?.message || "删除内容块失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleCreateNode(payload) {
    setBusyAction(`create-node:${payload.contentId}`);
    setError("");
    try {
      const response = await createMemoryNode(payload);
      const nextNodeId = String(response?.node?.id ?? "").trim();
      await loadTopics();
      await loadTopicDetail(selection.topicId, {
        forceRefresh: true,
        focusContentId: payload.contentId,
        focusNodeId: nextNodeId
      });
      await loadContentDetail(selection.topicId, payload.contentId, {
        forceRefresh: true,
        focusNodeId: nextNodeId
      });
      bumpFitToken();
    } catch (requestError) {
      setError(requestError?.message || "新增记忆节点失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleUpdateNode(nodeId, payload) {
    setBusyAction(`update-node:${nodeId}`);
    setError("");
    try {
      await updateMemoryNode(nodeId, payload);
      await loadTopics();
      await loadTopicDetail(selection.topicId, {
        forceRefresh: true,
        focusContentId: selection.contentId,
        focusNodeId: nodeId
      });
      await loadContentDetail(selection.topicId, selection.contentId, {
        forceRefresh: true,
        focusNodeId: nodeId
      });
    } catch (requestError) {
      setError(requestError?.message || "更新记忆节点失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteNode(nodeToDelete) {
    const confirmed = await confirmAction({
      title: "删除记忆节点",
      message: `确定删除记忆节点“${nodeToDelete?.name ?? ""}”吗？`,
      confirmLabel: "删除"
    });
    if (!confirmed) {
      return;
    }

    setBusyAction(`delete-node:${nodeToDelete?.id ?? ""}`);
    setError("");
    try {
      await deleteMemoryNode(nodeToDelete.id);
      await loadTopics();
      await loadTopicDetail(nodeToDelete.topicId, {
        forceRefresh: true,
        focusContentId: nodeToDelete.contentId
      });
      await loadContentDetail(nodeToDelete.topicId, nodeToDelete.contentId, {
        forceRefresh: true
      });
      if (String(selection.nodeId ?? "").trim() === String(nodeToDelete.id ?? "").trim()) {
        startTransition(() => {
          setSelection(createContentSelection(nodeToDelete.topicId, nodeToDelete.contentId));
        });
      }
    } catch (requestError) {
      setError(requestError?.message || "删除记忆节点失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleCreateRelation(payload) {
    setBusyAction(`create-relation:${payload.fromNodeId}`);
    setError("");
    try {
      await createMemoryNodeRelation(payload);
      await loadContentDetail(selection.topicId, selection.contentId, {
        forceRefresh: true,
        focusNodeId: selection.nodeId
      });
    } catch (requestError) {
      setError(requestError?.message || "建立记忆关联失败");
      throw requestError;
    } finally {
      setBusyAction("");
    }
  }

  async function handleOpenRelatedNode(relation) {
    const nextTopicId = String(relation?.topicId ?? "").trim();
    const nextContentId = String(relation?.contentId ?? "").trim();
    const nextNodeId = String(relation?.memoryNodeId ?? "").trim();

    if (!nextTopicId || !nextContentId || !nextNodeId) {
      return;
    }

    await loadTopicDetail(nextTopicId, {
      forceRefresh: true,
      focusContentId: nextContentId,
      focusNodeId: nextNodeId
    });
    await loadContentDetail(nextTopicId, nextContentId, {
      forceRefresh: true,
      focusNodeId: nextNodeId
    });
    bumpFitToken();
  }

  return (
    <div className="memory-panel">
      <div className="memory-workbench">
        <div className="memory-stage">
          <MemoryActionDock
            loading={loadingTopics}
            busy={busyAction}
            onBack={() => onNavigate("chat")}
            onRefresh={handleRefresh}
            onResetViewport={bumpFitToken}
          />

          <MemoryMap
            treeData={treeData}
            selectedKey={selectedKey}
            loading={loadingTopics || Boolean(loadingTopicId) || Boolean(loadingContentId)}
            fitToken={fitToken}
            onNodeActivate={handleNodeActivate}
            onBackgroundSelect={handleSelectRoot}
          />

          {error ? <div className="memory-floating-banner">{error}</div> : null}
        </div>

        <MemoryDetailPanel
          topics={topics}
          selection={selection}
          topic={selectedTopic}
          content={selectedContent}
          node={selectedNode}
          busyAction={busyAction}
          onCreateTopic={handleCreateTopic}
          onUpdateTopic={handleUpdateTopic}
          onDeleteTopic={handleDeleteTopic}
          onCreateContent={handleCreateContent}
          onUpdateContent={handleUpdateContent}
          onDeleteContent={handleDeleteContent}
          onCreateNode={handleCreateNode}
          onUpdateNode={handleUpdateNode}
          onDeleteNode={handleDeleteNode}
          onCreateRelation={handleCreateRelation}
          onOpenRelatedNode={handleOpenRelatedNode}
        />
      </div>
    </div>
  );
}
