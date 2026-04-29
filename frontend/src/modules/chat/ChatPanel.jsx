import { useEffect, useMemo, useRef, useState } from "react";

import {
  deleteAutomationBinding,
  fetchAutomationBindings,
  fetchAutomationTasks,
  updateAutomationBinding,
  upsertAutomationBinding
} from "../../api/automationApi";
import { createTtsStreamUrl, parseChatFiles, transcribeAudioBytes } from "../../api/chatApi";
import { formatTimestamp } from "../../shared/formatTimestamp";
import { TimePickerDropdown } from "../../shared/TimePickerDropdown";
import { notify } from "../../shared/feedback";
import { MarkdownMessage } from "./MarkdownMessage";
import "./chat.css";
import { parseToolMessagePayload } from "./toolMessageCodec";
const AUTO_SCROLL_BOTTOM_THRESHOLD = 72;
const MAX_IMAGE_PAYLOAD_BYTES = 2_000_000;
const MAX_UPLOAD_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 8;
const RECORDER_MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg"
];
const TTS_MAX_TEXT_LENGTH = 1000;
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

function BubbleCopyIcon({ copied = false }) {
  if (copied) {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function BubbleSpeakIcon({ playing = false }) {
  if (playing) {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="4.5" height="12" rx="1.2" />
        <rect x="13.5" y="6" width="4.5" height="12" rx="1.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 9.5a4 4 0 0 1 0 5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 7a8 8 0 0 1 0 10" />
    </svg>
  );
}

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

function getRuntimeHookStripText(message) {
  const level = String(message?.meta?.level ?? "info").trim().toLowerCase();
  if (level === "warning") {
    return "运行时提醒（warning）";
  }
  if (level === "strong") {
    return "运行时提醒（strong）";
  }
  return "运行时提醒";
}

function clipOrchestratorText(value, maxLength = 96) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function resolveOrchestratorAgentLabel(displayName, agentId) {
  const normalizedDisplayName = String(displayName ?? "").replace(/\s+/g, " ").trim();
  if (normalizedDisplayName) {
    return clipOrchestratorText(normalizedDisplayName, 28);
  }

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
  const sourceLabel = resolveOrchestratorAgentLabel(
    orchestrator.sourceAgentDisplayName,
    orchestrator.sourceAgentId
  );
  const targetLabel = resolveOrchestratorAgentLabel(
    orchestrator.targetAgentDisplayName,
    orchestrator.targetAgentId
  );

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

  if (subtype === "user_correction") {
    return {
      badge: "纠偏插入",
      summary: `${targetLabel || sourceLabel || "智能体"} 收到了一条运行中纠偏`
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

function truncateTtsText(text, maxLength = TTS_MAX_TEXT_LENGTH) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}。`;
}

function stripMarkdownForTts(input) {
  let text = String(input ?? "");
  if (!text) {
    return "";
  }

  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block
      .replace(/^```[^\n]*\n?/m, "")
      .replace(/```$/m, "")
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>]+>/g, "");
  text = text.replace(/^\s{0,3}(#{1,6})\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, " ");
  text = text.replace(/(\*\*|__|\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^\s*\|/gm, "");
  text = text.replace(/\|\s*$/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");

  return text.replace(/\s+/g, " ").trim();
}

function resolveMessageSpeakText({
  message,
  messageText,
  isRuntimeHookInjectedMessage,
  isOrchestratorMessage,
  orchestratorNotice,
  isCompressionSummary,
  isToolCard,
  toolPayload,
  hasImageAttachments,
  hasFileAttachments
}) {
  const plainMessageText = stripMarkdownForTts(messageText);

  if (isRuntimeHookInjectedMessage) {
    return truncateTtsText(getRuntimeHookStripText(message));
  }

  if (isOrchestratorMessage) {
    return truncateTtsText(String(orchestratorNotice?.summary ?? ""));
  }

  if (isCompressionSummary || plainMessageText.length > 0) {
    return truncateTtsText(plainMessageText);
  }

  if (isToolCard) {
    const toolName = String(toolPayload?.toolName ?? "").trim() || "工具";
    const toolResult = stripMarkdownForTts(String(toolPayload?.result ?? "").trim());
    const statusText = toolResult || (toolPayload?.isError ? "执行失败" : "执行中");
    return truncateTtsText(`${toolName}：${statusText}`);
  }

  if (hasImageAttachments || hasFileAttachments) {
    return "这是一条附件消息。";
  }

  return "";
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

function normalizeClarifyOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 12);
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

function normalizeWorkplaceGroupLabel(workplacePath) {
  const normalized = String(workplacePath ?? "").trim();
  return normalized || "未设置工作区";
}

function normalizeAutomationTime(value) {
  const normalized = String(value ?? "").trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized) ? normalized : "09:00";
}

export function ChatPanel({
  chat,
  modelContextWindow = 0,
  disabled,
  disabledReason,
  onNavigate,
  showHistoryPane = true,
  onBack
}) {
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isParsingFiles, setIsParsingFiles] = useState(false);
  const [expandedToolMap, setExpandedToolMap] = useState({});
  const [expandedReasoningMap, setExpandedReasoningMap] = useState({});
  const [reasoningNow, setReasoningNow] = useState(() => Date.now());
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [historyPaneOpen, setHistoryPaneOpen] = useState(Boolean(showHistoryPane));
  const [contextPopupOpen, setContextPopupOpen] = useState(false);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [personaMenuOpen, setPersonaMenuOpen] = useState(false);
  const [automationTemplateMenuOpen, setAutomationTemplateMenuOpen] = useState(false);
  const [automationConfigOpen, setAutomationConfigOpen] = useState(false);
  const [automationTemplates, setAutomationTemplates] = useState([]);
  const [automationBindings, setAutomationBindings] = useState([]);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationError, setAutomationError] = useState("");
  const [automationMessage, setAutomationMessage] = useState("");
  const [automationDraft, setAutomationDraft] = useState({
    templateId: "",
    timeOfDay: "09:00"
  });
  const [clarifySelectedOption, setClarifySelectedOption] = useState("");
  const [clarifyAdditionalText, setClarifyAdditionalText] = useState("");
  const [viewingImage, setViewingImage] = useState(null);
  const [viewingFileText, setViewingFileText] = useState(null);
  const [draggedQueueMessageId, setDraggedQueueMessageId] = useState("");
  const [queueDropTarget, setQueueDropTarget] = useState(null);
  const [orchestratorLogOpen, setOrchestratorLogOpen] = useState(false);
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
  const [expandedHistoryGroupMap, setExpandedHistoryGroupMap] = useState({});
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [isVoiceTranscribing, setIsVoiceTranscribing] = useState(false);
  const [ttsPlayingMessageId, setTtsPlayingMessageId] = useState("");
  const [ttsLoadingMessageId, setTtsLoadingMessageId] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const chatStreamRef = useRef(null);
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const voiceRecorderRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceStreamRef = useRef(null);
  const ttsAudioRef = useRef(null);
  const ttsPlaybackTokenRef = useRef(0);
  const activeConversationIdRef = useRef(String(chat.activeConversationId ?? ""));
  const lastAutoExpandedHistoryConversationIdRef = useRef("");
  const shouldAutoScrollRef = useRef(true);
  const isScrollTrackingReadyRef = useRef(false);
  const contextPopupRef = useRef(null);
  const approvalMenuRef = useRef(null);
  const personaMenuRef = useRef(null);
  const automationTemplateMenuRef = useRef(null);

  useEffect(() => {
    setHistoryPaneOpen(Boolean(showHistoryPane));
  }, [showHistoryPane]);

  useEffect(() => {
    return () => {
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }

      const stream = voiceStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }

      voiceRecorderRef.current = null;
      voiceStreamRef.current = null;
      voiceChunksRef.current = [];
    };
  }, []);

  useEffect(() => {
    return () => {
      const audio = ttsAudioRef.current;
      if (audio) {
        try {
          audio.pause();
        } catch {}
        audio.src = "";
      }
      ttsAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (contextPopupRef.current && !contextPopupRef.current.contains(event.target)) {
        setContextPopupOpen(false);
      }
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(event.target)) {
        setApprovalMenuOpen(false);
      }
      if (personaMenuRef.current && !personaMenuRef.current.contains(event.target)) {
        setPersonaMenuOpen(false);
      }
      if (
        automationTemplateMenuRef.current &&
        !automationTemplateMenuRef.current.contains(event.target)
      ) {
        setAutomationTemplateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  async function loadAutomationState({ quiet = false } = {}) {
    if (!quiet) {
      setAutomationLoading(true);
    }
    setAutomationError("");
    try {
      const [taskResponse, bindingResponse] = await Promise.all([
        fetchAutomationTasks(),
        fetchAutomationBindings()
      ]);
      setAutomationTemplates(Array.isArray(taskResponse?.tasks) ? taskResponse.tasks : []);
      setAutomationBindings(Array.isArray(bindingResponse?.bindings) ? bindingResponse.bindings : []);
    } catch (error) {
      setAutomationError(String(error?.message ?? "加载自动化配置失败"));
    } finally {
      if (!quiet) {
        setAutomationLoading(false);
      }
    }
  }

  useEffect(() => {
    let mounted = true;

    async function run() {
      setAutomationLoading(true);
      setAutomationError("");
      try {
        const [taskResponse, bindingResponse] = await Promise.all([
          fetchAutomationTasks(),
          fetchAutomationBindings()
        ]);
        if (!mounted) {
          return;
        }
        setAutomationTemplates(Array.isArray(taskResponse?.tasks) ? taskResponse.tasks : []);
        setAutomationBindings(Array.isArray(bindingResponse?.bindings) ? bindingResponse.bindings : []);
      } catch (error) {
        if (mounted) {
          setAutomationError(String(error?.message ?? "加载自动化配置失败"));
        }
      } finally {
        if (mounted) {
          setAutomationLoading(false);
        }
      }
    }

    run();
    const timerId = setInterval(() => {
      if (mounted) {
        void loadAutomationState({ quiet: true });
      }
    }, 15000);

    return () => {
      mounted = false;
      clearInterval(timerId);
    };
  }, []);

  const inputDisabled =
    disabled ||
    !chat.historyLoaded ||
    Boolean(chat.pendingApproval);
  const voiceInputDisabled = inputDisabled || isParsingFiles || isVoiceTranscribing;
  const hasComposerPayload =
    draft.trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0;
  const isComposerActive =
    draft.length > 0 || inputFocused || pendingImages.length > 0 || pendingFiles.length > 0;
  const shouldPrimaryStop = Boolean(chat.canStopStream) && !hasComposerPayload;
  const composerButtonDisabled =
    inputDisabled ||
    isParsingFiles ||
    (!hasComposerPayload && !chat.canStopStream);
  const personaSelectorDisabled =
    chat.isStreaming ||
    !chat.historyLoaded ||
    Boolean(chat.pendingApproval);
  const personaCatalog = Array.isArray(chat?.personaCatalog) ? chat.personaCatalog : [];
  const activePersona = personaCatalog.find(
    (persona) => String(persona?.id ?? "").trim() === String(chat.activeConversationPersonaId ?? "").trim()
  ) ?? null;
  const personaTriggerLabel = activePersona?.name || "不使用身份";

  useEffect(() => {
    if (!promptDrawerOpen || personaSelectorDisabled) {
      setPersonaMenuOpen(false);
    }
  }, [promptDrawerOpen, personaSelectorDisabled]);

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
      : isVoiceTranscribing
        ? "语音转写中，请稍候..."
      : isVoiceRecording
        ? "录音中，再点一次麦克风结束录音"
      : isParsingFiles
        ? "文件解析中，请稍候发送"
      : disabled
        ? disabledReason
        : "输入消息，观察流式与工具调用";
  const queuedUserMessages = Array.isArray(chat.queuedUserMessages) ? chat.queuedUserMessages : [];
  const pendingInsertions = Array.isArray(chat.pendingInsertions) ? chat.pendingInsertions : [];
  const orchestratorMessages = useMemo(
    () =>
      (Array.isArray(chat.messages) ? chat.messages : []).filter(
        (message) => getMessageMetaKind(message) === "orchestrator_message"
      ),
    [chat.messages]
  );
  const visibleMessages = useMemo(
    () =>
      orchestratorLogOpen
        ? chat.messages
        : (Array.isArray(chat.messages) ? chat.messages : []).filter(
            (message) => getMessageMetaKind(message) !== "orchestrator_message"
          ),
    [chat.messages, orchestratorLogOpen]
  );
  const latestOrchestratorNotice = orchestratorMessages.length > 0
    ? buildOrchestratorNotice(orchestratorMessages[orchestratorMessages.length - 1])
    : null;
  const runtimeStatus = chat.runtimeStatus && typeof chat.runtimeStatus === "object"
    ? chat.runtimeStatus
    : null;
  const messageStats = runtimeStatus?.messageStats && typeof runtimeStatus.messageStats === "object"
    ? runtimeStatus.messageStats
    : {};
  const approvalTimeline = Array.isArray(chat.approvalTimeline) ? chat.approvalTimeline : [];
  const executionAutopsy = chat.executionAutopsy && typeof chat.executionAutopsy === "object"
    ? chat.executionAutopsy
    : null;
  const isSubagentConversation = String(chat.activeConversationSource ?? "").trim() === "subagent";
  const historyConversationList = Array.isArray(chat.conversationList) ? chat.conversationList : [];
  const automationTemplateList = Array.isArray(automationTemplates) ? automationTemplates : [];
  const automationBindingByConversationId = useMemo(() => {
    const result = new Map();
    for (const binding of automationBindings) {
      const conversationId = String(binding?.conversationId ?? "").trim();
      if (conversationId) {
        result.set(conversationId, binding);
      }
    }
    return result;
  }, [automationBindings]);
  const activeAutomationBinding = automationBindingByConversationId.get(
    String(chat.activeConversationId ?? "").trim()
  ) ?? null;
  const activeAutomationTemplate = automationTemplateList.find(
    (template) => String(template?.id ?? "").trim() === String(activeAutomationBinding?.templateId ?? "").trim()
  ) ?? null;
  const selectedAutomationTemplate = automationTemplateList.find(
    (template) => String(template?.id ?? "").trim() === String(automationDraft.templateId ?? "").trim()
  ) ?? activeAutomationTemplate;
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
  const pendingApprovalArguments =
    chat?.pendingApproval?.arguments &&
    typeof chat.pendingApproval.arguments === "object" &&
    !Array.isArray(chat.pendingApproval.arguments)
      ? chat.pendingApproval.arguments
      : {};
  const isClarifyApproval = String(chat?.pendingApproval?.toolName ?? "").trim() === "clarify";
  const clarifyQuestion = String(pendingApprovalArguments?.question ?? "").trim();
  const clarifyOptions = normalizeClarifyOptions(pendingApprovalArguments?.options);
  const clarifyAllowAdditionalText = Boolean(
    pendingApprovalArguments?.allowAdditionalText ?? true
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
  const workplaceHistorySections = useMemo(() => {
    const sections = [];
    const sectionIndexByKey = new Map();

    for (const item of groupedHistoryList.topLevelItems) {
      const workplacePath = String(item?.workplacePath ?? "").trim();
      const workplaceKey = workplacePath || "__empty_workplace__";
      const sectionIndex = sectionIndexByKey.get(workplaceKey);
      if (Number.isInteger(sectionIndex)) {
        sections[sectionIndex].items.push(item);
        continue;
      }

      sectionIndexByKey.set(workplaceKey, sections.length);
      sections.push({
        workplaceKey,
        workplaceLabel: normalizeWorkplaceGroupLabel(workplacePath),
        workplacePath,
        items: [item]
      });
    }

    return sections;
  }, [groupedHistoryList.topLevelItems]);
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

  useEffect(() => {
    const fallbackTemplateId = String(automationTemplateList[0]?.id ?? "").trim();
    setAutomationDraft({
      templateId: String(activeAutomationBinding?.templateId ?? fallbackTemplateId).trim(),
      timeOfDay: normalizeAutomationTime(activeAutomationBinding?.timeOfDay)
    });
    setAutomationError("");
    setAutomationMessage("");
  }, [
    chat.activeConversationId,
    activeAutomationBinding?.id,
    activeAutomationBinding?.templateId,
    activeAutomationBinding?.timeOfDay,
    automationTemplateList
  ]);

  useEffect(() => {
    if (isSubagentConversation) {
      setAutomationConfigOpen(false);
    }
  }, [isSubagentConversation]);

  useEffect(() => {
    if (!automationConfigOpen) {
      setAutomationTemplateMenuOpen(false);
    }
  }, [automationConfigOpen]);

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
    if (!chat.pendingApproval || !isClarifyApproval) {
      setClarifySelectedOption("");
      setClarifyAdditionalText("");
      return;
    }

    const presetOption = String(pendingApprovalArguments?.selectedOption ?? "").trim();
    const presetAdditionalText = String(pendingApprovalArguments?.additionalText ?? "").trim();
    setClarifySelectedOption(presetOption);
    setClarifyAdditionalText(presetAdditionalText);
  }, [chat.pendingApproval, isClarifyApproval, pendingApprovalArguments]);

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
    stopTtsPlayback();
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

  function toggleReasoningResult(messageId, currentExpanded = false) {
    setExpandedReasoningMap((prev) => ({
      ...prev,
      [messageId]: !Boolean(currentExpanded)
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

  async function handleSaveAutomationBinding() {
    const conversationId = String(chat.activeConversationId ?? "").trim();
    const templateId = String(automationDraft.templateId ?? "").trim();
    if (!conversationId || isSubagentConversation) {
      return;
    }
    if (!templateId) {
      setAutomationError("请先选择一个自动化任务模板");
      return;
    }

    setAutomationSaving(true);
    setAutomationError("");
    setAutomationMessage("");
    try {
      const payload = {
        templateId,
        timeOfDay: normalizeAutomationTime(automationDraft.timeOfDay)
      };

      if (activeAutomationBinding?.id) {
        await updateAutomationBinding(activeAutomationBinding.id, payload);
        setAutomationMessage("当前会话自动化已更新");
      } else {
        await upsertAutomationBinding({
          ...payload,
          conversationId
        });
        setAutomationMessage("当前会话已绑定自动化");
      }
      await loadAutomationState({ quiet: true });
    } catch (error) {
      setAutomationError(String(error?.message ?? "保存自动化绑定失败"));
    } finally {
      setAutomationSaving(false);
    }
  }

  async function handleDeleteAutomationBinding() {
    if (!activeAutomationBinding?.id) {
      return;
    }

    setAutomationSaving(true);
    setAutomationError("");
    setAutomationMessage("");
    try {
      await deleteAutomationBinding(activeAutomationBinding.id);
      await loadAutomationState({ quiet: true });
      setAutomationMessage("当前会话已解绑自动化");
    } catch (error) {
      setAutomationError(String(error?.message ?? "解绑自动化失败"));
    } finally {
      setAutomationSaving(false);
    }
  }

  function handleDraftChange(event) {
    setDraft(event.target.value);
  }

  function resolveRecorderMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return "";
    }

    for (const candidate of RECORDER_MIME_TYPE_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  function stopVoiceMediaStream() {
    const stream = voiceStreamRef.current;
    if (!stream) {
      return;
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }
    voiceStreamRef.current = null;
  }

  async function stopRecordingAndTranscribe() {
    const recorder = voiceRecorderRef.current;
    if (!recorder) {
      return;
    }

    setIsVoiceRecording(false);

    const audioBlob = await new Promise((resolve, reject) => {
      const handleStop = () => {
        const chunks = [...voiceChunksRef.current];
        voiceChunksRef.current = [];
        const mimeType = String(recorder.mimeType ?? "").trim() || "application/octet-stream";
        resolve(new Blob(chunks, { type: mimeType }));
      };
      const handleError = (event) => {
        const message = String(event?.error?.message ?? "录音失败");
        reject(new Error(message));
      };

      recorder.addEventListener("stop", handleStop, { once: true });
      recorder.addEventListener("error", handleError, { once: true });

      if (recorder.state === "inactive") {
        handleStop();
        return;
      }

      try {
        recorder.stop();
      } catch (error) {
        reject(error);
      }
    });

    voiceRecorderRef.current = null;
    stopVoiceMediaStream();

    if (!(audioBlob instanceof Blob) || audioBlob.size <= 0) {
      throw new Error("录音内容为空，请重试");
    }

    setIsVoiceTranscribing(true);
    try {
      const result = await transcribeAudioBytes(audioBlob, {
        language: "zh",
        task: "transcribe"
      });
      const transcript = String(result?.text ?? "").trim();
      if (!transcript) {
        throw new Error("未识别到有效文本，请重试");
      }

      setDraft((prev) => {
        const previous = String(prev ?? "");
        const trimmedPrevious = previous.trim();
        if (!trimmedPrevious) {
          return transcript;
        }

        const separator = /[\s\n]$/.test(previous) ? "" : "\n";
        return `${previous}${separator}${transcript}`;
      });
      inputRef.current?.focus();
    } finally {
      setIsVoiceTranscribing(false);
    }
  }

  async function handleVoiceInputClick() {
    if (isVoiceTranscribing) {
      return;
    }

    if (isVoiceRecording) {
      try {
        await stopRecordingAndTranscribe();
      } catch (error) {
        stopVoiceMediaStream();
        voiceRecorderRef.current = null;
        voiceChunksRef.current = [];
        setIsVoiceRecording(false);
        setIsVoiceTranscribing(false);
        notify({ tone: "error", title: "语音转写失败", message: error?.message || "语音转写失败" });
      }
      return;
    }

    if (voiceInputDisabled) {
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      notify({ tone: "warning", message: "当前浏览器不支持语音录音" });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = resolveRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      voiceChunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event?.data && event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
        }
      });

      recorder.start(250);
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      setIsVoiceRecording(true);
    } catch (error) {
      stopVoiceMediaStream();
      voiceRecorderRef.current = null;
      voiceChunksRef.current = [];
      setIsVoiceRecording(false);
      notify({ tone: "error", title: "无法启动录音", message: error?.message || "请检查麦克风权限" });
    }
  }

  function stopTtsPlayback() {
    const audio = ttsAudioRef.current;
    if (!audio) {
      setTtsPlayingMessageId("");
      setTtsLoadingMessageId("");
      return;
    }

    try {
      audio.pause();
    } catch {}
    audio.src = "";
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    setTtsPlayingMessageId("");
    setTtsLoadingMessageId("");
  }

  async function handleBubbleSpeakClick(messageId, speakText) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const normalizedText = truncateTtsText(speakText);
    if (!normalizedMessageId || !normalizedText) {
      return;
    }

    if (ttsPlayingMessageId === normalizedMessageId || ttsLoadingMessageId === normalizedMessageId) {
      stopTtsPlayback();
      return;
    }

    const playbackToken = ttsPlaybackTokenRef.current + 1;
    ttsPlaybackTokenRef.current = playbackToken;
    stopTtsPlayback();
    setTtsLoadingMessageId(normalizedMessageId);

    try {
      const streamUrl = createTtsStreamUrl(normalizedText, {
        voice: "zh-CN-XiaoxiaoNeural"
      });

      const audio = ttsAudioRef.current ?? new Audio();
      ttsAudioRef.current = audio;
      audio.preload = "none";
      audio.src = streamUrl;

      audio.onplaying = () => {
        if (ttsPlaybackTokenRef.current !== playbackToken) {
          return;
        }
        setTtsLoadingMessageId("");
        setTtsPlayingMessageId(normalizedMessageId);
      };

      audio.onended = () => {
        if (ttsPlaybackTokenRef.current !== playbackToken) {
          return;
        }
        setTtsLoadingMessageId("");
        setTtsPlayingMessageId("");
      };

      audio.onerror = () => {
        if (ttsPlaybackTokenRef.current !== playbackToken) {
          return;
        }
        setTtsLoadingMessageId("");
        setTtsPlayingMessageId("");
        notify({ tone: "error", message: "语音朗读失败，请稍后重试" });
      };

      await audio.play();
    } catch (error) {
      if (ttsPlaybackTokenRef.current !== playbackToken) {
        return;
      }
      stopTtsPlayback();
      notify({ tone: "error", message: error?.message || "语音朗读失败，请稍后重试" });
    }
  }

  async function handleCopyMessageClick(messageId, content) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const copyText = String(content ?? "").trim();
    if (!normalizedMessageId || !copyText) {
      return;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = copyText;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.top = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopiedMessageId(normalizedMessageId);
      window.setTimeout(() => {
        setCopiedMessageId((prev) => (prev === normalizedMessageId ? "" : prev));
      }, 1200);
    } catch {
      notify({ tone: "error", message: "复制失败，请重试" });
    }
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
          notify({ tone: "warning", message: `${failedCount} 张图片因体积过大，未能加入本次消息` });
        }
      })
      .catch(() => {
        notify({ tone: "error", message: "图片过大，在不缩小尺寸的前提下压缩质量后仍无法上传" });
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
      notify({ tone: "warning", message: "请使用文件按钮选择文档类文件，图片请使用图片按钮上传。" });
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const remainingSlots = Math.max(0, MAX_UPLOAD_FILE_COUNT - pendingFiles.length);
    if (remainingSlots <= 0) {
      notify({ tone: "warning", message: `每次最多上传 ${MAX_UPLOAD_FILE_COUNT} 个文件，请先移除部分文件。` });
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
      notify({ tone: "warning", message: `${invalidSizeFiles.length} 个文件超过 20MB，已忽略。` });
    }

    const filesToParse = selectedNow.slice(0, remainingSlots).map((item) => item.file).filter(Boolean);
    if (selectedNow.length > filesToParse.length) {
      notify({ tone: "warning", message: `每次最多上传 ${MAX_UPLOAD_FILE_COUNT} 个文件，已自动截断。` });
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
        notify({ tone: "error", title: "文件解析失败", message: error?.message || "文件解析失败" });
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

  function handleClarifyConfirm() {
    const selectedOption = String(clarifySelectedOption ?? "").trim();
    const additionalText = String(clarifyAdditionalText ?? "").trim();
    if (!selectedOption && !additionalText) {
      return;
    }

    chat.confirmPendingApproval({
      approvalInput: {
        selectedOption,
        additionalText
      }
    });
  }

  return (
    <div className="module chat-module">
      <div className={`chat-workspace ${showHistoryPane ? "" : "chat-workspace-no-history"}`}>
        {showHistoryPane && (
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

            {chat.historyLoaded && workplaceHistorySections.length === 0 && (
              <p className="empty-note">暂无历史会话</p>
            )}

            {workplaceHistorySections.map((section) => (
              <section key={section.workplaceKey} className="history-workspace-section">
                <header
                  className="history-workspace-header"
                  title={section.workplacePath || "未设置工作区"}
                >
                  <span className="history-workspace-name">{section.workplaceLabel}</span>
                  <span className="history-workspace-count">{section.items.length}</span>
                </header>

                {section.items.map((item) => {
              const childItems = groupedHistoryList.childItemsByParentId.get(String(item.id ?? "").trim()) ?? [];
              const hasChildren = childItems.length > 0;
              const isParentActive = String(item.id ?? "").trim() === String(chat.activeConversationId ?? "").trim();
              const containsActiveChild = childItems.some(
                (child) => String(child?.id ?? "").trim() === String(chat.activeConversationId ?? "").trim()
              );
              const normalizedItemId = String(item.id ?? "").trim();
              const busySubagents = Array.isArray(item?.subagents)
                ? item.subagents.filter((subagent) => Boolean(subagent?.agentBusy))
                : [];
              const busySubagentConversationIds = new Set(
                busySubagents
                  .map((subagent) => String(subagent?.conversationId ?? "").trim())
                  .filter(Boolean)
              );
              const isParentRunning = Boolean(item.agentBusy);
              const hasRunningChild =
                childItems.some(
                  (child) =>
                    Boolean(child?.agentBusy) ||
                    busySubagentConversationIds.has(String(child?.id ?? "").trim())
                ) || busySubagents.length > 0;
              const isExpanded =
                !hasChildren || Boolean(expandedHistoryGroupMap?.[normalizedItemId]);
              const automationBinding = automationBindingByConversationId.get(normalizedItemId) ?? null;

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
                              {automationBinding ? (
                                <span
                                  className={`history-automation-badge ${automationBinding.enabled ? "" : "is-paused"}`}
                                  title={`自动化：${automationBinding.templateName || automationBinding.templateId || "未命名"}`}
                                >
                                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l3 2" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l-2 2M19 5l2 2" />
                                    <circle cx="12" cy="13" r="7" />
                                  </svg>
                                  {automationBinding.enabled ? "自动化" : "暂停"}
                                </span>
                              ) : null}
                              {(isParentRunning || hasRunningChild) && (
                                <span
                                  className="history-run-indicator"
                                  title={isParentRunning ? "该会话正在运行" : "子智能体正在运行"}
                                  aria-label={isParentRunning ? "该会话正在运行" : "子智能体正在运行"}
                                >
                                  <span className="history-run-spinner" aria-hidden="true" />
                                  <span>{isParentRunning ? "运行中" : "子运行中"}</span>
                                </span>
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
                            const isChildRunning =
                              Boolean(child?.agentBusy) ||
                              busySubagentConversationIds.has(String(child?.id ?? "").trim());
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
                                      {isChildRunning && (
                                        <span
                                          className="history-run-indicator"
                                          title="该子智能体正在运行"
                                          aria-label="该子智能体正在运行"
                                        >
                                          <span className="history-run-spinner" aria-hidden="true" />
                                          <span>运行中</span>
                                        </span>
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
              </section>
            ))}
          </div>

        </aside>
        )}

        <section className="chat-pane">
          <div className="chat-pane-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {showHistoryPane ? (
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
                ) : (
                  <button
                    type="button"
                    className="chat-back-btn"
                    onClick={() => onBack?.()}
                    title="返回自动化列表"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15 18-6-6 6-6" />
                    </svg>
                    返回
                  </button>
                )}
                <h3>{chat.activeConversationTitle || "当前会话"}</h3>
                {isSubagentConversation && (
                  <span className="history-item-badge">
                    {chat.activeConversationAgentDisplayName || "子智能体"}
                  </span>
                )}
              </div>
            <div className="chat-pane-head-right">
              <div className="chat-mode-switch">
                {!isSubagentConversation && (
                  <button
                    type="button"
                    className={`mode-pill persona-toggle ${promptDrawerOpen ? "active" : ""}`}
                    onClick={() => {
                      setPromptDrawerOpen((prev) => !prev);
                    }}
                    disabled={!chat.historyLoaded}
                    style={activePersona?.accentColor ? { "--persona-accent": activePersona.accentColor } : undefined}
                  >
                    {activePersona?.avatarUrl && (
                      <img className="persona-toggle-avatar" src={activePersona.avatarUrl} alt="" />
                    )}
                    {activePersona?.name || "选择身份"}
                  </button>
                )}
                {!isSubagentConversation && (
                  <button
                    type="button"
                    className={`mode-pill automation-toggle ${automationConfigOpen ? "active" : ""} ${
                      activeAutomationBinding ? "is-bound" : ""
                    }`}
                    onClick={() => setAutomationConfigOpen((prev) => !prev)}
                    disabled={!chat.historyLoaded || !chat.activeConversationId}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l3 2" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l-2 2M19 5l2 2" />
                      <circle cx="12" cy="13" r="7" />
                    </svg>
                    {activeAutomationBinding ? "自动化已绑" : "自动化"}
                  </button>
                )}
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

          {promptDrawerOpen && !isSubagentConversation && (
            <section className="chat-persona-panel">
              <div className="chat-developer-panel-head">
                <div>
                  <h3>Agent 身份</h3>
                  <p>身份来自资产文件，选择后从下一次请求开始影响主智能体。</p>
                </div>
                <span className="chat-developer-panel-badge">
                  {activePersona ? "已启用" : "未选择"}
                </span>
              </div>
              <div className="chat-persona-select-row">
                <div
                  className="chat-persona-combobox"
                  ref={personaMenuRef}
                  style={{ "--persona-accent": activePersona?.accentColor || "#2563eb" }}
                >
                  <button
                    type="button"
                    className={`chat-persona-trigger ${personaMenuOpen ? "open" : ""}`}
                    onClick={() => setPersonaMenuOpen((prev) => !prev)}
                    disabled={personaSelectorDisabled}
                    aria-haspopup="listbox"
                    aria-expanded={personaMenuOpen}
                  >
                    <span className="chat-persona-trigger-avatar">
                      {activePersona?.avatarUrl ? (
                        <img src={activePersona.avatarUrl} alt="" />
                      ) : (
                        <span>{activePersona?.name?.slice(0, 2) || "AI"}</span>
                      )}
                    </span>
                    <span className="chat-persona-trigger-copy">
                      <strong>{personaTriggerLabel}</strong>
                      <small>
                        {activePersona?.description || `${personaCatalog.length} 个可用身份`}
                      </small>
                    </span>
                    <span className="chat-persona-trigger-arrow" aria-hidden="true">v</span>
                  </button>

                  {personaMenuOpen && (
                    <div className="chat-persona-menu" role="listbox">
                      <button
                        type="button"
                        className={`chat-persona-option ${!activePersona ? "active" : ""}`}
                        onClick={() => {
                          setPersonaMenuOpen(false);
                          chat.setConversationPersona("");
                        }}
                        role="option"
                        aria-selected={!activePersona}
                      >
                        <span className="chat-persona-option-avatar muted">AI</span>
                        <span className="chat-persona-option-copy">
                          <strong>不使用身份</strong>
                          <small>只使用 YYZ_CLAW 默认行为</small>
                        </span>
                        {!activePersona && <span className="chat-persona-option-check">已选</span>}
                      </button>

                      {personaCatalog.map((persona) => {
                        const selected = String(persona.id) === String(chat.activeConversationPersonaId || "");
                        return (
                          <button
                            type="button"
                            key={persona.id}
                            className={`chat-persona-option ${selected ? "active" : ""}`}
                            style={{ "--persona-accent": persona.accentColor || "#2563eb" }}
                            onClick={() => {
                              setPersonaMenuOpen(false);
                              chat.setConversationPersona(persona.id);
                            }}
                            role="option"
                            aria-selected={selected}
                          >
                            {persona.avatarUrl ? (
                              <img className="chat-persona-option-avatar" src={persona.avatarUrl} alt="" />
                            ) : (
                              <span className="chat-persona-option-avatar">
                                {persona.name.slice(0, 2).toUpperCase()}
                              </span>
                            )}
                            <span className="chat-persona-option-copy">
                              <strong>{persona.name}</strong>
                              <small>{persona.description || persona.id}</small>
                            </span>
                            {selected && <span className="chat-persona-option-check">已选</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="mode-pill skills-toggle"
                  onClick={() => onNavigate?.("personas")}
                >
                  管理身份
                </button>
              </div>
              {activePersona ? (
                <div
                  className="chat-persona-preview"
                  style={{ "--persona-accent": activePersona.accentColor || "#2563eb" }}
                >
                  {activePersona.avatarUrl && (
                    <img className="chat-persona-preview-avatar" src={activePersona.avatarUrl} alt="" />
                  )}
                  <div>
                    <strong>{activePersona.name}</strong>
                    <p>{activePersona.description || "这个身份没有描述。"}</p>
                  </div>
                </div>
              ) : (
                <div className="chat-persona-empty">当前会话会使用默认 YYZ_CLAW 行为，不额外注入身份 prompt。</div>
              )}
            </section>
          )}

          {automationConfigOpen && !isSubagentConversation ? (
            <section className="chat-automation-panel">
              <div className="chat-automation-panel-head">
                <div>
                  <h3>会话自动化</h3>
                  <p>给当前普通会话绑定一个通用任务模板；到点后作为正常 user 消息进入本会话。</p>
                </div>
                <span className={`chat-automation-state ${activeAutomationBinding?.enabled ? "is-enabled" : ""}`}>
                  {activeAutomationBinding
                    ? activeAutomationBinding.enabled
                      ? "启用中"
                      : "已暂停"
                    : "未绑定"}
                </span>
              </div>

              {automationLoading ? <p className="chat-automation-note">自动化配置加载中...</p> : null}
              {automationError ? <p className="chat-automation-error">{automationError}</p> : null}
              {automationMessage ? <p className="chat-automation-message">{automationMessage}</p> : null}

              <div className="chat-automation-grid">
                <div
                  className="chat-automation-template-field"
                  ref={automationTemplateMenuRef}
                >
                  <span className="chat-automation-field-label">任务模板</span>
                  <button
                    type="button"
                    className={`chat-automation-template-trigger ${automationTemplateMenuOpen ? "open" : ""}`}
                    onClick={() => setAutomationTemplateMenuOpen((prev) => !prev)}
                    disabled={automationSaving || automationTemplateList.length === 0}
                    aria-haspopup="listbox"
                    aria-expanded={automationTemplateMenuOpen}
                  >
                    <span className="chat-automation-template-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h.01M3 12h.01M3 18h.01" />
                      </svg>
                    </span>
                    <span className="chat-automation-template-copy">
                      <strong>{selectedAutomationTemplate?.name || "选择任务模板"}</strong>
                      <small>
                        {selectedAutomationTemplate?.prompt || "暂无模板，先去自动化页面创建"}
                      </small>
                    </span>
                    <span className="chat-automation-template-arrow" aria-hidden="true">v</span>
                  </button>

                  {automationTemplateMenuOpen ? (
                    <div className="chat-automation-template-menu" role="listbox">
                      {automationTemplateList.map((template) => {
                        const selected =
                          String(template?.id ?? "").trim() === String(automationDraft.templateId ?? "").trim();
                        return (
                          <button
                            type="button"
                            key={template.id}
                            className={`chat-automation-template-option ${selected ? "active" : ""}`}
                            onClick={() => {
                              setAutomationTemplateMenuOpen(false);
                              setAutomationDraft((prev) => ({
                                ...prev,
                                templateId: template.id
                              }));
                            }}
                            role="option"
                            aria-selected={selected}
                          >
                            <span className="chat-automation-template-option-dot" aria-hidden="true" />
                            <span>
                              <strong>{template.name}</strong>
                              <small>{template.prompt}</small>
                            </span>
                            {selected ? <em>已选</em> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <label>
                  执行时间
                  <span className="chat-automation-time-picker">
                    <TimePickerDropdown
                      value={automationDraft.timeOfDay}
                      onChange={(nextValue) =>
                        setAutomationDraft((prev) => ({
                          ...prev,
                          timeOfDay: normalizeAutomationTime(nextValue)
                        }))
                      }
                      ariaLabel="当前会话自动化执行时间"
                    />
                  </span>
                </label>

              </div>

              <div className="chat-automation-template-preview">
                <strong>{selectedAutomationTemplate?.name || "模板预览"}</strong>
                <p>{selectedAutomationTemplate?.prompt || "选择模板后，这里会显示到点发送的 user 消息。"}</p>
              </div>

              <div className="chat-automation-actions">
                <button
                  type="button"
                  className="mode-pill automation-save"
                  onClick={() => void handleSaveAutomationBinding()}
                  disabled={automationSaving || automationTemplateList.length === 0 || !chat.activeConversationId}
                >
                  {automationSaving ? "保存中..." : activeAutomationBinding ? "更新绑定" : "绑定到当前会话"}
                </button>
                {activeAutomationBinding ? (
                  <button
                    type="button"
                    className="mode-pill automation-unbind"
                    onClick={() => void handleDeleteAutomationBinding()}
                    disabled={automationSaving}
                  >
                    解绑
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mode-pill"
                  onClick={() => onNavigate?.("automation")}
                >
                  管理模板
                </button>
              </div>
            </section>
          ) : null}

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

          <section className="runtime-console">
            <button
              type="button"
              className="runtime-console-toggle"
              onClick={() => setRuntimePanelOpen((value) => !value)}
            >
              <span>运行态</span>
              <strong>
                {runtimeStatus?.activeRun
                  ? `${runtimeStatus.activeRun.mode || "run"} · ${runtimeStatus.activeRun.status || "running"}`
                  : chat.isStreaming
                    ? "前台运行中"
                    : "空闲"}
              </strong>
              {runtimeStatus?.queueSize > 0 && <em>队列 {runtimeStatus.queueSize}</em>}
              {pendingInsertions.length > 0 && <em>待插入 {pendingInsertions.length}</em>}
            </button>

            {runtimePanelOpen && (
              <div className="runtime-console-body">
                <div className="runtime-console-grid">
                  <div>
                    <span>当前 Agent</span>
                    <strong>{runtimeStatus?.currentAgent?.agentType || chat.activeConversationSource || "primary"}</strong>
                  </div>
                  <div>
                    <span>Atomic</span>
                    <strong>{Number(runtimeStatus?.currentAgent?.atomicDepth ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Queue</span>
                    <strong>{Number(runtimeStatus?.queue?.length ?? runtimeStatus?.queueSize ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Messages</span>
                    <strong>{Number(messageStats.total ?? 0)}</strong>
                  </div>
                </div>

                {runtimeStatus?.messageStats && (
                  <div className="runtime-trace-line">
                    <span>消息统计</span>
                    <strong>
                      user {Number(messageStats.user ?? 0)} · assistant {Number(messageStats.assistant ?? 0)} · tool {Number(messageStats.tool ?? 0)} · other {Number(messageStats.other ?? 0)}
                    </strong>
                  </div>
                )}

                {approvalTimeline.length > 0 && (
                  <div className="runtime-timeline">
                    {approvalTimeline.slice(-5).map((item) => (
                      <div key={item.id} className="runtime-timeline-item">
                        <span>{item.label}</span>
                        <strong>{item.detail}</strong>
                      </div>
                    ))}
                  </div>
                )}

                {executionAutopsy && (
                  <div className="runtime-autopsy">
                    <strong>{executionAutopsy.title}</strong>
                    <span>{executionAutopsy.detail}</span>
                  </div>
                )}
              </div>
            )}
          </section>

          <div
            ref={chatStreamRef}
            className="chat-stream"
            onScroll={handleChatStreamScroll}
          >
            {chat.messages.length === 0 && !activeConversationRuntimeReplyError && (
              <div className="empty-note">发送第一条消息后，这里显示完整会话历史。</div>
            )}

            {chat.messages.length > 0 && orchestratorMessages.length > 0 && (
              <div className="orchestrator-digest">
                <button
                  type="button"
                  className="orchestrator-digest-toggle"
                  onClick={() => setOrchestratorLogOpen((value) => !value)}
                >
                  <span>系统动态 {orchestratorMessages.length} 条</span>
                  {latestOrchestratorNotice && (
                    <strong>{latestOrchestratorNotice.summary}</strong>
                  )}
                </button>
              </div>
            )}

            {visibleMessages.map((message, index) => {
              const isLastMessage = index === visibleMessages.length - 1;
              const isStreamingThisMessage = isLastMessage && chat.isStreaming && message.role === "assistant";
              const messageMetaKind = getMessageMetaKind(message);
              const isInternalToolImageMessage = messageMetaKind === "tool_image_input";
              const isRuntimeHookInjectedMessage = messageMetaKind === "runtime_hook_injected";
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
              const hasManualReasoningState = Object.prototype.hasOwnProperty.call(
                expandedReasoningMap,
                message.id
              );
              const isReasoningExpanded = hasManualReasoningState
                ? Boolean(expandedReasoningMap[message.id])
                : hasReasoningContent && !String(message.content ?? "").trim();
              const runtimeReplyErrorForMessage =
                message.role === "assistant" &&
                String(activeConversationRuntimeReplyError?.messageId ?? "").trim() === String(message.id ?? "").trim()
                  ? activeConversationRuntimeReplyError
                  : null;
              const orchestratorNotice = isOrchestratorMessage ? buildOrchestratorNotice(message) : null;
              const speakText = resolveMessageSpeakText({
                message,
                messageText,
                isRuntimeHookInjectedMessage,
                isOrchestratorMessage,
                orchestratorNotice,
                isCompressionSummary,
                isToolCard,
                toolPayload,
                hasImageAttachments: imageAttachments.length > 0,
                hasFileAttachments: parsedFileAttachments.length > 0
              });
              const isSpeakDisabled = !speakText;
              const isPlayingThisMessage = ttsPlayingMessageId === String(message.id ?? "").trim();
              const isLoadingThisMessage = ttsLoadingMessageId === String(message.id ?? "").trim();
              const isCopiedThisMessage = copiedMessageId === String(message.id ?? "").trim();
              const copyText = String(message.content ?? "").trim() || speakText;
              const canCopyMessage = copyText.length > 0;
              const showBubbleActionRow = canCopyMessage || !isSpeakDisabled;
              const copyButtonLabel = isCopiedThisMessage ? "已复制" : "复制消息";
              const speakButtonLabel = isPlayingThisMessage
                ? "停止朗读"
                : isLoadingThisMessage
                  ? "语音加载中..."
                  : "朗读消息";
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
                    isRuntimeHookInjectedMessage ? "bubble-runtime-hook-injected" : ""
                  } ${
                    isStreamingThisMessage ? "is-streaming" : ""
                  }`}
                >
                  {!isMemoryToolCard && !isOrchestratorMessage && (
                    <header>
                      <strong>
                        {isInternalToolImageMessage && "Tool Image Input"}
                        {message.role === "user" &&
                          !isInternalToolImageMessage &&
                          "User"}
                        {message.role === "assistant" && (isCompressionSummary ? "Compression" : "Assistant")}
                        {message.role === "tool" && "Tool"}
                        {message.role === "system" && "System"}
                      </strong>
                      {isInternalToolImageMessage && (
                        <span className="bubble-meta-badge is-tool-image-input">自动注入</span>
                      )}
                      {Number(message?.timestamp ?? 0) > 0 && (
                        <span>{formatTimestamp(Number(message.timestamp))}</span>
                      )}
                      {!isToolCard && deleteButton}
                    </header>
                  )}

                  {isRuntimeHookInjectedMessage ? (
                    <div className="runtime-hook-strip">
                      <span className="runtime-hook-strip-label">{getRuntimeHookStripText(message)}</span>
                    </div>
                  ) : isCompressionSummary ? (
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
                        {Number(message?.timestamp ?? 0) > 0 && (
                          <span>{formatTimestamp(Number(message.timestamp))}</span>
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
                        {Number(message?.timestamp ?? 0) > 0 && (
                          <span className="memory-tool-strip-time">
                            {formatTimestamp(Number(message.timestamp))}
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
                            onClick={() => toggleReasoningResult(message.id, isReasoningExpanded)}
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
                      {showBubbleActionRow && (
                        <div className="bubble-action-row">
                          <button
                            type="button"
                            className="bubble-action-btn bubble-action-btn-icon"
                            onClick={() => handleCopyMessageClick(message.id, copyText)}
                            disabled={!canCopyMessage}
                            title={copyButtonLabel}
                            aria-label={copyButtonLabel}
                          >
                            <BubbleCopyIcon copied={isCopiedThisMessage} />
                          </button>
                          <button
                            type="button"
                            className={`bubble-action-btn bubble-action-btn-icon ${isPlayingThisMessage ? "is-playing" : ""}`}
                            onClick={() => handleBubbleSpeakClick(message.id, speakText)}
                            disabled={isSpeakDisabled}
                            title={speakButtonLabel}
                            aria-label={speakButtonLabel}
                          >
                            {isLoadingThisMessage ? (
                              <span className="bubble-tts-spinner" aria-hidden="true" />
                            ) : (
                              <BubbleSpeakIcon playing={isPlayingThisMessage} />
                            )}
                          </button>
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
                  {Number(activeConversationRuntimeReplyError?.createdAt ?? 0) > 0 && (
                    <span>{formatTimestamp(Number(activeConversationRuntimeReplyError.createdAt))}</span>
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
                            className="composer-queue-insert"
                            onClick={() => chat.queueUserMessageAsInsertion(queueItem?.messageId)}
                            aria-label="转为运行中插入"
                            title="转为运行中插入"
                            disabled={!chat.isStreaming && !runtimeStatus?.activeRun}
                          >
                            插入
                          </button>
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

            {pendingInsertions.length > 0 && (
              <div className="composer-queue composer-insertion-queue" aria-label="等待插入队列">
                <div className="composer-queue-head">
                  <strong>等待插入</strong>
                  <span>{pendingInsertions.length} 条</span>
                </div>
                <div className="composer-queue-list">
                  {pendingInsertions.map((item) => (
                    <div
                      key={item.clientInsertionId || item.queueId || item.messageId}
                      className="composer-queue-item is-insertion"
                    >
                      <div className="composer-queue-index">↪</div>
                      <div className="composer-queue-main">
                        <strong title={String(item.content ?? "").trim()}>
                          {clipComposerQueueText(item.content || "运行中插入")}
                        </strong>
                        <span>{item.status || "queued"}</span>
                      </div>
                    </div>
                  ))}
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

            {chat.pendingApproval && (
              <div className="composer-approval-card" role="region" aria-live="polite">
                <header className="composer-approval-head">
                  <strong>{isClarifyApproval ? "待用户澄清" : "待审批工具调用"}</strong>
                  <span className="composer-approval-badge">
                    {chat.pendingApproval.approvalMode === "auto" ? "自动审批" : "确认审批"}
                  </span>
                </header>

                {isClarifyApproval ? (
                  <>
                    <div className="composer-clarify-question">
                      <strong>{clarifyQuestion || "请补充你的选择或说明。"}</strong>
                    </div>

                    {clarifyOptions.length > 0 ? (
                      <div className="composer-clarify-options" role="radiogroup" aria-label="澄清选项">
                        {clarifyOptions.map((option) => (
                          <label key={option} className="composer-clarify-option">
                            <input
                              type="radio"
                              name="clarify-option"
                              value={option}
                              checked={clarifySelectedOption === option}
                              onChange={() => setClarifySelectedOption(option)}
                              disabled={chat.isStreaming || chat.isCompressing}
                            />
                            <span>{option}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}

                    {clarifyAllowAdditionalText ? (
                      <textarea
                        className="composer-clarify-textarea"
                        value={clarifyAdditionalText}
                        onChange={(event) => setClarifyAdditionalText(event.target.value)}
                        placeholder="可补充说明（选填）"
                        rows={3}
                        disabled={chat.isStreaming || chat.isCompressing}
                      />
                    ) : null}

                    <div className="composer-approval-actions">
                      <button
                        type="button"
                        className="approval-confirm"
                        onClick={handleClarifyConfirm}
                        disabled={
                          chat.isStreaming ||
                          chat.isCompressing ||
                          (!String(clarifySelectedOption ?? "").trim() &&
                            !String(clarifyAdditionalText ?? "").trim())
                        }
                      >
                        提交澄清
                      </button>
                      <button
                        type="button"
                        className="approval-reject"
                        onClick={chat.rejectPendingApproval}
                        disabled={chat.isStreaming || chat.isCompressing}
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="composer-approval-body">
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

                    <pre className="composer-approval-json">
                      {JSON.stringify(chat.pendingApproval.arguments ?? {}, null, 2)}
                    </pre>

                    <div className="composer-approval-actions">
                      <button
                        type="button"
                        className="approval-confirm"
                        onClick={() => chat.confirmPendingApproval()}
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
                  </>
                )}
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

              <button
                type="button"
                className={`composer-voice-action voice-input-trigger ${isVoiceRecording ? "is-recording" : ""}`}
                onClick={handleVoiceInputClick}
                disabled={voiceInputDisabled}
                aria-label={isVoiceRecording ? "停止录音并转文字" : "开始语音输入"}
                title={
                  isVoiceTranscribing
                    ? "语音转写中..."
                    : isVoiceRecording
                      ? "停止录音并转文字"
                      : "语音输入"
                }
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 0 1-14 0" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v3" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 21h6" />
                </svg>
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
