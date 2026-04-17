import { useEffect, useMemo, useRef, useState } from "react";

import { parseChatFiles } from "../../api/chatApi";
import { formatTimestamp } from "../../shared/formatTimestamp";
import { MarkdownMessage } from "./MarkdownMessage";
import "./chat.css";
import { parseToolMessagePayload } from "./toolMessageCodec";
const AUTO_SCROLL_BOTTOM_THRESHOLD = 72;
const MAX_IMAGE_PAYLOAD_BYTES = 2_000_000;
const MAX_UPLOAD_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 8;
const GENERAL_FILE_ACCEPT = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".ini",
  ".log",
  ".rtf",
  ".html",
  ".htm",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".go",
  ".rs",
  ".sql",
  ".sh",
  ".bat",
  ".ps1"
].join(",");

function estimateDataUrlBytes(dataUrl) {
  const normalized = String(dataUrl ?? "").trim();
  if (!normalized.startsWith("data:")) {
    return 0;
  }

  const commaIndex = normalized.indexOf(",");
  if (commaIndex < 0) {
    return 0;
  }

  const base64 = normalized.slice(commaIndex + 1);
  const paddingLength = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - paddingLength);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").trim());
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解析失败"));
    image.src = dataUrl;
  });
}

async function compressImagePreserveDimensions(file) {
  const originalDataUrl = await readFileAsDataUrl(file);
  const originalBytes = estimateDataUrlBytes(originalDataUrl);

  if (originalBytes <= MAX_IMAGE_PAYLOAD_BYTES) {
    return {
      dataUrl: originalDataUrl,
      mimeType: String(file.type ?? "image/png").trim() || "image/png",
      size: originalBytes
    };
  }

  const image = await loadImageElement(originalDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const context = canvas.getContext("2d");
  if (!context) {
    return {
      dataUrl: originalDataUrl,
      mimeType: String(file.type ?? "image/png").trim() || "image/png",
      size: originalBytes
    };
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const originalMimeType = String(file.type ?? "").trim().toLowerCase();
  const preferredMimeType =
    originalMimeType === "image/webp"
      ? "image/webp"
      : originalMimeType === "image/png" || originalMimeType === "image/jpeg" || originalMimeType === "image/jpg"
        ? "image/webp"
        : "image/jpeg";
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26, 0.18, 0.12, 0.08, 0.05];

  let bestCandidate = {
    dataUrl: originalDataUrl,
    mimeType: String(file.type ?? "image/png").trim() || "image/png",
    size: originalBytes
  };

  for (const quality of qualities) {
    const candidateDataUrl = canvas.toDataURL(preferredMimeType, quality);
    const candidateSize = estimateDataUrlBytes(candidateDataUrl);

    if (candidateSize > 0 && candidateSize < bestCandidate.size) {
      bestCandidate = {
        dataUrl: candidateDataUrl,
        mimeType: preferredMimeType,
        size: candidateSize
      };
    }

    if (candidateSize > 0 && candidateSize <= MAX_IMAGE_PAYLOAD_BYTES) {
      return {
        dataUrl: candidateDataUrl,
        mimeType: preferredMimeType,
        size: candidateSize
      };
    }
  }

  if (bestCandidate.size <= MAX_IMAGE_PAYLOAD_BYTES) {
    return bestCandidate;
  }

  throw new Error("图片过大，在不缩小尺寸的前提下压缩质量后仍无法上传");
}

function toCommandPreview(command, maxLength = 140) {
  const normalized = String(command ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isMemoryToolName(toolName) {
  return String(toolName ?? "").trim().startsWith("memory_");
}

function getMemoryToolSummary(toolName) {
  const normalizedToolName = String(toolName ?? "").trim();

  switch (normalizedToolName) {
    case "memory_find_candidates":
      return "已查找记忆候选";
    case "memory_browse":
      return "已浏览长期记忆";
    case "memory_retrieve":
      return "已查看记忆说明";
    case "memory_link_nodes":
      return "已记录记忆关联";
    case "memory_create_topic":
    case "memory_create_content":
    case "memory_create_node":
      return "已写入长期记忆";
    case "memory_update_topic":
    case "memory_update_content":
    case "memory_update_node":
      return "已更新长期记忆";
    case "memory_delete":
      return "已删除长期记忆";
    case "memory_merge_nodes":
      return "已整理长期记忆";
    default:
      return "已处理长期记忆";
  }
}

function getMessageMetaKind(message) {
  return String(message?.meta?.kind ?? message?.meta?.kimd ?? "").trim();
}

function clipOrchestratorText(value, maxLength = 96) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function resolveOrchestratorAgentLabel(agentId) {
  const normalized = String(agentId ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("primary:")) {
    return "主智能体";
  }

  if (normalized.startsWith("subagent:")) {
    return clipOrchestratorText(normalized.split(":")[2] || "子智能体", 28);
  }

  return clipOrchestratorText(normalized, 28);
}

function buildOrchestratorNotice(message) {
  const orchestrator =
    message?.meta?.orchestrator && typeof message.meta.orchestrator === "object"
      ? message.meta.orchestrator
      : {};
  const subtype = String(message?.meta?.subtype ?? orchestrator.subtype ?? "").trim();
  const sourceLabel = resolveOrchestratorAgentLabel(orchestrator.sourceAgentId);
  const targetLabel = resolveOrchestratorAgentLabel(orchestrator.targetAgentId);

  if (subtype === "agent_dispatch") {
    return {
      badge: "调度提醒",
      summary:
        sourceLabel && targetLabel
          ? `${sourceLabel} 向 ${targetLabel} 下发了一条任务提醒`
          : `${targetLabel || sourceLabel || "调度器"} 收到了一条任务提醒`
    };
  }

  if (subtype === "subagent_finish_report") {
    return {
      badge: "完成提醒",
      summary:
        sourceLabel && targetLabel
          ? `${sourceLabel} 向 ${targetLabel} 发回了完成提醒`
          : `${sourceLabel || "子智能体"} 发回了一条完成提醒`
    };
  }

  if (subtype === "agent_report_light" || subtype === "agent_report_full") {
    return {
      badge: "进度提醒",
      summary: `${sourceLabel || "子智能体"} 发来了一条进度提醒`
    };
  }

  return {
    badge: "调度器提醒",
    summary: `${sourceLabel || targetLabel || "调度器"} 产生了一条系统提醒`
  };
}

function formatFileSize(size) {
  const numericSize = Number(size ?? 0);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return "0 B";
  }

  if (numericSize < 1024) {
    return `${numericSize} B`;
  }

  const kb = numericSize / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function clipComposerQueueText(text, maxLength = 90) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "空消息";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function describeQueuedMessage(message = {}) {
  const attachments = Array.isArray(message?.meta?.attachments) ? message.meta.attachments : [];
  const parsedFiles = Array.isArray(message?.meta?.parsedFiles) ? message.meta.parsedFiles : [];
  const parts = [];

  if (attachments.length > 0) {
    parts.push(`${attachments.length} 张图`);
  }

  if (parsedFiles.length > 0) {
    parts.push(`${parsedFiles.length} 个文件`);
  }

  return parts.join(" · ");
}

function getFileBadgeLabel(name, mimeType) {
  const fileName = String(name ?? "").trim();
  const extension = fileName.includes(".")
    ? fileName.split(".").pop()
    : String(mimeType ?? "").split("/").pop();
  const normalized = String(extension ?? "").replace(/[^a-zA-Z0-9]/g, "").trim();

  if (!normalized) {
    return "FILE";
  }

  return normalized.toUpperCase().slice(0, 4);
}

function getImageAttachments(message) {
  const attachments = Array.isArray(message?.meta?.attachments) ? message.meta.attachments : [];
  return attachments.filter((attachment) => {
    const dataUrl = String(attachment?.dataUrl ?? attachment?.url ?? "").trim();
    const mimeType = String(attachment?.mimeType ?? "").trim();
    return dataUrl.length > 0 && mimeType.startsWith("image/");
  });
}

function getParsedFileAttachments(message) {
  const files = Array.isArray(message?.meta?.parsedFiles) ? message.meta.parsedFiles : [];

  return files
    .map((file, index) => ({
      id: String(file?.id ?? `parsed_file_${index}`).trim() || `parsed_file_${index}`,
      name: String(file?.name ?? `文件_${index + 1}`).trim() || `文件_${index + 1}`,
      mimeType: String(file?.mimeType ?? "").trim(),
      extension: String(file?.extension ?? "").trim(),
      size: Number(file?.size ?? 0),
      parseStatus: String(file?.parseStatus ?? "unsupported").trim(),
      note: String(file?.note ?? "").trim(),
      extractedText: String(file?.extractedText ?? "")
    }))
    .filter((file) => file.name.length > 0);
}

function getParsedFileViewerContent(file) {
  const text = String(file?.extractedText ?? "").trim();
  if (text) {
    return text;
  }

  const note = String(file?.note ?? "").trim();
  if (note) {
    return `[未提取文本]\n${note}`;
  }

  return "[未提取文本]\n当前文件未解析出文本内容。";
}

function getParsedFileStatusLabel(file) {
  const parseStatus = String(file?.parseStatus ?? "unsupported").trim();

  if (parseStatus === "parsed") {
    return "已解析";
  }

  if (parseStatus === "empty") {
    return "无文本";
  }

  if (parseStatus === "failed") {
    return "解析失败";
  }

  if (parseStatus === "truncated") {
    return "已截断";
  }

  return "未提取";
}

function readNumericDetail(source, ...keys) {
  if (!source || typeof source !== "object") {
    return 0;
  }

  for (const key of keys) {
    const value = Number(source?.[key] ?? 0);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

function buildTokenBreakdown(tokenUsage) {
  const promptTokens = Number(tokenUsage?.promptTokens ?? 0);
  const completionTokens = Number(tokenUsage?.completionTokens ?? 0);
  const promptDetails =
    tokenUsage?.promptTokensDetails && typeof tokenUsage.promptTokensDetails === "object"
      ? tokenUsage.promptTokensDetails
      : null;
  const completionDetails =
    tokenUsage?.completionTokensDetails && typeof tokenUsage.completionTokensDetails === "object"
      ? tokenUsage.completionTokensDetails
      : null;

  const cachedPromptTokens = readNumericDetail(
    promptDetails,
    "cached_tokens",
    "cache_read_input_tokens",
    "cached_input_tokens"
  );
  const reasoningTokens = readNumericDetail(
    completionDetails,
    "reasoning_tokens",
    "reasoningTokens"
  );
  const visibleOutputTokens = Math.max(0, completionTokens - reasoningTokens);
  const breakdownItems = [
    `输入 ${promptTokens}`
  ];

  if (cachedPromptTokens > 0) {
    breakdownItems.push(`缓存 ${cachedPromptTokens}`);
  }

  breakdownItems.push(`输出 ${completionTokens}`);

  if (reasoningTokens > 0) {
    breakdownItems.push(`思考 ${reasoningTokens}`);
    breakdownItems.push(`正文 ${visibleOutputTokens}`);
  }

  return breakdownItems;
}

function formatReasoningDuration(ms) {
  const totalMs = Math.max(0, Number(ms ?? 0));
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  }

  return `${seconds}秒`;
}

export function ChatPanel({ chat, modelContextWindow = 0, disabled, disabledReason, onNavigate }) {
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isParsingFiles, setIsParsingFiles] = useState(false);
  const [expandedToolMap, setExpandedToolMap] = useState({});
  const [expandedReasoningMap, setExpandedReasoningMap] = useState({});
  const [reasoningNow, setReasoningNow] = useState(() => Date.now());
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [historyPaneOpen, setHistoryPaneOpen] = useState(true);
  const [contextPopupOpen, setContextPopupOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);
  const [viewingFileText, setViewingFileText] = useState(null);
  const [draggedQueueMessageId, setDraggedQueueMessageId] = useState("");
  const [queueDropTarget, setQueueDropTarget] = useState(null);
  const [expandedHistoryGroupMap, setExpandedHistoryGroupMap] = useState({});
  const chatStreamRef = useRef(null);
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const activeConversationIdRef = useRef(String(chat.activeConversationId ?? ""));
  const lastAutoExpandedHistoryConversationIdRef = useRef("");
  const shouldAutoScrollRef = useRef(true);
  const isScrollTrackingReadyRef = useRef(false);
  const contextPopupRef = useRef(null);
  const approvalMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (contextPopupRef.current && !contextPopupRef.current.contains(event.target)) {
        setContextPopupOpen(false);
      }
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(event.target)) {
        setApprovalMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const inputDisabled =
    disabled ||
    !chat.historyLoaded ||
    Boolean(chat.pendingApproval);
  const hasComposerPayload =
    draft.trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0;
  const isComposerActive =
    draft.length > 0 || inputFocused || pendingImages.length > 0 || pendingFiles.length > 0;
  const shouldPrimaryStop = Boolean(chat.canStopStream) && !hasComposerPayload;
  const composerButtonDisabled =
    inputDisabled ||
    isParsingFiles ||
    (!hasComposerPayload && !chat.canStopStream);
  const developerPromptDisabled =
    chat.isStreaming ||
    !chat.historyLoaded ||
    Boolean(chat.pendingApproval) ||
    chat.activeConversationSource === "subagent";
  const placeholder = !chat.historyLoaded
    ? "正在从 SQLite 加载历史..."
    : chat.pendingApproval
      ? "当前有待确认的工具操作"
      : chat.isCompressing
        ? `当前会话压缩中，可继续输入并排队${
            Number(chat.queuedUserMessageCount ?? 0) > 0
              ? `（已排队 ${chat.queuedUserMessageCount} 条）`
              : ""
          }`
      : chat.isStreaming
        ? `可继续输入，消息会排队发送${
            Number(chat.queuedUserMessageCount ?? 0) > 0
              ? `（已排队 ${chat.queuedUserMessageCount} 条）`
              : ""
          }`
      : isParsingFiles
        ? "文件解析中，请稍候发送"
        : disabled
        ? disabledReason
        : "输入消息，观察流式与工具调用";
  const queuedUserMessages = Array.isArray(chat.queuedUserMessages) ? chat.queuedUserMessages : [];
  const isSubagentConversation = String(chat.activeConversationSource ?? "").trim() === "subagent";
  const historyConversationList = Array.isArray(chat.conversationList) ? chat.conversationList : [];
  const thinkingToggleDisabled =
    chat.isStreaming || !chat.historyLoaded || Boolean(chat.pendingApproval);
  const messageDeleteDisabled =
    chat.isStreaming ||
    chat.isCompressing ||
    !chat.historyLoaded ||
    !chat.activeConversationId ||
    Boolean(chat.pendingApproval);
  const activeConversationRuntimeReplyError =
    chat.activeConversationRuntimeReplyError &&
    typeof chat.activeConversationRuntimeReplyError === "object"
      ? chat.activeConversationRuntimeReplyError
      : null;
  const hasInlineRuntimeReplyErrorMessage =
    Boolean(activeConversationRuntimeReplyError?.messageId) &&
    Array.isArray(chat.messages) &&
    chat.messages.some(
      (message) =>
        String(message?.role ?? "").trim() === "assistant" &&
        String(message?.id ?? "").trim() === String(activeConversationRuntimeReplyError?.messageId ?? "").trim()
    );
  const topLevelHistoryIds = useMemo(
    () =>
      new Set(
        historyConversationList
          .filter((item) => String(item?.source ?? "").trim() !== "subagent")
          .map((item) => String(item?.id ?? "").trim())
          .filter(Boolean)
      ),
    [historyConversationList]
  );
  const groupedHistoryList = useMemo(() => {
    const topLevelItems = [];
    const childItemsByParentId = new Map();

    for (const item of historyConversationList) {
      const normalizedSource = String(item?.source ?? "").trim();
      const parentConversationId = String(item?.parentConversationId ?? "").trim();
      if (
        normalizedSource === "subagent" &&
        parentConversationId &&
        topLevelHistoryIds.has(parentConversationId)
      ) {
        const currentChildren = childItemsByParentId.get(parentConversationId) ?? [];
        currentChildren.push(item);
        childItemsByParentId.set(parentConversationId, currentChildren);
        continue;
      }

      topLevelItems.push(item);
    }

    return {
      topLevelItems,
      childItemsByParentId
    };
  }, [historyConversationList, topLevelHistoryIds]);
  const activeHistoryConversation = useMemo(
    () =>
      historyConversationList.find(
        (item) => String(item?.id ?? "").trim() === String(chat.activeConversationId ?? "").trim()
      ) ?? null,
    [historyConversationList, chat.activeConversationId]
  );
  const activeHistoryGroupId = useMemo(() => {
    const activeConversationId = String(activeHistoryConversation?.id ?? "").trim();
    if (!activeConversationId) {
      return "";
    }

    if (String(activeHistoryConversation?.source ?? "").trim() === "subagent") {
      return String(activeHistoryConversation?.parentConversationId ?? "").trim() || activeConversationId;
    }

    return activeConversationId;
  }, [activeHistoryConversation]);
  function resetQueueDragState() {
    setDraggedQueueMessageId("");
    setQueueDropTarget(null);
  }

  function toggleHistoryGroup(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    setExpandedHistoryGroupMap((prev) => ({
      ...prev,
      [normalizedConversationId]: !prev?.[normalizedConversationId]
    }));
  }

  function resolveQueueDropPosition(event) {
    const currentTarget = event.currentTarget;
    if (!currentTarget || typeof currentTarget.getBoundingClientRect !== "function") {
      return "before";
    }

    const rect = currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    return event.clientY >= midpoint ? "after" : "before";
  }

  function handleQueueDragStart(event, messageId) {
    const normalizedMessageId = String(messageId ?? "").trim();
    if (!normalizedMessageId) {
      return;
    }

    setDraggedQueueMessageId(normalizedMessageId);
    setQueueDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", normalizedMessageId);
  }

  function handleQueueDragOver(event, targetMessageId) {
    const normalizedTargetMessageId = String(targetMessageId ?? "").trim();
    if (!draggedQueueMessageId || !normalizedTargetMessageId) {
      return;
    }

    event.preventDefault();
    const position = resolveQueueDropPosition(event);
    setQueueDropTarget({
      messageId: normalizedTargetMessageId,
      position
    });
    event.dataTransfer.dropEffect = "move";
  }

  function handleQueueDrop(event, targetMessageId) {
    event.preventDefault();
    const normalizedTargetMessageId = String(targetMessageId ?? "").trim();
    const sourceMessageId =
      draggedQueueMessageId || String(event.dataTransfer.getData("text/plain") ?? "").trim();
    if (!sourceMessageId || !normalizedTargetMessageId) {
      resetQueueDragState();
      return;
    }

    const position = resolveQueueDropPosition(event);
    chat.reorderQueuedUserMessages(sourceMessageId, normalizedTargetMessageId, position);
    resetQueueDragState();
  }

  useEffect(() => {
    activeConversationIdRef.current = String(chat.activeConversationId ?? "");
  }, [chat.activeConversationId]);

  useEffect(() => {
    const activeConversationId = String(chat.activeConversationId ?? "").trim();
    const normalizedGroupId = String(activeHistoryGroupId ?? "").trim();
    const isSubagentActive = String(activeHistoryConversation?.source ?? "").trim() === "subagent";

    if (!activeConversationId || !normalizedGroupId || !isSubagentActive) {
      lastAutoExpandedHistoryConversationIdRef.current = activeConversationId;
      return;
    }

    if (lastAutoExpandedHistoryConversationIdRef.current === activeConversationId) {
      return;
    }

    lastAutoExpandedHistoryConversationIdRef.current = activeConversationId;
    setExpandedHistoryGroupMap((prev) =>
      prev?.[normalizedGroupId]
        ? prev
        : {
            ...prev,
            [normalizedGroupId]: true
          }
    );
  }, [activeHistoryConversation, activeHistoryGroupId, chat.activeConversationId]);

  useEffect(() => {
    setExpandedToolMap({});
    setExpandedReasoningMap({});
    setPendingImages([]);
    setPendingFiles([]);
    setIsParsingFiles(false);
    setViewingImage(null);
    setViewingFileText(null);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    resetQueueDragState();
  }, [chat.activeConversationId]);

  useEffect(() => {
    if (queuedUserMessages.length === 0) {
      resetQueueDragState();
    }
  }, [queuedUserMessages.length]);

  useEffect(() => {
    const hasActiveReasoning = Array.isArray(chat.messages)
      ? chat.messages.some((message) => {
          const startedAt = Number(message?.reasoningStartedAt ?? 0);
          const finishedAt = Number(message?.reasoningFinishedAt ?? 0);
          return startedAt > 0 && finishedAt <= 0;
        })
      : false;

    if (!hasActiveReasoning) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setReasoningNow(Date.now());
    }, 250);

    return () => {
      window.clearInterval(timerId);
    };
  }, [chat.messages]);

  useEffect(() => {
    setPromptDrawerOpen(false);
  }, [chat.activeConversationId]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.style.height = "0px";
    const nextHeight = Math.min(input.scrollHeight, 180);
    input.style.height = `${Math.max(nextHeight, 52)}px`;
  }, [draft, chat.activeConversationId]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    isScrollTrackingReadyRef.current = false;
  }, [chat.activeConversationId]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      return;
    }

    const stream = chatStreamRef.current;
    if (!stream) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
      isScrollTrackingReadyRef.current = true;
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [chat.messages, chat.activeConversationId, chat.isStreaming]);

  const selectedSkillItems = useMemo(() => {
    const selectedKeys = Array.isArray(chat.activeConversationSkills)
      ? chat.activeConversationSkills
          .map((skillKey) => String(skillKey ?? "").trim())
          .filter(Boolean)
      : [];
    const catalog = Array.isArray(chat.skillCatalog) ? chat.skillCatalog : [];
    const normalizedCatalog = new Map(
      catalog.map((skill) => [
        String(skill.skillKey || skill.relativePath || skill.name || "").trim(),
        skill
      ])
    );

    return selectedKeys
      .map((skillKey) => {
        const match = normalizedCatalog.get(skillKey);
        if (!match) {
          return {
            key: skillKey,
            label: skillKey
          };
        }

        return {
          key: match.skillKey || match.relativePath || match.name || skillKey,
          label: match.displayName || match.name || skillKey
        };
      })
      .filter((item) => item.key.length > 0);
  }, [chat.activeConversationSkills, chat.skillCatalog]);

  const maxContextWindow = Number(modelContextWindow ?? 0);
  const latestTokenTotal = Number(chat.activeConversationContextTokens ?? 0);
  const contextWindowUsageRatio =
    maxContextWindow > 0 ? Math.min(1, latestTokenTotal / maxContextWindow) : 0;
  const contextWindowUsagePercent = Math.round(contextWindowUsageRatio * 100);
  const contextWindowRemainder = maxContextWindow > 0 ? maxContextWindow - latestTokenTotal : 0;

  function toggleToolResult(messageId) {
    setExpandedToolMap((prev) => ({
      ...prev,
      [messageId]: !prev[messageId]
    }));
  }

  function toggleReasoningResult(messageId) {
    setExpandedReasoningMap((prev) => ({
      ...prev,
      [messageId]: !prev[messageId]
    }));
  }

  function toggleSkill(skillName) {
    const normalizedSkillName = String(skillName ?? "").trim();
    if (!normalizedSkillName) {
      return;
    }

    const current = Array.isArray(chat.activeConversationSkills)
      ? chat.activeConversationSkills
      : [];
    const next = current.includes(normalizedSkillName)
      ? current.filter((item) => item !== normalizedSkillName)
      : [...current, normalizedSkillName];

    chat.setConversationSkills(next);
  }

  function handleDeveloperPromptChange(event) {
    chat.setConversationDeveloperPrompt(event.target.value);
  }

  function handleDraftChange(event) {
    setDraft(event.target.value);
  }

  function clearPendingImages() {
    setPendingImages([]);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  function clearPendingFiles() {
    setPendingFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function removePendingImage(imageId) {
    const normalizedId = String(imageId ?? "").trim();
    if (!normalizedId) {
      return;
    }

    setPendingImages((prev) => prev.filter((image) => String(image?.id ?? "").trim() !== normalizedId));

    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  function removePendingFile(fileId) {
    const normalizedId = String(fileId ?? "").trim();
    if (!normalizedId) {
      return;
    }

    setPendingFiles((prev) => prev.filter((file) => String(file?.id ?? "").trim() !== normalizedId));

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleImagePickerClick() {
    if (inputDisabled) {
      return;
    }

    imageInputRef.current?.click();
  }

  function handleFilePickerClick() {
    if (inputDisabled || isParsingFiles) {
      return;
    }

    fileInputRef.current?.click();
  }

  function handleImageChange(event) {
    const files = Array.from(event.target.files ?? []).filter((file) =>
      String(file?.type ?? "").startsWith("image/")
    );
    if (files.length === 0) {
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
      return;
    }

    Promise.allSettled(
      files.map((file, index) =>
        compressImagePreserveDimensions(file).then((compressedImage) => {
          if (!compressedImage?.dataUrl) {
            throw new Error("图片压缩失败");
          }

          return {
            id: `pending_image_${Date.now()}_${index}`,
            type: "image",
            name: String(file.name ?? "").trim(),
            mimeType: String(compressedImage.mimeType ?? file.type ?? "image/png").trim(),
            dataUrl: compressedImage.dataUrl,
            size: Number(compressedImage.size ?? file.size ?? 0)
          };
        })
      )
    )
      .then((results) => {
        const nextImages = results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value);
        const failedCount = results.length - nextImages.length;

        if (nextImages.length > 0) {
          setPendingImages((prev) => [...prev, ...nextImages]);
        }

        if (failedCount > 0) {
          window.alert(`${failedCount} 张图片因体积过大，未能加入本次消息`);
        }
      })
      .catch(() => {
        window.alert("图片过大，在不缩小尺寸的前提下压缩质量后仍无法上传");
      })
      .finally(() => {
        if (imageInputRef.current) {
          imageInputRef.current.value = "";
        }
      });
  }

  async function handleFileChange(event) {
    const files = Array.from(event.target.files ?? []);

    if (files.length === 0) {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const nonImageFiles = files.filter(
      (file) => !String(file?.type ?? "").toLowerCase().startsWith("image/")
    );

    if (nonImageFiles.length === 0) {
      window.alert("请使用文件按钮选择文档类文件，图片请使用图片按钮上传。");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const remainingSlots = Math.max(0, MAX_UPLOAD_FILE_COUNT - pendingFiles.length);
    if (remainingSlots <= 0) {
      window.alert(`每次最多上传 ${MAX_UPLOAD_FILE_COUNT} 个文件，请先移除部分文件。`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const selectedNow = [];
    const invalidSizeFiles = [];

    for (const file of nonImageFiles) {
      const size = Number(file?.size ?? 0);
      if (size > MAX_UPLOAD_FILE_SIZE_BYTES) {
        invalidSizeFiles.push(String(file?.name ?? "未知文件"));
        continue;
      }

      selectedNow.push({
        file
      });
    }

    if (invalidSizeFiles.length > 0) {
      window.alert(`${invalidSizeFiles.length} 个文件超过 20MB，已忽略。`);
    }

    const filesToParse = selectedNow.slice(0, remainingSlots).map((item) => item.file).filter(Boolean);
    if (selectedNow.length > filesToParse.length) {
      window.alert(`每次最多上传 ${MAX_UPLOAD_FILE_COUNT} 个文件，已自动截断。`);
    }

    if (filesToParse.length === 0) {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const parsingConversationId = activeConversationIdRef.current;
    setIsParsingFiles(true);

    try {
      const response = await parseChatFiles(filesToParse);
      if (activeConversationIdRef.current !== parsingConversationId) {
        return;
      }

      const parsedFiles = Array.isArray(response?.files) ? response.files : [];
      const normalizedFiles = parsedFiles
        .map((file, index) => ({
          id: String(file?.id ?? `pending_file_${Date.now()}_${index}`).trim() || `pending_file_${Date.now()}_${index}`,
          name: String(file?.name ?? `未命名文件_${index + 1}`).trim() || `未命名文件_${index + 1}`,
          mimeType: String(file?.mimeType ?? "").trim(),
          extension: String(file?.extension ?? "").trim(),
          size: Number(file?.size ?? 0),
          parseStatus: String(file?.parseStatus ?? "unsupported").trim() || "unsupported",
          note: String(file?.note ?? "").trim(),
          extractedText: String(file?.extractedText ?? "")
        }))
        .filter((file) => file.name.length > 0);

      setPendingFiles((prev) => [...prev, ...normalizedFiles].slice(0, MAX_UPLOAD_FILE_COUNT));
    } catch (error) {
      if (activeConversationIdRef.current === parsingConversationId) {
        window.alert(error?.message || "文件解析失败");
      }
    } finally {
      if (activeConversationIdRef.current === parsingConversationId) {
        setIsParsingFiles(false);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleChatStreamScroll(event) {
    if (!isScrollTrackingReadyRef.current) {
      return;
    }

    const stream = event.currentTarget;
    const distanceToBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    shouldAutoScrollRef.current = distanceToBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;
  }

  async function handleSend(event) {
    event.preventDefault();

    const message = draft.trim();
    if (
      (!message && pendingImages.length === 0 && pendingFiles.length === 0) ||
      inputDisabled ||
      isParsingFiles
    ) {
      return;
    }

    setDraft("");
    const imageAttachments = [...pendingImages];
    const parsedFileAttachments = pendingFiles.map((item) => ({ ...item }));
    clearPendingImages();
    clearPendingFiles();
    await chat.sendMessage({
      text: message,
      imageAttachments,
      parsedFileAttachments
    });
  }

  return (
    <div className="module chat-module">
      <div className="chat-workspace">
        <aside className="history-pane" style={{ display: historyPaneOpen ? 'flex' : 'none' }}>
          <div className="history-pane-head">
            <h3>历史记录</h3>
            <button
              type="button"
              className="history-create"
              onClick={chat.createConversation}
              disabled={chat.isStreaming || !chat.historyLoaded}
            >
              新建
            </button>
          </div>

          <div className="history-list">
            {!chat.historyLoaded && <p className="empty-note">正在加载历史...</p>}

            {chat.historyLoaded && groupedHistoryList.topLevelItems.length === 0 && (
              <p className="empty-note">暂无历史会话</p>
            )}

            {groupedHistoryList.topLevelItems.map((item) => {
              const childItems = groupedHistoryList.childItemsByParentId.get(String(item.id ?? "").trim()) ?? [];
              const hasChildren = childItems.length > 0;
              const isParentActive = String(item.id ?? "").trim() === String(chat.activeConversationId ?? "").trim();
              const containsActiveChild = childItems.some(
                (child) => String(child?.id ?? "").trim() === String(chat.activeConversationId ?? "").trim()
              );
              const normalizedItemId = String(item.id ?? "").trim();
              const isExpanded =
                !hasChildren || Boolean(expandedHistoryGroupMap?.[normalizedItemId]);

              return (
                <article
                  key={item.id}
                  className={`history-group ${isExpanded ? "history-group-expanded" : ""}`}
                >
                  <div
                    className={`history-item ${
                      isParentActive ? "history-item-active" : containsActiveChild ? "history-item-contains-active" : ""
                    } ${hasChildren ? "history-item-has-children" : ""}`}
                  >
                    <button
                      type="button"
                      className="history-item-main"
                      onClick={() => chat.loadConversation(item.id)}
                    >
                      <div className="history-item-top">
                        <strong>{item.title || "未命名会话"}</strong>
                        <div className="history-item-meta">
                          {String(item.source ?? "").trim() === "subagent" ? (
                            <span className="history-item-badge">
                              {item.agentDisplayName || "子智能体"}
                            </span>
                          ) : String(item.source ?? "").trim() === "fork" ? (
                            <span className="history-item-badge">Fork</span>
                          ) : hasChildren ? (
                            <span className="history-item-badge">子智能体 {childItems.length}</span>
                          ) : null}
                          {Boolean(item.agentBusy) && (
                            <span className="history-item-badge">运行中</span>
                          )}
                          <span>{formatTimestamp(item.updatedAt)}</span>
                        </div>
                      </div>
                      <p>{item.preview || "暂无内容"}</p>
                    </button>

                    {hasChildren && (
                      <button
                        type="button"
                        className={`history-item-toggle ${isExpanded ? "is-expanded" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleHistoryGroup(item.id);
                        }}
                        aria-label={isExpanded ? "收起子智能体对话" : "展开子智能体对话"}
                        title={isExpanded ? "收起子智能体对话" : "展开子智能体对话"}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                          <path strokeLinecap="round" strokeLinejoin="round" d="m9 6l6 6l-6 6" />
                        </svg>
                      </button>
                    )}

                    <div className="history-item-actions">
                      {String(item.source ?? "").trim() !== "subagent" && (
                        <button
                          type="button"
                          className="history-item-fork"
                          onClick={() => chat.forkConversation(item.id)}
                          disabled={chat.isStreaming}
                          aria-label="Fork 该历史"
                        >
                          Fork
                        </button>
                      )}
                      <button
                        type="button"
                        className="history-item-delete"
                        onClick={() => chat.deleteConversation(item.id)}
                        disabled={chat.isStreaming || chat.isCompressing}
                        aria-label="删除该历史"
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {hasChildren && isExpanded && (
                    <div className="history-subitem-list">
                      {childItems.map((child) => {
                        const isChildActive =
                          String(child?.id ?? "").trim() === String(chat.activeConversationId ?? "").trim();
                        return (
                          <article
                            key={child.id}
                            className={`history-subitem ${isChildActive ? "history-subitem-active" : ""}`}
                          >
                            <button
                              type="button"
                              className="history-subitem-main"
                              onClick={() => chat.loadConversation(child.id)}
                            >
                              <div className="history-item-top">
                                <strong>{child.title || child.agentDisplayName || "子智能体对话"}</strong>
                                <div className="history-item-meta">
                                  <span className="history-item-badge">
                                    {child.agentDisplayName || child.agentType || "子智能体"}
                                  </span>
                                  {Boolean(child.agentBusy) && (
                                    <span className="history-item-badge">运行中</span>
                                  )}
                                  <span>{formatTimestamp(child.updatedAt)}</span>
                                </div>
                              </div>
                              <p>{child.preview || "暂无内容"}</p>
                            </button>

                            <div className="history-subitem-actions">
                              <button
                                type="button"
                                className="history-item-delete"
                                onClick={() => chat.deleteConversation(child.id)}
                                disabled={chat.isStreaming || chat.isCompressing}
                                aria-label="删除该子智能体历史"
                              >
                                删除
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

        </aside>

        <section className="chat-pane">
          <div className="chat-pane-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={() => setHistoryPaneOpen((prev) => !prev)}
                  title="切换会话记录"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.2rem',
                    borderRadius: '4px',
                    color: 'var(--text-muted)'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg-active)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
                <h3>{chat.activeConversationTitle || "当前会话"}</h3>
                {isSubagentConversation && (
                  <span className="history-item-badge">
                    {chat.activeConversationAgentDisplayName || "子智能体"}
                  </span>
                )}
              </div>
            <div className="chat-pane-head-right">
              <div className="chat-mode-switch">
                <button
                  type="button"
                  className={`mode-pill skills-toggle ${promptDrawerOpen ? "active" : ""}`}
                  onClick={() => {
                    setPromptDrawerOpen((prev) => !prev);
                  }}
                  disabled={!chat.historyLoaded}
                >
                  Developer Prompt
                </button>
                <button
                  type="button"
                  className="mode-pill skills-toggle"
                  onClick={() => onNavigate('skills')}
                >
                  Skills
                </button>
              </div>

              <div className="chat-skill-chips">
                <span className="chat-skill-chip is-more" style={{ cursor: 'pointer' }} onClick={() => onNavigate('skills')}>
                  已启用技能: {selectedSkillItems.length} / {Array.isArray(chat?.skillCatalog) ? chat.skillCatalog.length : 0}
                </span>
              </div>
            </div>
          </div>

          {promptDrawerOpen && (
            <section className="chat-developer-panel">
              <div className="chat-developer-panel-head">
                <div>
                  <h3>Developer 提示词</h3>
                  <p>
                    {isSubagentConversation
                      ? "子智能体使用类型定义的固定 prompt，这里只读展示。"
                      : "当前会话独立保存，修改后会热更新到下一次请求。"}
                  </p>
                </div>
                <span className="chat-developer-panel-badge">
                  {isSubagentConversation
                    ? "固定"
                    : chat.activeConversationDeveloperPrompt
                      ? "已配置"
                      : "未配置"}
                </span>
              </div>
              <textarea
                className="chat-developer-input"
                value={chat.activeConversationDeveloperPrompt || ""}
                onChange={handleDeveloperPromptChange}
                placeholder={
                  isSubagentConversation
                    ? "子智能体 prompt 由定义文件决定。"
                    : "为当前会话写入 developer 指令，例如角色、边界、输出格式或禁忌。"
                }
                disabled={developerPromptDisabled}
                rows={4}
              />
            </section>
          )}

          <div className="chat-workplace-row">
            <div className="chat-workplace-meta">
              <span className="chat-workplace-label">当前工作区</span>
              <span className="chat-workplace-path">
                {chat.activeConversationWorkplace || "未设置"}
              </span>
              <span
                className={`chat-workplace-badge ${
                  chat.activeConversationWorkplaceLocked ? "is-locked" : "is-open"
                }`}
              >
                {chat.activeConversationWorkplaceLocked ? "已固定" : "首条消息后固定"}
              </span>
              <span className="chat-workplace-badge is-open">
                {chat.activeConversationApprovalMode === "auto" ? "自动审批" : "确认审批"}
              </span>
            </div>

            <button
              type="button"
              className="workplace-open"
              onClick={chat.openWorkplaceBrowser}
              disabled={
                chat.isStreaming ||
                chat.isCompressing ||
                !chat.historyLoaded ||
                !chat.activeConversationId ||
                chat.activeConversationWorkplaceLocked ||
                chat.workplaceSelecting
              }
            >
              {chat.workplaceSelecting ? "打开中..." : "选择目录"}
            </button>
          </div>

          <div
            ref={chatStreamRef}
            className="chat-stream"
            onScroll={handleChatStreamScroll}
          >
            {chat.messages.length === 0 && !activeConversationRuntimeReplyError && (
              <div className="empty-note">发送第一条消息后，这里显示完整会话历史。</div>
            )}

            {chat.messages.map((message, index) => {
              const isLastMessage = index === chat.messages.length - 1;
              const isStreamingThisMessage = isLastMessage && chat.isStreaming && message.role === "assistant";
              const messageMetaKind = getMessageMetaKind(message);
              const isInternalToolImageMessage = messageMetaKind === "tool_image_input";
              const isOrchestratorMessage = messageMetaKind === "orchestrator_message";
              const imageAttachments = getImageAttachments(message);
              const parsedFileAttachments = getParsedFileAttachments(message);
              const messageText = String(message.content ?? "").trim();
              const isAttachmentOnlyUserMessage =
                message.role === "user" &&
                messageText.length === 0 &&
                ((imageAttachments.length > 0 && parsedFileAttachments.length === 0) ||
                  (parsedFileAttachments.length > 0 && imageAttachments.length === 0));
              const toolPayload =
                message.role === "tool"
                  ? message.meta?.kind === "tool_event"
                    ? message.meta
                    : parseToolMessagePayload(message.content)
                  : null;
              const isCompressionSummary =
                String(message?.meta?.kind ?? "").trim() === "compression_summary";
              const shouldHideAssistantToolCall =
                message.role === "assistant" &&
                Array.isArray(message.toolCalls) &&
                message.toolCalls.length > 0 &&
                !String(message.content ?? "").trim() &&
                !String(message.reasoningContent ?? "").trim();
              const isToolCard = Boolean(toolPayload);
              const isMemoryToolCard = isToolCard && isMemoryToolName(toolPayload.toolName);
              const toolHooks =
                toolPayload && Array.isArray(toolPayload.hooks) ? toolPayload.hooks : [];
              const isExpanded = Boolean(expandedToolMap[message.id]);
              const hasReasoningContent = String(message.reasoningContent ?? "").trim().length > 0;
              const reasoningStartedAt = Number(message.reasoningStartedAt ?? 0);
              const reasoningFinishedAt = Number(message.reasoningFinishedAt ?? 0);
              const reasoningDurationMs =
                reasoningStartedAt > 0
                  ? Math.max(
                      0,
                      (reasoningFinishedAt > 0 ? reasoningFinishedAt : reasoningNow) - reasoningStartedAt
                    )
                  : 0;
              const isReasoningExpanded =
                Boolean(expandedReasoningMap[message.id]) ||
                (hasReasoningContent && !String(message.content ?? "").trim());
              const runtimeReplyErrorForMessage =
                message.role === "assistant" &&
                String(activeConversationRuntimeReplyError?.messageId ?? "").trim() === String(message.id ?? "").trim()
                  ? activeConversationRuntimeReplyError
                  : null;
              const orchestratorNotice = isOrchestratorMessage ? buildOrchestratorNotice(message) : null;
              const deleteButton = (
                <button
                  type="button"
                  className="bubble-delete-button"
                  onClick={() => chat.deleteMessage(message.id)}
                  disabled={messageDeleteDisabled}
                  aria-label="删除该消息"
                  title="删除该消息"
                >
                  删除
                </button>
              );

              if (shouldHideAssistantToolCall) {
                return null;
              }

              return (
                <article
                  key={message.id}
                  className={`bubble ${
                    isOrchestratorMessage ? "bubble-orchestrator-note" : `bubble-${message.role}`
                  } ${isCompressionSummary ? "bubble-compression" : ""} ${
                    isMemoryToolCard ? "bubble-memory-tool" : ""
                  } ${isAttachmentOnlyUserMessage ? "bubble-user-attachment-only" : ""} ${
                    isAttachmentOnlyUserMessage ? "bubble-attachment-only" : ""
                  } ${isInternalToolImageMessage ? "bubble-tool-image-input" : ""} ${
                    isStreamingThisMessage ? "is-streaming" : ""
                  }`}
                >
                  {!isMemoryToolCard && !isOrchestratorMessage && (
                    <header>
                      <strong>
                        {isInternalToolImageMessage && "Tool Image Input"}
                        {message.role === "user" && !isInternalToolImageMessage && "User"}
                        {message.role === "assistant" && (isCompressionSummary ? "Compression" : "Assistant")}
                        {message.role === "tool" && "Tool"}
                        {message.role === "system" && "System"}
                      </strong>
                      {isInternalToolImageMessage && (
                        <span className="bubble-meta-badge is-tool-image-input">自动注入</span>
                      )}
                      {typeof message.timestamp === "number" && (
                        <span>{formatTimestamp(message.timestamp)}</span>
                      )}
                      {!isToolCard && deleteButton}
                    </header>
                  )}

                  {isCompressionSummary ? (
                    <div className="compression-card-content">
                      <p className="compression-card-title">上下文压缩节点</p>
                      <MarkdownMessage content={message.content || ""} className="bubble-content" />
                    </div>
                  ) : isOrchestratorMessage ? (
                    <div className="orchestrator-note-card">
                      <div className="orchestrator-note-main">
                        <span className="orchestrator-note-badge">{orchestratorNotice.badge}</span>
                        <p className="orchestrator-note-summary">{orchestratorNotice.summary}</p>
                      </div>
                      <div className="orchestrator-note-meta">
                        {typeof message.timestamp === "number" && (
                          <span>{formatTimestamp(message.timestamp)}</span>
                        )}
                        {deleteButton}
                      </div>
                    </div>
                  ) : isMemoryToolCard ? (
                    <div className="memory-tool-strip">
                      <div className="memory-tool-strip-main">
                        <span className="memory-tool-strip-text">
                          {getMemoryToolSummary(toolPayload.toolName)}
                        </span>
                        {typeof message.timestamp === "number" && (
                          <span className="memory-tool-strip-time">
                            {formatTimestamp(message.timestamp)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="memory-tool-strip-expand"
                          onClick={() => toggleToolResult(message.id)}
                        >
                          {isExpanded ? "收起" : "详情"}
                        </button>
                        {deleteButton}
                      </div>

                      {isExpanded && (
                        <pre
                          className={`tool-result-body memory-tool-result-body ${
                            toolPayload.isError ? "is-error" : ""
                          }`}
                        >
                          {toolPayload.result || "暂无响应"}
                        </pre>
                      )}
                    </div>
                  ) : isToolCard ? (
                    <div className="tool-card-content">
                      <p className="tool-call-title">调用工具：{toolPayload.toolName}</p>

                      {toolPayload.command && (
                        <p className="tool-command-line" title={toolPayload.command}>
                          命令：{toCommandPreview(toolPayload.command)}
                        </p>
                      )}

                      <div className="tool-card-actions">
                      <span
                        className={`tool-status ${
                          toolPayload.approvalStatus === "pending_approval"
                            ? "is-pending"
                            : toolPayload.isError
                              ? "is-error"
                              : toolPayload.result
                                ? "is-success"
                                : "is-pending"
                        }`}
                      >
                        {toolPayload.approvalStatus === "pending_approval"
                          ? "等待确认"
                          : toolPayload.isError
                            ? "执行失败"
                            : toolPayload.result
                              ? "执行完成"
                              : "执行中"}
                        </span>

                        <button
                          type="button"
                          className="tool-expand"
                          onClick={() => toggleToolResult(message.id)}
                        >
                          {isExpanded ? "收起响应" : "展开响应"}
                        </button>
                        {deleteButton}
                      </div>

                      {isExpanded && (
                        <pre
                          className={`tool-result-body ${
                            toolPayload.isError ? "is-error" : ""
                          }`}
                        >
                          {toolPayload.result || "暂无响应"}
                        </pre>
                      )}

                      {toolHooks.length > 0 && (
                        <div className="tool-hooks" aria-label="工具提示">
                          {toolHooks.map((hook) => (
                            <div
                              key={hook.id}
                              className={`tool-hook tool-hook-${hook.level || "hint"}`}
                            >
                              <span className="tool-hook-badge">
                                {hook.level === "warning"
                                  ? "提示"
                                  : hook.level === "info"
                                    ? "信息"
                                    : "建议"}
                              </span>
                              <span className="tool-hook-text">{hook.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {hasReasoningContent && (
                        <div className="assistant-reasoning-card">
                          <button
                            type="button"
                            className={`assistant-reasoning-toggle ${
                              isReasoningExpanded ? "is-open" : ""
                            }`}
                            onClick={() => toggleReasoningResult(message.id)}
                          >
                            <span className="assistant-reasoning-label">
                              思考过程
                              {reasoningDurationMs > 0 && (
                                <small>{formatReasoningDuration(reasoningDurationMs)}</small>
                              )}
                            </span>
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                            </svg>
                          </button>

                          {isReasoningExpanded && (
                            <div className="assistant-reasoning-body">
                              <MarkdownMessage
                                content={message.reasoningContent || ""}
                                className="bubble-content"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {messageText.length > 0 && (
                        <MarkdownMessage content={message.content || ""} className="bubble-content" />
                      )}
                      {imageAttachments.length > 0 && (
                        <div
                          className={`message-image-grid ${
                            isAttachmentOnlyUserMessage ? "is-large" : ""
                          }`}
                        >
                          {imageAttachments.slice(0, 3).map((attachment) => (
                            <img
                              key={String(attachment.id ?? attachment.dataUrl)}
                              src={String(attachment.dataUrl ?? attachment.url ?? "")}
                              alt={String(attachment.name ?? "图片")}
                              className="message-image-thumb clickable"
                              onClick={() => setViewingImage(String(attachment.dataUrl ?? attachment.url ?? ""))}
                            />
                          ))}
                          {imageAttachments.length > 3 && (
                            <div className="message-image-more">
                              +{imageAttachments.length - 3}
                            </div>
                          )}
                        </div>
                      )}

                      {parsedFileAttachments.length > 0 && (
                        <div
                          className={`message-file-grid ${
                            isAttachmentOnlyUserMessage ? "is-large" : ""
                          }`}
                        >
                          {parsedFileAttachments.slice(0, 3).map((file) => (
                            <button
                              key={file.id}
                              type="button"
                              className="message-file-thumb clickable"
                              title={file.name}
                              onClick={() =>
                                setViewingFileText({
                                  name: file.name,
                                  mimeType: file.mimeType || file.extension || "unknown",
                                  size: file.size,
                                  content: getParsedFileViewerContent(file)
                                })
                              }
                            >
                              <span className="message-file-ext">
                                {getFileBadgeLabel(file.name, file.mimeType)}
                              </span>
                              <small className="message-file-name">{file.name}</small>
                            </button>
                          ))}

                          {parsedFileAttachments.length > 3 && (
                            <div className="message-file-more">
                              +{parsedFileAttachments.length - 3}
                            </div>
                          )}
                        </div>
                      )}

                      {message.role === "assistant" && message.tokenUsage && (
                        <footer className="assistant-token-footer">
                          <span>本轮用量 {message.tokenUsage.totalTokens} tokens</span>
                          {buildTokenBreakdown(message.tokenUsage).map((item) => (
                            <span key={`${message.id}-${item}`}>{item}</span>
                          ))}
                        </footer>
                      )}
                      {runtimeReplyErrorForMessage && (
                        <div className="assistant-runtime-error">
                          <strong>本次运行报错</strong>
                          <p>{runtimeReplyErrorForMessage.message}</p>
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}

            {activeConversationRuntimeReplyError && !hasInlineRuntimeReplyErrorMessage && (
              <article className="bubble bubble-assistant bubble-runtime-error-only">
                <header>
                  <strong>Assistant</strong>
                  {typeof activeConversationRuntimeReplyError.createdAt === "number" && (
                    <span>{formatTimestamp(activeConversationRuntimeReplyError.createdAt)}</span>
                  )}
                </header>
                <div className="assistant-runtime-error">
                  <strong>本次运行报错</strong>
                  <p>{activeConversationRuntimeReplyError.message}</p>
                </div>
              </article>
            )}

            {chat.isCompressing && chat.messages.length > 0 && (
              <article className="bubble bubble-system bubble-compression-pending">
                <header>
                  <strong>Compression</strong>
                  <span>处理中</span>
                </header>
                <div className="compression-pending-body">
                  <span className="compression-pending-dot" />
                  正在整理历史并生成结构化 handoff 摘要
                </div>
              </article>
            )}
          </div>

          <form className="chat-input-row" onSubmit={handleSend}>
            {queuedUserMessages.length > 0 && (
              <div className="composer-queue composer-queue-above" aria-label="待发送队列">
                <div className="composer-queue-head">
                  <strong>待发送队列</strong>
                  <span>{queuedUserMessages.length} 条</span>
                </div>

                <div className="composer-queue-list">
                  {queuedUserMessages.map((queueItem, index) => {
                    const queuedMessage = queueItem?.message ?? {};
                    const queuedSummary = describeQueuedMessage(queuedMessage);

                    return (
                      <div
                        key={String(queueItem?.messageId ?? `queued_${index}`)}
                        className={`composer-queue-item ${
                          draggedQueueMessageId === String(queueItem?.messageId ?? "").trim()
                            ? "is-dragging"
                            : ""
                        } ${
                          queueDropTarget?.messageId === String(queueItem?.messageId ?? "").trim()
                            ? queueDropTarget.position === "after"
                              ? "is-drop-after"
                              : "is-drop-before"
                            : ""
                        }`}
                        draggable
                        onDragStart={(event) => handleQueueDragStart(event, queueItem?.messageId)}
                        onDragOver={(event) => handleQueueDragOver(event, queueItem?.messageId)}
                        onDrop={(event) => handleQueueDrop(event, queueItem?.messageId)}
                        onDragEnd={resetQueueDragState}
                      >
                        <div className="composer-queue-index">{index + 1}</div>
                        <div className="composer-queue-main">
                          <strong title={String(queuedMessage?.content ?? queuedSummary ?? "").trim()}>
                            {clipComposerQueueText(queuedMessage?.content || queuedSummary || "空消息")}
                          </strong>
                          <span>
                            {queuedSummary || "文本消息"}
                            {typeof queueItem?.queuedAt === "number"
                              ? ` · ${formatTimestamp(queueItem.queuedAt)}`
                              : ""}
                          </span>
                        </div>
                        <div className="composer-queue-actions">
                          <span className="composer-queue-handle" aria-hidden="true" title="拖动排序">
                            ⋮⋮
                          </span>
                        <button
                          type="button"
                          className="composer-queue-remove"
                          onClick={() => chat.removeQueuedUserMessage(queueItem?.messageId)}
                          aria-label="移除排队消息"
                          title="移除排队消息"
                        >
                          移除
                        </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {pendingFiles.length > 0 && (
              <div className="composer-file-preview composer-file-preview-above">
                {pendingFiles.length > 3 && (
                  <div className="composer-file-preview-item composer-file-preview-more" aria-hidden="true">
                    +{pendingFiles.length - 3}
                  </div>
                )}

                {pendingFiles.slice(0, 3).map((pendingFile) => (
                  <div key={pendingFile.id} className="composer-file-preview-item">
                    <button
                      type="button"
                      className="composer-file-preview-open"
                      title={`${pendingFile.name} · ${getParsedFileStatusLabel(pendingFile)}`}
                      onClick={() =>
                        setViewingFileText({
                          name: pendingFile.name,
                          mimeType: pendingFile.mimeType || pendingFile.extension || "unknown",
                          size: pendingFile.size,
                          content: getParsedFileViewerContent(pendingFile)
                        })
                      }
                    >
                      <div className="composer-file-preview-surface" aria-hidden="true">
                        <span>{getFileBadgeLabel(pendingFile.name, pendingFile.mimeType)}</span>
                      </div>
                      <div className="composer-file-preview-main">
                        <strong title={pendingFile.name}>{pendingFile.name}</strong>
                        <span>
                          {getParsedFileStatusLabel(pendingFile)} · {formatFileSize(pendingFile.size)}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="composer-file-remove"
                      onClick={() => removePendingFile(pendingFile.id)}
                      aria-label={`移除文件 ${pendingFile.name}`}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}

            {isParsingFiles && <p className="composer-file-parsing-note">文件解析中，完成后可直接预览并发送。</p>}

            {pendingImages.length > 0 && (
              <div className="composer-image-preview composer-image-preview-above">
                {pendingImages.length > 3 && (
                  <div className="composer-image-preview-item" style={{display: 'grid', placeItems: 'center', background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                    +{pendingImages.length - 3}
                  </div>
                )}
                {pendingImages.slice(0, 3).map((pendingImage) => (
                  <div key={pendingImage.id} className="composer-image-preview-item">
                    <img
                      src={pendingImage.dataUrl}
                      alt={pendingImage.name || "待发送图片"}
                      className="composer-image-preview-thumb clickable"
                      onClick={() => setViewingImage(pendingImage.dataUrl)}
                    />
                    <div className="composer-image-preview-meta">
                      <strong>{pendingImage.name || "图片"}</strong>
                      <span>{pendingImage.mimeType}</span>
                    </div>
                    <button
                      type="button"
                      className="composer-image-remove"
                      onClick={() => removePendingImage(pendingImage.id)}
                      aria-label={`移除图片 ${pendingImage.name || ""}`.trim()}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="container-ia-chat">
              <textarea
                ref={inputRef}
                id="input-text"
                className="input-text"
                value={draft}
                onChange={handleDraftChange}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
                placeholder={placeholder}
                disabled={inputDisabled}
                rows={1}
                title=""
              />

              <div className="container-upload-files">
                {/* 思考标 - 替换了原来的相机标 */}
                <button
                  type="button"
                  className={`upload-file ${chat.deepThinkingEnabled ? "is-active" : ""}`}
                  onClick={() => chat.setDeepThinkingEnabled((prev) => !prev)}
                  disabled={thinkingToggleDisabled}
                  aria-label={chat.deepThinkingEnabled ? "关闭深度思考" : "开启深度思考"}
                  title={chat.deepThinkingEnabled ? "关闭深度思考" : "开启深度思考"}
                >
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 4.5a5.5 5.5 0 0 0-3.63 9.63c.4.36.63.88.63 1.42V17a1 1 0 0 0 1 1h2.25m0 0V16.5m0 1.5h4.5m-4.5 0v1.25a1.75 1.75 0 0 0 3.5 0V18m0 0H16.5a1 1 0 0 0 1-1v-1.45c0-.54.23-1.06.63-1.42A5.5 5.5 0 1 0 9.5 4.5Z" />
                  </svg>
                </button>

                {/* 图片上传 */}
                <button
                  type="button"
                  className={`upload-file ${pendingImages.length > 0 ? "is-active" : ""}`}
                  onClick={handleImagePickerClick}
                  disabled={inputDisabled}
                  aria-label="上传图片"
                  title={pendingImages.length > 0 ? `继续添加图片（已选 ${pendingImages.length} 张）` : "上传图片"}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                  >
                    <g
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    >
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
                      <circle cx="9" cy="9" r="2"></circle>
                      <path d="m21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>
                    </g>
                  </svg>
                </button>

                {/* 其他文件上传 */}
                <button
                  type="button"
                  className={`upload-file ${pendingFiles.length > 0 ? "is-active" : ""}`}
                  onClick={handleFilePickerClick}
                  title={
                    pendingFiles.length > 0
                      ? `继续添加文件（已选 ${pendingFiles.length} 个）`
                      : "上传文件"
                  }
                  disabled={inputDisabled}
                  aria-label="上传文件"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                    ></path>
                  </svg>
                </button>
              </div>

              <button
                type={shouldPrimaryStop ? "button" : "submit"}
                className={`label-text send-action ${isComposerActive ? "is-visible" : ""} ${chat.isStreaming ? "is-streaming" : ""}`}
                disabled={composerButtonDisabled}
                aria-label={
                  shouldPrimaryStop ? "停止生成" : chat.isStreaming ? "排队发送" : "发送消息"
                }
                onClick={shouldPrimaryStop ? chat.stopStream : undefined}
              >
                {shouldPrimaryStop ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24">
                    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="m5 12l7-7l7 7m-7 7V5"
                    ></path>
                  </svg>
                )}
              </button>

              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="composer-image-input"
                onChange={handleImageChange}
              />

              <input
                ref={fileInputRef}
                type="file"
                accept={GENERAL_FILE_ACCEPT}
                multiple
                className="composer-file-input"
                onChange={handleFileChange}
              />
            </div>

            <div className="chat-input-footer">
              <div className="chat-context-meter-group">
                <div
                  ref={contextPopupRef}
                  className="chat-context-meter"
                  onClick={() => setContextPopupOpen((prev) => !prev)}
                >
                  <div
                    className="chat-context-ring"
                    style={{
                      "--meter-progress": `${contextWindowUsagePercent}%`
                    }}
                  >
                    <div className="chat-context-ring-inner">
                      <strong>{maxContextWindow > 0 ? `${contextWindowUsagePercent}%` : "-"}</strong>
                    </div>
                  </div>

                  {contextPopupOpen && (
                    <div className="chat-context-popup" onClick={(e) => e.stopPropagation()}>
                      <div className="chat-context-popup-head">
                        <strong>上下文使用量</strong>
                        <span>{maxContextWindow > 0 ? `${contextWindowUsagePercent}%` : "无上限"}</span>
                      </div>

                      <div className="chat-context-popup-row">
                        <span>当前已使用</span>
                        <strong>{latestTokenTotal.toLocaleString()}</strong>
                      </div>

                      {maxContextWindow > 0 && (
                        <>
                          <div className="chat-context-popup-row">
                            <span>剩余额度</span>
                            <strong>{Math.max(0, contextWindowRemainder).toLocaleString()}</strong>
                          </div>
                          <div className="chat-context-popup-row is-total">
                            <span>窗口总上限</span>
                            <strong>{maxContextWindow.toLocaleString()}</strong>
                          </div>
                          <div className="chat-context-popup-row">
                            <span>手动压缩阈值</span>
                            <strong>20%</strong>
                          </div>
                          <div className="chat-context-popup-row">
                            <span>自动压缩阈值</span>
                            <strong>90%</strong>
                          </div>
                        </>
                      )}

                      <div className="chat-context-popup-actions">
                        <button
                          type="button"
                          className="chat-context-compress"
                          onClick={() => {
                            chat.compressConversation("manual");
                            setContextPopupOpen(false);
                          }}
                          disabled={
                            chat.isStreaming ||
                            chat.isCompressing ||
                            chat.pendingApproval ||
                            chat.isDraftConversation ||
                            !chat.historyLoaded ||
                            !chat.activeConversationId ||
                            !chat.canManualCompress
                          }
                        >
                          {chat.isCompressing ? "压缩中..." : "手动压缩"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div ref={approvalMenuRef} className="approval-control">
                  <button
                    type="button"
                    className="approval-trigger"
                    onClick={() => !chat.isStreaming && !chat.isCompressing && setApprovalMenuOpen(!approvalMenuOpen)}
                    disabled={chat.isStreaming || chat.isCompressing}
                  >
                    <span
                      className={`approval-dot ${
                        chat.activeConversationApprovalMode === "auto" ? "is-auto" : "is-confirm"
                      }`}
                    />
                    {chat.activeConversationApprovalMode === "auto" ? "自动" : "审批"}
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" className={`approval-caret ${approvalMenuOpen ? "is-open" : ""}`}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  {approvalMenuOpen && !chat.isStreaming && !chat.isCompressing && (
                    <div className="approval-menu">
                      <button
                        type="button"
                        className={chat.activeConversationApprovalMode === "confirm" ? "is-active" : ""}
                        onClick={() => { chat.setConversationApprovalMode("confirm"); setApprovalMenuOpen(false); }}
                      >
                        <span className="approval-dot is-confirm" />
                        确认审批
                      </button>
                      <button
                        type="button"
                        className={chat.activeConversationApprovalMode === "auto" ? "is-active" : ""}
                        onClick={() => { chat.setConversationApprovalMode("auto"); setApprovalMenuOpen(false); }}
                      >
                        <span className="approval-dot is-auto" />
                        自动审批
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="chat-actions chat-actions-secondary">
                <button type="button" onClick={chat.clearChat} disabled={chat.isStreaming || chat.isCompressing || !chat.historyLoaded}>
                  清空会话
                </button>
              </div>
            </div>
          </form>
        </section>
      </div>

      {chat.retryNotice && <p className="status-note warning">{chat.retryNotice}</p>}
      {chat.error && <p className="status-note error">{chat.error}</p>}

      {chat.pendingApproval && (
        <div className="approval-overlay" role="dialog" aria-modal="true">
          <div className="approval-dialog">
            <header className="approval-dialog-head">
              <h3>确认工具操作</h3>
              <span className="approval-dialog-badge">
                {chat.pendingApproval.approvalMode === "auto" ? "自动审批" : "确认审批"}
              </span>
            </header>

            <p className="approval-dialog-note">
              当前工具调用需要用户确认后继续执行。
            </p>

            <div className="approval-dialog-body">
              <div>
                <span>工具</span>
                <strong>{chat.pendingApproval.toolName}</strong>
              </div>
              <div>
                <span>分组</span>
                <strong>{chat.pendingApproval.toolApprovalGroup || "unknown"}</strong>
              </div>
              <div>
                <span>规则段</span>
                <strong>{chat.pendingApproval.toolApprovalSection || "unknown"}</strong>
              </div>
              <div>
                <span>调用 ID</span>
                <strong>{chat.pendingApproval.toolCallId || "未知"}</strong>
              </div>
              <div>
                <span>调用数</span>
                <strong>{chat.pendingApproval.toolCount}</strong>
              </div>
            </div>

            <pre className="approval-dialog-json">
              {JSON.stringify(chat.pendingApproval.arguments ?? {}, null, 2)}
            </pre>

            <div className="approval-dialog-actions">
              <button
                type="button"
                className="approval-confirm"
                onClick={chat.confirmPendingApproval}
                disabled={chat.isStreaming || chat.isCompressing}
              >
                确认执行
              </button>
              <button
                type="button"
                className="approval-reject"
                onClick={chat.rejectPendingApproval}
                disabled={chat.isStreaming || chat.isCompressing}
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {viewingImage && (
        <div className="image-viewer-overlay" onClick={() => setViewingImage(null)}>
          <button className="image-viewer-close" onClick={() => setViewingImage(null)}>
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="2" fill="none">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <img
            src={viewingImage}
            alt="大图预览"
            className="image-viewer-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {viewingFileText && (
        <div className="text-viewer-overlay" onClick={() => setViewingFileText(null)}>
          <div className="text-viewer-panel" onClick={(event) => event.stopPropagation()}>
            <button className="text-viewer-close" onClick={() => setViewingFileText(null)}>
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <header className="text-viewer-head">
              <strong>{viewingFileText.name}</strong>
              <span>
                {viewingFileText.mimeType} · {formatFileSize(viewingFileText.size)}
              </span>
            </header>

            <pre className="text-viewer-body">{viewingFileText.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
