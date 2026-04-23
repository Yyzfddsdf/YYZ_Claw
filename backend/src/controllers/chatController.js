import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  approvalModeSchema,
  chatRequestSchema,
  conversationApprovalModeSchema,
  conversationCompressionSchema
} from "../schemas/chatSchema.js";
import { configSchema } from "../schemas/configSchema.js";
import {
  conversationSkillsSchema,
  conversationDeveloperPromptSchema,
  conversationUpsertSchema,
  conversationWorkplaceSchema
} from "../schemas/historySchema.js";
import {
  DEFAULT_HISTORY_TITLE,
  DEFAULT_WORKPLACE_PATH,
  buildCompressionSnapshotMetadata,
  buildCompressionTokenSnapshot,
  buildConversationPromptMessages,
  buildForkTitle,
  createValidationError,
  extractFirstSentence,
  isAutoTitleCandidate,
  loadApprovalRules,
  normalizeUsageRecordPayload,
  resolvePinnedMemorySummaryPrompt,
  resolveAgentRuntimeConfig,
  scheduleAsyncTitleGeneration
} from "../services/chat/conversationRuntimeShared.js";
import { AgentConversationRecorder } from "../services/orchestration/AgentConversationRecorder.js";
import { resolveSubagentCompletionDispatchRequest } from "../services/orchestration/subagentCompletionShared.js";
import { isAbortError } from "../services/runs/runAbort.js";
import { endSse, initSse, writeSseEvent } from "../services/stream/SseChannel.js";

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function buildAgentMeta(agent) {
  if (!agent) {
    return null;
  }

  return {
    agentId: String(agent.agentId ?? "").trim(),
    agentType: String(agent.agentType ?? "").trim(),
    agentDisplayName: String(agent.displayName ?? "").trim(),
    agentStatus: String(agent.status ?? "idle").trim() || "idle",
    agentBusy: String(agent.status ?? "").trim() === "running"
  };
}

function resolveSkillOwnerHistory(history, historyStore) {
  if (!history) {
    return null;
  }

  const source = String(history?.source ?? "").trim().toLowerCase();
  if (source !== "subagent") {
    return history;
  }

  const parentConversationId = String(history?.parentConversationId ?? "").trim();
  if (!parentConversationId) {
    return history;
  }

  return historyStore?.getConversation?.(parentConversationId) ?? history;
}

function getEffectiveHistorySkills(history, historyStore) {
  const skillOwnerHistory = resolveSkillOwnerHistory(history, historyStore);
  return Array.isArray(skillOwnerHistory?.skills)
    ? skillOwnerHistory.skills
    : Array.isArray(history?.skills)
      ? history.skills
      : [];
}

function enrichHistorySummary(history, orchestratorStore, historyStore) {
  if (!history) {
    return history;
  }

  const source = String(history?.source ?? "").trim().toLowerCase();
  const agent = orchestratorStore?.findAgentByConversationId?.(history.id) ?? null;
  const sessionId = source === "subagent"
    ? String(history.parentConversationId ?? "").trim()
    : String(history.id ?? "").trim();
  const childAgents =
    source === "subagent"
      ? []
      : orchestratorStore?.listAgents?.(sessionId, { includePrimary: false }) ?? [];

  return {
    ...history,
    skills: getEffectiveHistorySkills(history, historyStore),
    ...(buildAgentMeta(agent) ?? {}),
    subagentCount: Array.isArray(childAgents) ? childAgents.length : 0
  };
}

function enrichHistoryDetail(history, orchestratorStore, historyStore) {
  const summary = enrichHistorySummary(history, orchestratorStore, historyStore);
  if (!summary) {
    return summary;
  }

  const source = String(summary?.source ?? "").trim().toLowerCase();
  if (source === "subagent") {
    return {
      ...summary,
      subagents: []
    };
  }

  const sessionId = String(summary.id ?? "").trim();
  const subagents = orchestratorStore?.listAgents?.(sessionId, { includePrimary: false }) ?? [];
  return {
    ...summary,
    subagents: subagents.map((agent) => ({
      ...buildAgentMeta(agent),
      conversationId: String(agent?.conversationId ?? "").trim(),
      lastActiveAt: Number(agent?.lastActiveAt ?? 0)
    }))
  };
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseJsonField(rawValue, fieldName) {
  if (typeof rawValue !== "string") {
    return rawValue;
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    throw createValidationError(`${fieldName} must be valid JSON`);
  }
}

function normalizeStreamRequestBody(body) {
  const raw = body && typeof body === "object" ? body : {};
  const messages = parseJsonField(raw.messages, "messages");

  return {
    ...raw,
    messages: Array.isArray(messages) ? messages : raw.messages,
    enableDeepThinking: parseBooleanFlag(raw.enableDeepThinking)
  };
}

function normalizeMessageMeta(meta) {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

function parseJsonIfString(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return {};
    }
    try {
      const parsed = JSON.parse(normalized);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveClarifyApprovalInput(body = {}) {
  const approvalInput =
    body?.approvalInput && typeof body.approvalInput === "object" && !Array.isArray(body.approvalInput)
      ? body.approvalInput
      : {};
  return {
    selectedOption: String(approvalInput?.selectedOption ?? "").trim(),
    additionalText: String(approvalInput?.additionalText ?? "").trim()
  };
}

function applyClarifyApprovalInput(pendingApproval, clarifyInput = {}) {
  if (!pendingApproval || String(pendingApproval?.toolName ?? "").trim() !== "clarify") {
    return pendingApproval;
  }

  const selectedOption = String(clarifyInput?.selectedOption ?? "").trim();
  const additionalText = String(clarifyInput?.additionalText ?? "").trim();
  const hasInput = Boolean(selectedOption || additionalText);
  if (!hasInput) {
    return pendingApproval;
  }

  const toolCalls = Array.isArray(pendingApproval.toolCalls) ? pendingApproval.toolCalls : [];
  const targetToolCallId = String(pendingApproval.toolCallId ?? "").trim();
  const nextToolCalls = toolCalls.map((toolCall) => {
    const toolName = String(toolCall?.function?.name ?? "").trim();
    const toolCallId = String(toolCall?.id ?? "").trim();
    const isTargetClarifyCall =
      toolName === "clarify" && (!targetToolCallId || targetToolCallId === toolCallId);
    if (!isTargetClarifyCall) {
      return toolCall;
    }

    const parsedArguments = parseJsonIfString(toolCall?.function?.arguments);
    const nextArguments = {
      ...parsedArguments,
      selectedOption,
      additionalText
    };

    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify(nextArguments)
      }
    };
  });

  const parsedToolArguments = parseJsonIfString(pendingApproval.toolArguments);
  const nextToolArguments = JSON.stringify({
    ...parsedToolArguments,
    selectedOption,
    additionalText
  });

  return {
    ...pendingApproval,
    toolArguments: nextToolArguments,
    toolCalls: nextToolCalls
  };
}

function mergeParsedFilesIntoMessages(messages, parsedFilePayload) {
  const parsedFiles = Array.isArray(parsedFilePayload?.files) ? parsedFilePayload.files : [];

  if (!Array.isArray(messages) || messages.length === 0 || parsedFiles.length === 0) {
    return Array.isArray(messages) ? messages : [];
  }

  const nextMessages = messages.map((message) => ({
    ...message,
    meta: normalizeMessageMeta(message?.meta)
  }));

  let targetUserMessageIndex = -1;
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    if (String(nextMessages[index]?.role ?? "").trim() === "user") {
      targetUserMessageIndex = index;
      break;
    }
  }

  if (targetUserMessageIndex < 0) {
    return nextMessages;
  }

  const targetMessage = nextMessages[targetUserMessageIndex];
  const nextMeta = normalizeMessageMeta(targetMessage.meta);
  const previousFiles = Array.isArray(nextMeta.parsedFiles) ? nextMeta.parsedFiles : [];
  const truncatedFileCount = Number(parsedFilePayload?.truncatedFileCount ?? 0);

  nextMeta.parsedFiles = [...previousFiles, ...parsedFiles];

  if (truncatedFileCount > 0) {
    nextMeta.parsedFilesTruncatedCount = truncatedFileCount;
  }

  nextMessages[targetUserMessageIndex] = {
    ...targetMessage,
    meta: nextMeta
  };

  return nextMessages;
}

function findLastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (String(candidate?.role ?? "").trim() === "user") {
      return candidate;
    }
  }

  return null;
}

function resolveWorkplacePath(inputPath) {
  const candidate = String(inputPath ?? "").trim();
  return candidate ? path.resolve(candidate) : DEFAULT_WORKPLACE_PATH;
}

async function ensureDirectoryPath(inputPath) {
  const resolvedPath = resolveWorkplacePath(inputPath);

  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    throw createValidationError("workplacePath does not exist");
  }

  if (!stats.isDirectory()) {
    throw createValidationError("workplacePath must be a directory");
  }

  return resolvedPath;
}

function runDialogCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: options.encoding ?? "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(options.env
          ? {
              env: {
                ...process.env,
                ...options.env
              }
            }
          : {})
      },
      (error, stdout, stderr) => {
        resolve({
          error: error ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        });
      }
    );
  });
}

async function selectDirectoryFromSystemDialogWindows(initialPath) {
  const initial = String(initialPath ?? "").trim();
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$initial = $env:WORKPLACE_INITIAL_PATH",
    "$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Location = New-Object System.Drawing.Point([int]($screen.X + ($screen.Width / 2)), [int]($screen.Y + ($screen.Height / 2)))",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
    "$owner.TopMost = $true",
    "$owner.Opacity = 0",
    "$owner.Show()",
    "$owner.BringToFront()",
    "$owner.Activate()",
    "[System.Windows.Forms.Application]::DoEvents()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择会话工作区目录'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "$owner.Dispose()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  Write-Output $dialog.SelectedPath",
    "  exit 0",
    "}",
    "exit 2"
  ].join("; ");

  const result = await runDialogCommand(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: {
        WORKPLACE_INITIAL_PATH: initial
      }
    }
  );

  if (result.error) {
    if (Number(result.error.code) === 2) {
      return { canceled: true, selectedPath: "" };
    }

    throw new Error(
      String(result.stderr ?? result.error.message ?? "open folder dialog failed").trim()
    );
  }

  const selectedPath = String(result.stdout ?? "").trim();
  if (!selectedPath) {
    return { canceled: true, selectedPath: "" };
  }

  return {
    canceled: false,
    selectedPath
  };
}

async function selectDirectoryFromSystemDialogMac(initialPath) {
  const initial = String(initialPath ?? "").trim();
  const appleScript = [
    "set initialPath to system attribute \"WORKPLACE_INITIAL_PATH\"",
    "if initialPath is \"\" then",
    "  try",
    "    set selectedFolder to choose folder with prompt \"选择会话工作区目录\"",
    "  on error number -128",
    "    return \"__CANCELED__\"",
    "  end try",
    "else",
    "  try",
    "    set selectedFolder to choose folder with prompt \"选择会话工作区目录\" default location (POSIX file initialPath)",
    "  on error",
    "    try",
    "      set selectedFolder to choose folder with prompt \"选择会话工作区目录\"",
    "    on error number -128",
    "      return \"__CANCELED__\"",
    "    end try",
    "  end try",
    "end if",
    "return POSIX path of selectedFolder"
  ].join("\n");

  const result = await runDialogCommand("osascript", ["-e", appleScript], {
    encoding: "utf8",
    env: {
      WORKPLACE_INITIAL_PATH: initial
    }
  });

  if (result.error) {
    const errorCode = String(result.error.code ?? "").trim().toUpperCase();
    if (errorCode === "ENOENT") {
      const unsupportedError = new Error("macOS 缺少 osascript，无法打开系统目录选择器");
      unsupportedError.statusCode = 501;
      throw unsupportedError;
    }

    throw new Error(String(result.stderr ?? result.error.message ?? "open folder dialog failed").trim());
  }

  const selectedPath = String(result.stdout ?? "").trim();
  if (!selectedPath || selectedPath === "__CANCELED__") {
    return { canceled: true, selectedPath: "" };
  }

  return {
    canceled: false,
    selectedPath
  };
}

async function selectDirectoryFromSystemDialogLinux(initialPath) {
  const initial = String(initialPath ?? "").trim();
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const unsupportedError = new Error("当前 Linux 环境无图形会话，无法打开目录选择器");
    unsupportedError.statusCode = 501;
    throw unsupportedError;
  }

  const normalizedInitial = initial ? path.resolve(initial) : "";
  const candidates = [
    normalizedInitial
      ? {
          command: "zenity",
          args: [
            "--file-selection",
            "--directory",
            "--title=选择会话工作区目录",
            "--filename",
            `${normalizedInitial}${path.sep}`
          ]
        }
      : {
          command: "zenity",
          args: ["--file-selection", "--directory", "--title=选择会话工作区目录"]
        },
    normalizedInitial
      ? {
          command: "kdialog",
          args: ["--getexistingdirectory", normalizedInitial, "选择会话工作区目录"]
        }
      : {
          command: "kdialog",
          args: ["--getexistingdirectory", String(process.cwd() ?? "/"), "选择会话工作区目录"]
        }
  ];

  let lastFailureMessage = "";
  let missingCommandCount = 0;

  for (const candidate of candidates) {
    const result = await runDialogCommand(candidate.command, candidate.args, {
      encoding: "utf8"
    });
    const stderrText = String(result.stderr ?? "").trim();

    if (!result.error) {
      const selectedPath = String(result.stdout ?? "").trim();
      if (!selectedPath) {
        return { canceled: true, selectedPath: "" };
      }
      return {
        canceled: false,
        selectedPath
      };
    }

    const errorCode = String(result.error.code ?? "").trim().toUpperCase();
    if (errorCode === "ENOENT") {
      missingCommandCount += 1;
      continue;
    }

    const exitCode = Number(result.error.code);
    if (Number.isFinite(exitCode) && exitCode === 1) {
      return { canceled: true, selectedPath: "" };
    }

    lastFailureMessage =
      stderrText || String(result.error.message ?? "").trim() || "open folder dialog failed";
  }

  if (missingCommandCount >= candidates.length) {
    const unsupportedError = new Error(
      "Linux 缺少目录选择器依赖，请安装 zenity 或 kdialog 后重试"
    );
    unsupportedError.statusCode = 501;
    throw unsupportedError;
  }

  throw new Error(lastFailureMessage || "open folder dialog failed");
}

async function selectDirectoryFromSystemDialog(initialPath) {
  if (process.platform === "win32") {
    return selectDirectoryFromSystemDialogWindows(initialPath);
  }

  if (process.platform === "darwin") {
    return selectDirectoryFromSystemDialogMac(initialPath);
  }

  if (process.platform === "linux") {
    return selectDirectoryFromSystemDialogLinux(initialPath);
  }

  const unsupportedError = new Error(
    `system folder picker is unsupported on platform: ${process.platform}`
  );
  unsupportedError.statusCode = 501;
  throw unsupportedError;
}

function attachForegroundRunResponse(req, res, run, conversationRunCoordinator) {
  if (
    !run ||
    !conversationRunCoordinator ||
    typeof conversationRunCoordinator.attachSseResponse !== "function"
  ) {
    return () => {};
  }

  const detachSse = conversationRunCoordinator.attachSseResponse(run, res, {
    listenerId: `foreground_response_${String(run.runId ?? "").trim()}`
  });

  let disconnected = false;
  const handleClientDisconnect = () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    cleanup();
  };

  const cleanup = () => {
    detachSse?.();
    req.off?.("aborted", handleClientDisconnect);
    req.off?.("error", handleClientDisconnect);
    req.off?.("close", handleClientDisconnect);
  };

  req.on?.("aborted", handleClientDisconnect);
  req.on?.("error", handleClientDisconnect);
  req.on?.("close", handleClientDisconnect);

  return cleanup;
}

function attachForegroundRunBroadcast(run, conversationRunCoordinator) {
  if (
    !run ||
    !conversationRunCoordinator ||
    typeof conversationRunCoordinator.attachConversationBroadcast !== "function"
  ) {
    return () => {};
  }

  const runId = String(run.runId ?? "").trim();
  return conversationRunCoordinator.attachConversationBroadcast(run, {
    listenerId: runId ? `foreground_broadcast_${runId}` : "foreground_broadcast"
  });
}

function emitRunEvent(run, payload, conversationRunCoordinator, res) {
  const emitted =
    conversationRunCoordinator &&
    typeof conversationRunCoordinator.emitEvent === "function" &&
    run
      ? conversationRunCoordinator.emitEvent(run, payload)
      : false;

  if (!emitted) {
    writeSseEvent(res, "agent", payload);
  }
}

function beginManualCompressionReplayRun({
  conversationId,
  conversationRunCoordinator
}) {
  if (
    !conversationRunCoordinator ||
    typeof conversationRunCoordinator.beginRun !== "function"
  ) {
    return {
      run: null,
      ownsRun: false,
      detachBroadcast: () => {}
    };
  }

  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return {
      run: null,
      ownsRun: false,
      detachBroadcast: () => {}
    };
  }

  const existingRun =
    conversationRunCoordinator.getRunByConversationId?.(normalizedConversationId) ?? null;
  if (existingRun) {
    return {
      run: existingRun,
      ownsRun: false,
      detachBroadcast: () => {}
    };
  }

  const manualRun = conversationRunCoordinator.beginRun({
    sessionId: normalizedConversationId,
    agentId: "manual_compression",
    conversationId: normalizedConversationId,
    mode: "background",
    status: "running"
  });
  const detachBroadcast =
    conversationRunCoordinator.attachConversationBroadcast?.(manualRun, {
      listenerId: `manual_compression_broadcast_${normalizedConversationId}`
    }) ?? (() => {});

  return {
    run: manualRun,
    ownsRun: true,
    detachBroadcast
  };
}

function isManualCompressionRun(run) {
  if (!run || typeof run !== "object") {
    return false;
  }

  return String(run.agentId ?? "").trim() === "manual_compression";
}

export function createChatController({
  chatAgent,
  toolRegistry,
  configStore,
  historyStore,
  memoryStore,
  compressionService,
  attachmentParserService,
  approvalRulesStore,
  agentsPromptStore,
  memorySummaryStore,
  memorySummaryService,
  skillValidator,
  skillPromptBuilder,
  skillCatalog,
  conversationAgentRuntimeService,
  conversationEventBroadcaster,
  conversationRunCoordinator,
  orchestratorStore,
  orchestratorSchedulerService,
  orchestratorSupervisorService,
  wakeDispatcher
}) {
  return {
    parseUploadedFiles: async (req, res) => {
      const uploadedFiles = Array.isArray(req.files) ? req.files : [];

      if (uploadedFiles.length === 0) {
        throw createValidationError("at least one file is required");
      }

      if (
        !attachmentParserService ||
        typeof attachmentParserService.parseFiles !== "function"
      ) {
        throw createValidationError("attachment parser service is unavailable");
      }

      const parsedFilePayload = await attachmentParserService.parseFiles(uploadedFiles);

      res.json({
        files: Array.isArray(parsedFilePayload?.files) ? parsedFilePayload.files : [],
        truncatedFileCount: Number(parsedFilePayload?.truncatedFileCount ?? 0)
      });
    },

    selectWorkplaceBySystemDialog: async (req, res) => {
      const requestedInitialPath = String(req.body?.initialPath ?? "").trim();
      let initialPath = DEFAULT_WORKPLACE_PATH;

      if (requestedInitialPath) {
        try {
          initialPath = await ensureDirectoryPath(requestedInitialPath);
        } catch {
          initialPath = DEFAULT_WORKPLACE_PATH;
        }
      }

      const result = await selectDirectoryFromSystemDialog(initialPath);

      if (result.canceled) {
        return res.json({ canceled: true });
      }

      const selectedPath = await ensureDirectoryPath(result.selectedPath);
      res.json({
        canceled: false,
        selectedPath
      });
    },

    listHistories: async (_req, res) => {
      const histories = historyStore.listConversations({
        excludeSources: ["automation"]
      }).map((history) =>
        enrichHistorySummary(history, orchestratorStore, historyStore)
      );
      res.json({ histories });
    },

    getHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const history = historyStore.getConversation(conversationId);

      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({ history: enrichHistoryDetail(history, orchestratorStore, historyStore) });
    },

    subscribeConversationEvents: async (req, res) => {
      initSse(res);

      if (
        !conversationEventBroadcaster ||
        typeof conversationEventBroadcaster.subscribe !== "function"
      ) {
        writeSseEvent(res, "agent", {
          conversationId: "",
          type: "error",
          message: "conversation event broadcaster is unavailable"
        });
        endSse(res);
        return;
      }

      const unsubscribe = conversationEventBroadcaster.subscribe(res);
      if (
        conversationRunCoordinator &&
        typeof conversationRunCoordinator.replayActiveRunsToSse === "function"
      ) {
        conversationRunCoordinator.replayActiveRunsToSse(res, { eventName: "agent" });
      }
      req.on("close", unsubscribe);
      req.on("error", unsubscribe);
    },

    stopRunByConversationId: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();
      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const activeRun =
        conversationRunCoordinator?.getRunByConversationId?.(conversationId) ?? null;
      if (!activeRun) {
        return res.json({
          success: true,
          stopped: false
        });
      }

      conversationRunCoordinator?.abortRun?.(activeRun, "stopped by user");
      res.json({
        success: true,
        stopped: true,
        runId: String(activeRun.runId ?? "").trim()
      });
    },

    forkHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const history = historyStore.getConversation(conversationId);
      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      if (String(history?.source ?? "").trim().toLowerCase() === "subagent") {
        const conflictError = createValidationError("subagent conversation does not support fork");
        conflictError.statusCode = 409;
        throw conflictError;
      }

      const forkedHistory = historyStore.cloneConversationAsFork(conversationId, {
        conversationId: `conv_${randomUUID()}`,
        title: buildForkTitle(history.title),
        workplacePath: history.workplacePath,
        approvalMode: history.approvalMode,
        developerPrompt: history.developerPrompt,
        skills: history.skills,
        model: history.model
      });

      res.status(201).json({
        history: enrichHistoryDetail(forkedHistory, orchestratorStore, historyStore)
      });
    },

    updateWorkplaceById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationWorkplaceSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const history = historyStore.getConversation(conversationId);
      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const workplacePath = await ensureDirectoryPath(validation.data.workplacePath);

      if (history.workplaceLocked && history.workplacePath !== workplacePath) {
        const lockedError = createValidationError("workplace is locked for this conversation");
        lockedError.statusCode = 409;
        throw lockedError;
      }

      if (history.workplaceLocked) {
        return res.json({
          history: enrichHistoryDetail(history, orchestratorStore, historyStore),
          locked: true
        });
      }

      const updated = historyStore.updateConversationWorkplace(conversationId, workplacePath);
      res.json({
        history: enrichHistoryDetail(updated, orchestratorStore, historyStore),
        locked: false
      });
    },

    updateApprovalModeById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationApprovalModeSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const history = historyStore.getConversation(conversationId);
      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const updated = historyStore.updateConversationApprovalMode(
        conversationId,
        validation.data.approvalMode
      );

      res.json({
        history: enrichHistoryDetail(updated, orchestratorStore, historyStore),
        approvalMode: validation.data.approvalMode
      });
    },

    updateSkillsById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationSkillsSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const history = historyStore.getConversation(conversationId);
      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const targetConversationId =
        String(history?.source ?? "").trim().toLowerCase() === "subagent" &&
        String(history?.parentConversationId ?? "").trim()
          ? String(history.parentConversationId).trim()
          : conversationId;

      const updatedTarget = historyStore.updateConversationSkills(
        targetConversationId,
        validation.data.skills
      );
      const responseHistory =
        targetConversationId === conversationId
          ? updatedTarget
          : historyStore.getConversation(conversationId) ?? updatedTarget;

      res.json({
        history: enrichHistoryDetail(responseHistory, orchestratorStore, historyStore),
        skills: validation.data.skills,
        skillOwnerConversationId: targetConversationId
      });
    },

    updateDeveloperPromptById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationDeveloperPromptSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const history = historyStore.getConversation(conversationId);
      if (!history) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const updated = historyStore.updateConversationDeveloperPrompt(
        conversationId,
        validation.data.developerPrompt
      );

      res.json({
        history: enrichHistoryDetail(updated, orchestratorStore, historyStore),
        developerPrompt: validation.data.developerPrompt
      });
    },

    compressHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationCompressionSchema.safeParse(req.body);
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const existing = historyStore.getConversation(conversationId);
      if (!existing) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const configValidation = configSchema.safeParse(await configStore.read());
      if (!configValidation.success) {
        throw createValidationError(
          "config/config.json is invalid. Save model/baseURL/apiKey from frontend first."
        );
      }

      const latestTokenUsage = existing?.tokenUsage ?? null;
      const manualReplayRunContext = beginManualCompressionReplayRun({
        conversationId,
        conversationRunCoordinator
      });
      let compressionResult = null;

      if (manualReplayRunContext.run) {
        conversationRunCoordinator.emitEvent?.(manualReplayRunContext.run, {
          type: "compression_started",
          trigger: validation.data.trigger
        });
      }

      try {
        compressionResult = await compressionService.compressConversation({
          messages: validation.data.messages,
          runtimeConfig: configValidation.data,
          latestTokenUsage,
          trigger: validation.data.trigger
        });
      } catch (error) {
        if (manualReplayRunContext.run) {
          conversationRunCoordinator.emitEvent?.(manualReplayRunContext.run, {
            type: "compression_completed",
            trigger: validation.data.trigger,
            compression: {
              compressed: false,
              reason: String(error?.message || "manual_compression_failed"),
              usageRatio: 0,
              estimatedTokensBefore: 0,
              estimatedTokensAfter: 0
            }
          });
        }
        manualReplayRunContext.detachBroadcast?.();
        if (manualReplayRunContext.ownsRun && manualReplayRunContext.run) {
          conversationRunCoordinator.finishRun?.(manualReplayRunContext.run, {
            status: "error"
          });
        }
        throw error;
      }

      const nextMessages = Array.isArray(compressionResult?.messages)
        ? compressionResult.messages
        : validation.data.messages;

      let history = historyStore.upsertConversation({
        conversationId,
        title: existing.title,
        workplacePath: existing.workplacePath,
        parentConversationId: existing.parentConversationId,
        source: existing.source,
        model: existing.model,
        approvalMode: existing.approvalMode,
        skills: existing.skills,
        developerPrompt: existing.developerPrompt,
        messages: nextMessages
      });

      if (compressionResult?.compressed) {
        const snapshot = buildCompressionTokenSnapshot(compressionResult);
        if (snapshot) {
          history =
            historyStore.updateConversationTokenSnapshot(
              conversationId,
              snapshot,
              buildCompressionSnapshotMetadata(compressionResult, existing?.model)
            ) ?? history;
        }
      }

      memorySummaryService?.scheduleRefresh?.({
        conversationId
      });

      const enrichedHistory = enrichHistoryDetail(history, orchestratorStore, historyStore);
      if (manualReplayRunContext.run) {
        conversationRunCoordinator.emitEvent?.(manualReplayRunContext.run, {
          type: "compression_completed",
          trigger: validation.data.trigger,
          history: enrichedHistory,
          compression: {
            compressed: Boolean(compressionResult?.compressed),
            reason: String(compressionResult?.reason ?? ""),
            usageRatio: Number(compressionResult?.usageRatio ?? 0),
            estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
            estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0)
          }
        });
      }

      manualReplayRunContext.detachBroadcast?.();
      if (manualReplayRunContext.ownsRun && manualReplayRunContext.run) {
        conversationRunCoordinator.finishRun?.(manualReplayRunContext.run, {
          status: "idle"
        });
      }

      res.json({
        history: enrichedHistory,
        compression: {
          compressed: Boolean(compressionResult?.compressed),
          reason: String(compressionResult?.reason ?? ""),
          usageRatio: Number(compressionResult?.usageRatio ?? 0),
          estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
          estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0),
          trigger: validation.data.trigger
        }
      });
    },

    upsertHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const validation = conversationUpsertSchema.safeParse(req.body);

      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const existing = historyStore.getConversation(conversationId);

      const requestedWorkplacePath = String(validation.data.workplacePath ?? "").trim();
      const workplacePath = requestedWorkplacePath
        ? await ensureDirectoryPath(requestedWorkplacePath)
        : undefined;
      const developerPrompt = String(validation.data.developerPrompt ?? "").trim();

      if (
        existing?.workplaceLocked &&
        workplacePath &&
        String(existing.workplacePath) !== workplacePath
      ) {
        const lockedError = createValidationError("workplace is locked for this conversation");
        lockedError.statusCode = 409;
        throw lockedError;
      }

      if (!existing && validation.data.messages.length === 0) {
        const reusableEmptyConversation = historyStore.findLatestEmptyConversation();
        if (reusableEmptyConversation) {
          return res.json({
            history: reusableEmptyConversation,
            reusedConversation: true
          });
        }

        const emptyConversationError = createValidationError(
          "at least one message is required to create a conversation"
        );
        emptyConversationError.statusCode = 400;
        throw emptyConversationError;
      }

      let title = String(validation.data.title ?? "").trim();
      const firstUserMessage = validation.data.messages.find(
        (item) => item.role === "user" && item.content.trim().length > 0
      );
      const firstSentence = extractFirstSentence(firstUserMessage?.content);

      if (isAutoTitleCandidate(title) && !isAutoTitleCandidate(existing?.title)) {
        title = String(existing.title).trim();
      }

      if (isAutoTitleCandidate(title)) {
        title = DEFAULT_HISTORY_TITLE;
      }

      let history = historyStore.mergeConversation({
        conversationId,
        title,
        workplacePath,
        parentConversationId: existing?.parentConversationId,
        source: existing?.source,
        model: existing?.model,
        approvalMode: validation.data.approvalMode,
        skills: validation.data.skills,
        developerPrompt,
        messages: validation.data.messages
      });

      if (firstUserMessage && !history.workplaceLocked) {
        history = historyStore.lockConversationWorkplace(conversationId) ?? history;
      }

      if (isAutoTitleCandidate(title)) {
        scheduleAsyncTitleGeneration({
          conversationId,
          firstSentence,
          configStore,
          historyStore
        });
      }

      res.json({ history: enrichHistoryDetail(history, orchestratorStore, historyStore) });
    },

    deleteHistoryById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const deletedConversationIds = new Set();
      const markDeletedConversationId = (targetConversationId) => {
        const normalizedTargetConversationId = String(targetConversationId ?? "").trim();
        if (!normalizedTargetConversationId) {
          return "";
        }

        deletedConversationIds.add(normalizedTargetConversationId);
        return normalizedTargetConversationId;
      };

      const collectConversationSubtreePostOrder = (
        rootConversationId,
        visitedConversationIds = new Set(),
        orderedConversationIds = []
      ) => {
        const normalizedRootConversationId = String(rootConversationId ?? "").trim();
        if (
          !normalizedRootConversationId ||
          visitedConversationIds.has(normalizedRootConversationId)
        ) {
          return orderedConversationIds;
        }

        visitedConversationIds.add(normalizedRootConversationId);
        const rootConversation = historyStore.getConversation(normalizedRootConversationId);
        if (!rootConversation) {
          return orderedConversationIds;
        }

        const childConversations = historyStore.listChildConversations(normalizedRootConversationId);
        for (const childConversation of childConversations) {
          collectConversationSubtreePostOrder(
            String(childConversation?.id ?? "").trim(),
            visitedConversationIds,
            orderedConversationIds
          );
        }

        orderedConversationIds.push(normalizedRootConversationId);
        return orderedConversationIds;
      };

      const ensureDeletedConversation = (targetConversationId) => {
        const normalizedTargetConversationId = markDeletedConversationId(targetConversationId);
        if (!normalizedTargetConversationId) {
          return;
        }

        if (!historyStore.getConversation(normalizedTargetConversationId)) {
          return;
        }

        historyStore.deleteConversation(normalizedTargetConversationId);
      };

      const history = historyStore.getConversation(conversationId);
      if (history) {
        const source = String(history?.source ?? "").trim().toLowerCase();
        if (source === "subagent") {
          const subtreeConversationIds = collectConversationSubtreePostOrder(conversationId);
          const agent = orchestratorStore?.findAgentByConversationId?.(conversationId) ?? null;
          if (agent?.agentId) {
            orchestratorSupervisorService.deleteSubagent({
              conversationId: history.parentConversationId,
              agentId: agent.agentId
            });
          }

          if (subtreeConversationIds.length > 0) {
            for (const subtreeConversationId of subtreeConversationIds) {
              ensureDeletedConversation(subtreeConversationId);
            }
          } else {
            ensureDeletedConversation(conversationId);
          }
        } else {
          const runtimeSubagents = orchestratorSupervisorService.listSubagents(conversationId);
          const runtimeAgentIdByConversationId = new Map();
          for (const runtimeSubagent of runtimeSubagents) {
            const runtimeSubagentConversationId = String(runtimeSubagent?.conversationId ?? "").trim();
            const runtimeSubagentAgentId = String(runtimeSubagent?.agentId ?? "").trim();
            if (!runtimeSubagentConversationId || !runtimeSubagentAgentId) {
              continue;
            }
            runtimeAgentIdByConversationId.set(runtimeSubagentConversationId, runtimeSubagentAgentId);
          }

          const deletedRuntimeAgentIds = new Set();
          const historySubagents = historyStore.listChildConversations(conversationId, {
            source: "subagent"
          });
          for (const historySubagent of historySubagents) {
            const subagentConversationId = String(historySubagent?.id ?? "").trim();
            if (!subagentConversationId) {
              continue;
            }

            const subagentSubtreeConversationIds = collectConversationSubtreePostOrder(
              subagentConversationId
            );
            const runtimeAgentId =
              runtimeAgentIdByConversationId.get(subagentConversationId) ||
              String(
                orchestratorStore?.findAgentByConversationId?.(subagentConversationId)?.agentId ?? ""
              ).trim();

            if (runtimeAgentId && !deletedRuntimeAgentIds.has(runtimeAgentId)) {
              orchestratorSupervisorService.deleteSubagent({
                conversationId,
                agentId: runtimeAgentId
              });
              deletedRuntimeAgentIds.add(runtimeAgentId);
            }

            if (subagentSubtreeConversationIds.length > 0) {
              for (const subtreeConversationId of subagentSubtreeConversationIds) {
                ensureDeletedConversation(subtreeConversationId);
              }
            } else {
              ensureDeletedConversation(subagentConversationId);
            }
          }

          for (const runtimeSubagent of runtimeSubagents) {
            const runtimeSubagentAgentId = String(runtimeSubagent?.agentId ?? "").trim();
            if (!runtimeSubagentAgentId || deletedRuntimeAgentIds.has(runtimeSubagentAgentId)) {
              continue;
            }

            const runtimeSubagentConversationId = String(runtimeSubagent?.conversationId ?? "").trim();
            const subagentSubtreeConversationIds = runtimeSubagentConversationId
              ? collectConversationSubtreePostOrder(runtimeSubagentConversationId)
              : [];

            orchestratorSupervisorService.deleteSubagent({
              conversationId,
              agentId: runtimeSubagentAgentId
            });
            deletedRuntimeAgentIds.add(runtimeSubagentAgentId);

            if (subagentSubtreeConversationIds.length > 0) {
              for (const subtreeConversationId of subagentSubtreeConversationIds) {
                ensureDeletedConversation(subtreeConversationId);
              }
            } else {
              ensureDeletedConversation(runtimeSubagentConversationId);
            }
          }

          ensureDeletedConversation(conversationId);
          orchestratorStore?.deleteSession?.(conversationId);
          orchestratorSchedulerService?.resetSession?.(conversationId);
        }
      }
      res.status(200).json({
        success: true,
        deletedConversationIds: Array.from(deletedConversationIds)
      });
    },

    deleteHistoryMessageById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();
      const messageId = String(req.params.messageId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      if (!messageId) {
        throw createValidationError("messageId is required");
      }

      const deleteResult = historyStore.deleteConversationMessage(conversationId, messageId);
      if (!deleteResult) {
        const notFoundError = createValidationError("message not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({
        history: enrichHistoryDetail(deleteResult.history, orchestratorStore, historyStore),
        deletedMessageIds: Array.isArray(deleteResult.deletedMessageIds)
          ? deleteResult.deletedMessageIds
          : []
      });
    },

    clearHistoryMessagesById: async (req, res) => {
      const conversationId = String(req.params.conversationId || "").trim();

      if (!conversationId) {
        throw createValidationError("conversationId is required");
      }

      const clearedHistory = historyStore.clearConversationMessages(conversationId);
      if (!clearedHistory) {
        const notFoundError = createValidationError("history not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({
        history: enrichHistoryDetail(clearedHistory, orchestratorStore, historyStore)
      });
    },

    confirmToolApprovalById: async (req, res) => {
      const approvalId = String(req.params.approvalId || "").trim();

      if (!approvalId) {
        throw createValidationError("approvalId is required");
      }

      const pendingApproval = historyStore.getPendingToolApproval(approvalId);
      if (!pendingApproval) {
        const notFoundError = createValidationError("pending approval not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      if (pendingApproval.status !== "pending") {
        const conflictError = createValidationError("pending approval is no longer pending");
        conflictError.statusCode = 409;
        throw conflictError;
      }

      const clarifyInput = resolveClarifyApprovalInput(req.body ?? {});
      const isClarifyApproval = String(pendingApproval?.toolName ?? "").trim() === "clarify";
      if (isClarifyApproval && !clarifyInput.selectedOption && !clarifyInput.additionalText) {
        throw createValidationError("clarify approval requires selectedOption or additionalText");
      }
      const resolvedPendingApproval = applyClarifyApprovalInput(pendingApproval, clarifyInput);

      initSse(res);
      let foregroundStatus = "idle";
      let foregroundRun = null;
      let detachForegroundRunResponse = () => {};
      let detachForegroundRunBroadcast = () => {};
      let resolvedRuntime = null;
      let runResult = null;
      let executionContext = null;
      let completionDispatchRequest = null;

      try {
        if (toolRegistry && typeof toolRegistry.refresh === "function") {
          await toolRegistry.refresh();
        }

        orchestratorSupervisorService?.ensureSession?.(resolvedPendingApproval.conversationId);
        const resumedHistory = historyStore.getConversation(resolvedPendingApproval.conversationId);
        resolvedRuntime =
          conversationAgentRuntimeService &&
          typeof conversationAgentRuntimeService.resolveConversationRuntime === "function"
            ? await conversationAgentRuntimeService.resolveConversationRuntime(
                resolvedPendingApproval.conversationId
              )
            : {
                history: resumedHistory,
                sessionId: String(
                  resolvedPendingApproval.executionContext?.sessionId ?? resolvedPendingApproval.conversationId
                ).trim(),
                agentId: String(resolvedPendingApproval.executionContext?.agentId ?? "").trim(),
                agentType: String(resolvedPendingApproval.executionContext?.agentType ?? "primary").trim(),
                isSubagent:
                  String(resumedHistory?.source ?? "").trim().toLowerCase() === "subagent",
                activeSkillNames: Array.isArray(resolvedPendingApproval.executionContext?.activeSkillNames)
                  ? resolvedPendingApproval.executionContext.activeSkillNames
                  : [],
                developerPrompt: String(
                  resolvedPendingApproval.executionContext?.developerPrompt ?? ""
                ).trim(),
                definitionPrompt: "",
                chatAgent
              };
        const runtimeChatAgent = resolvedRuntime?.chatAgent ?? chatAgent;
        const runtimeModel = String(resolvedPendingApproval.runtimeConfig?.model ?? "").trim();
        const recorder = new AgentConversationRecorder({
          initialMessages: Array.isArray(resumedHistory?.messages) ? resumedHistory.messages : []
        });

        foregroundRun = wakeDispatcher?.beginForegroundRun?.({
          sessionId: resolvedRuntime?.sessionId,
          agentId: resolvedRuntime?.agentId,
          conversationId: resolvedPendingApproval.conversationId,
          allowExistingRun: true,
          allowRestore: true
        }) ?? null;
        detachForegroundRunBroadcast = attachForegroundRunBroadcast(
          foregroundRun,
          conversationRunCoordinator
        );
        detachForegroundRunResponse = attachForegroundRunResponse(
          req,
          res,
          foregroundRun,
          conversationRunCoordinator
        );

        emitRunEvent(
          foregroundRun,
          {
          type: "session_resume",
          approvalId,
          conversationId: resolvedPendingApproval.conversationId
          },
          conversationRunCoordinator,
          res
        );

        executionContext = {
          ...(resolvedPendingApproval.executionContext ?? {}),
          conversationId: resolvedPendingApproval.conversationId,
          runId: foregroundRun?.runId,
          sessionId: resolvedRuntime?.sessionId,
          agentId: resolvedRuntime?.agentId,
          agentType: resolvedRuntime?.agentType,
          currentAtomicStepId: foregroundRun?.stepId,
          abortSignal: foregroundRun?.signal ?? null,
          historyStore,
          rawConversationMessages: Array.isArray(resumedHistory?.messages)
            ? resumedHistory.messages
            : [],
          runtimeConfig: resolvedPendingApproval.runtimeConfig,
          memoryStore,
          skillCatalog,
          skillValidator,
          skillPromptBuilder,
          activeSkillNames: Array.isArray(resolvedRuntime?.activeSkillNames)
            ? resolvedRuntime.activeSkillNames
            : [],
          developerPrompt: String(
              resolvedRuntime?.developerPrompt ??
              resolvedPendingApproval.executionContext?.developerPrompt ??
              ""
          ).trim(),
          orchestratorStore,
          orchestratorSchedulerService,
          orchestratorSupervisorService
        };

        runResult = await runtimeChatAgent.resumePendingApproval({
          pendingApproval: resolvedPendingApproval,
          runtimeConfig: resolvedPendingApproval.runtimeConfig,
          approvalStore: historyStore,
          approvalRules: await loadApprovalRules(approvalRulesStore),
          executionContext,
          onEvent: (payload) => {
            if (payload?.type === "usage") {
              const usage = normalizeUsageRecordPayload(payload.usage);
              if (usage) {
                historyStore.recordConversationTokenUsage(
                  resolvedPendingApproval.conversationId,
                  usage,
                  {
                    model: String(payload.model ?? runtimeModel ?? "").trim()
                  }
                );
                recorder.applyEvent({
                  ...payload,
                  usage
                });
              }
            } else {
              recorder.applyEvent(payload);
            }

            emitRunEvent(foregroundRun, payload, conversationRunCoordinator, res);
          }
        });

        const nextMessages = recorder.getMessages();
        const updatedResumedHistory = historyStore.mergeConversation({
          conversationId: resolvedPendingApproval.conversationId,
          title: resumedHistory?.title,
          workplacePath: resumedHistory?.workplacePath,
          parentConversationId: resumedHistory?.parentConversationId,
          source: resumedHistory?.source,
          model: runtimeModel || resumedHistory?.model,
          approvalMode: resumedHistory?.approvalMode,
          skills: resumedHistory?.skills,
          developerPrompt: resumedHistory?.developerPrompt,
          messages: nextMessages
        });

        historyStore.updatePendingToolApprovalStatus(approvalId, "completed");

        if (runResult?.status !== "pending_approval") {
          memorySummaryService?.scheduleRefresh?.({
            conversationId: resolvedPendingApproval.conversationId
          });
        }

        if (runResult?.status === "pending_approval") {
          foregroundStatus = "waiting_approval";
          emitRunEvent(
            foregroundRun,
            {
            type: "session_pause",
            pendingApprovalId: runResult.approvalId,
            toolCallId: runResult.toolCallId,
            toolName: runResult.toolName,
            history: updatedResumedHistory
            },
            conversationRunCoordinator,
            res
          );
        } else {
          foregroundStatus = "idle";
          emitRunEvent(
            foregroundRun,
            {
            type: "session_end",
            history: updatedResumedHistory
            },
            conversationRunCoordinator,
            res
          );
        }

        completionDispatchRequest = resolveSubagentCompletionDispatchRequest({
          executionContext,
          runResult,
          status: foregroundStatus,
          displayName:
            orchestratorStore?.findAgentByConversationId?.(resolvedPendingApproval.conversationId)
              ?.displayName ?? "",
          agentType: resolvedRuntime?.agentType
        });
      } catch (error) {
        foregroundStatus = isAbortError(error) ? "idle" : "error";
        historyStore.updatePendingToolApprovalStatus(approvalId, "failed");
        if (!isAbortError(error)) {
          emitRunEvent(
            foregroundRun,
            {
              type: "error",
              message: error?.message || "approval confirmation failed"
            },
            conversationRunCoordinator,
            res
          );
        } else if (!res.writableEnded) {
          emitRunEvent(
            foregroundRun,
            {
              type: "session_end",
              status: "aborted"
            },
            conversationRunCoordinator,
            res
          );
        }
      } finally {
        detachForegroundRunResponse?.();
        detachForegroundRunBroadcast?.();
        if (foregroundRun) {
          await wakeDispatcher?.finishForegroundRun?.({
            sessionId: foregroundRun.sessionId,
            agentId: foregroundRun.agentId,
            status: foregroundStatus
          });
        }
        if (completionDispatchRequest) {
          await orchestratorSupervisorService?.dispatchCompletionToPrimary?.(completionDispatchRequest);
        }
        endSse(res);
      }
    },

    rejectToolApprovalById: async (req, res) => {
      const approvalId = String(req.params.approvalId || "").trim();

      if (!approvalId) {
        throw createValidationError("approvalId is required");
      }

      const pendingApproval = historyStore.getPendingToolApproval(approvalId);
      if (!pendingApproval) {
        const notFoundError = createValidationError("pending approval not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const sessionInfo =
        orchestratorSupervisorService?.ensureSession?.(pendingApproval.conversationId) ?? null;
      const agentRecord =
        orchestratorStore?.findAgentByConversationId?.(pendingApproval.conversationId) ?? null;
      const sessionId = String(
        pendingApproval.executionContext?.sessionId ??
          sessionInfo?.sessionId ??
          pendingApproval.conversationId
      ).trim();
      const agentId = String(
        pendingApproval.executionContext?.agentId ??
          agentRecord?.agentId ??
          sessionInfo?.primaryAgentId ??
          ""
      ).trim();

      historyStore.updatePendingToolApprovalStatus(approvalId, "rejected");

      if (sessionId && agentId) {
        await wakeDispatcher?.finishForegroundRun?.({
          sessionId,
          agentId,
          status: "idle"
        });
      }

      res.json({ success: true, approvalId });
    },

    streamChat: async (req, res) => {
      const normalizedRequestBody = normalizeStreamRequestBody(req.body);
      const chatValidation = chatRequestSchema.safeParse(normalizedRequestBody);
      if (!chatValidation.success) {
        throw createValidationError(formatZodError(chatValidation.error));
      }
      const streamConversationId = String(chatValidation.data.conversationId ?? "").trim();
      if (!streamConversationId) {
        throw createValidationError("conversationId is required");
      }
      const activeConversationRun =
        conversationRunCoordinator?.getRunByConversationId?.(streamConversationId) ?? null;
      if (isManualCompressionRun(activeConversationRun)) {
        const compressionInProgressError = createValidationError(
          "conversation compression is in progress; queue message and retry after compression completes"
        );
        compressionInProgressError.statusCode = 409;
        throw compressionInProgressError;
      }

      const configValidation = configSchema.safeParse(await configStore.read());
      if (!configValidation.success) {
        throw createValidationError(
          "config/config.json is invalid. Save model/baseURL/apiKey from frontend first."
        );
      }

      initSse(res);
      let foregroundRun = null;
      let foregroundStatus = "idle";
      let detachForegroundRunResponse = () => {};
      let detachForegroundRunBroadcast = () => {};
      let currentConversationId = "";
      let resolvedRuntime = null;
      let runResult = null;
      let executionContext = null;
      let completionDispatchRequest = null;

      try {
        if (toolRegistry && typeof toolRegistry.refresh === "function") {
          await toolRegistry.refresh();
        }

        const conversationId = streamConversationId;
        currentConversationId = conversationId;

        let existingConversation = historyStore.getConversation(conversationId);
        const firstUserMessage = chatValidation.data.messages.find(
          (item) => item.role === "user" && item.content.trim().length > 0
        );
        const firstSentence = extractFirstSentence(firstUserMessage?.content);

        if (
          conversationId &&
          existingConversation &&
          !existingConversation.workplaceLocked &&
          firstUserMessage
        ) {
          const lockedConversation = historyStore.lockConversationWorkplace(conversationId);
          if (lockedConversation) {
            existingConversation = lockedConversation;
          }
        }

        const workplacePath = String(existingConversation?.workplacePath ?? "").trim() ||
          DEFAULT_WORKPLACE_PATH;
        const approvalMode = approvalModeSchema.parse(
          chatValidation.data.approvalMode ?? existingConversation?.approvalMode ?? "confirm"
        );
        const persistedSkillNames = Array.isArray(existingConversation?.skills)
          ? existingConversation.skills
          : [];
        const conversationSource = String(existingConversation?.source ?? "").trim().toLowerCase();
        const historyRuntimeConfig = resolveAgentRuntimeConfig(configValidation.data, {
          isSubagent: conversationSource === "subagent"
        });
        const developerPrompt =
          conversationSource === "subagent"
            ? String(existingConversation?.developerPrompt ?? "").trim()
            : String(
                chatValidation.data.developerPrompt ?? existingConversation?.developerPrompt ?? ""
              ).trim();
        let effectiveMessages = Array.isArray(chatValidation.data.messages)
          ? chatValidation.data.messages
          : [];

        const sessionInfo =
          orchestratorSupervisorService?.ensureSession?.(conversationId) ?? null;
        resolvedRuntime =
          conversationAgentRuntimeService &&
          typeof conversationAgentRuntimeService.resolveConversationRuntime === "function"
            ? await conversationAgentRuntimeService.resolveConversationRuntime(conversationId)
            : {
                history: existingConversation,
                sessionId: String(sessionInfo?.sessionId ?? conversationId).trim(),
                agentId: String(
                  orchestratorStore?.findAgentByConversationId?.(conversationId)?.agentId ??
                    sessionInfo?.primaryAgentId ??
                    ""
                ).trim(),
                agentType:
                  String(existingConversation?.source ?? "").trim().toLowerCase() === "subagent"
                    ? "subagent"
                    : "primary",
                isSubagent:
                  String(existingConversation?.source ?? "").trim().toLowerCase() === "subagent",
                activeSkillNames: persistedSkillNames,
                developerPrompt,
                definitionPrompt: "",
                chatAgent
              };
        const runtimeChatAgent = resolvedRuntime?.chatAgent ?? chatAgent;
        const runtimeExecutionConfig = resolveAgentRuntimeConfig(configValidation.data, {
          isSubagent: Boolean(resolvedRuntime?.isSubagent),
          enableDeepThinking: Boolean(chatValidation.data.enableDeepThinking)
        });

        const nextForegroundRun = wakeDispatcher?.beginForegroundRun?.({
          sessionId: resolvedRuntime?.sessionId,
          agentId: resolvedRuntime?.agentId,
          conversationId
        }) ?? null;
        if (nextForegroundRun?.busy) {
          const busyError = createValidationError("conversation agent is already running");
          busyError.statusCode = 409;
          throw busyError;
        }
        foregroundRun = nextForegroundRun;
        detachForegroundRunBroadcast = attachForegroundRunBroadcast(
          foregroundRun,
          conversationRunCoordinator
        );
        detachForegroundRunResponse = attachForegroundRunResponse(
          req,
          res,
          foregroundRun,
          conversationRunCoordinator
        );

        if (effectiveMessages.length > 0) {
          existingConversation = historyStore.mergeConversation({
            conversationId,
            title: String(existingConversation?.title ?? DEFAULT_HISTORY_TITLE),
            workplacePath,
            parentConversationId: existingConversation?.parentConversationId,
            source: existingConversation?.source,
            model: historyRuntimeConfig.model,
            approvalMode,
            skills: persistedSkillNames,
            developerPrompt,
            messages: effectiveMessages
          });

          effectiveMessages = Array.isArray(existingConversation?.messages)
            ? existingConversation.messages
            : effectiveMessages;
        }

        if (conversationId && firstSentence) {
          if (existingConversation && isAutoTitleCandidate(existingConversation.title)) {
            scheduleAsyncTitleGeneration({
              conversationId,
              firstSentence,
              configStore,
              historyStore
            });
          }
        }

        emitRunEvent(
          foregroundRun,
          { type: "session_start" },
          conversationRunCoordinator,
          res
        );

        const shouldAutoCompress = compressionService.shouldAutoCompress({
          messages: effectiveMessages,
          maxContextWindow: configValidation.data.maxContextWindow,
          latestTokenUsage: existingConversation?.tokenUsage ?? null
        });

        if (shouldAutoCompress) {
          emitRunEvent(
            foregroundRun,
            {
              type: "compression_started",
              trigger: "auto"
            },
            conversationRunCoordinator,
            res
          );

          const compressionResult = await compressionService.compressConversation({
            messages: effectiveMessages,
            runtimeConfig: configValidation.data,
            latestTokenUsage: existingConversation?.tokenUsage ?? null,
            trigger: "auto"
          });

          if (compressionResult?.compressed && Array.isArray(compressionResult.messages)) {
            let updatedHistory = historyStore.upsertConversation({
              conversationId,
              title: existingConversation?.title,
              workplacePath: existingConversation?.workplacePath,
              parentConversationId: existingConversation?.parentConversationId,
              source: existingConversation?.source,
              model: existingConversation?.model,
              approvalMode: existingConversation?.approvalMode,
              skills: existingConversation?.skills,
              developerPrompt: existingConversation?.developerPrompt,
              messages: compressionResult.messages
            });

            const compressionSnapshot = buildCompressionTokenSnapshot(compressionResult);
            if (compressionSnapshot) {
              updatedHistory =
                historyStore.updateConversationTokenSnapshot(
                  conversationId,
                  compressionSnapshot,
                  buildCompressionSnapshotMetadata(compressionResult, existingConversation?.model)
                ) ?? updatedHistory;
            }

            existingConversation = updatedHistory ?? existingConversation;
            effectiveMessages = Array.isArray(updatedHistory?.messages)
              ? updatedHistory.messages
              : compressionResult.messages;

            emitRunEvent(
              foregroundRun,
              {
                type: "compression_completed",
                trigger: "auto",
                history: updatedHistory,
                compression: {
                  compressed: true,
                  reason: String(compressionResult?.reason ?? ""),
                  usageRatio: Number(compressionResult?.usageRatio ?? 0),
                  estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
                  estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0)
                }
              },
              conversationRunCoordinator,
              res
            );
          } else {
            emitRunEvent(
              foregroundRun,
              {
                type: "compression_completed",
                trigger: "auto",
                compression: {
                  compressed: false,
                  reason: String(compressionResult?.reason ?? "auto_compression_skipped"),
                  usageRatio: Number(compressionResult?.usageRatio ?? 0),
                  estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
                  estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0)
                }
              },
              conversationRunCoordinator,
              res
            );
          }
        }

        const modelHistoryMessages = compressionService.buildModelMessages(effectiveMessages);
        const recorder = new AgentConversationRecorder({
          initialMessages: effectiveMessages
        });
        const pinnedMemorySummaryPrompt = await resolvePinnedMemorySummaryPrompt({
          historyStore,
          memorySummaryStore,
          conversationId,
          workspacePath: workplacePath,
          existingConversation
        });
        const promptMessages = await buildConversationPromptMessages({
          agentsPromptStore,
          memorySummaryStore,
          skillPromptBuilder,
          workspacePath: workplacePath,
          memorySummaryPrompt: pinnedMemorySummaryPrompt,
          developerPrompt: resolvedRuntime?.developerPrompt,
          activeSkillNames: Array.isArray(resolvedRuntime?.activeSkillNames)
            ? resolvedRuntime.activeSkillNames
            : [],
          definitionPrompt: resolvedRuntime?.definitionPrompt,
          includeAgentsPrompt: !resolvedRuntime?.isSubagent,
          includeMemorySummaryPrompt: !resolvedRuntime?.isSubagent,
          includeSubagentGuardPrompt: Boolean(resolvedRuntime?.isSubagent)
        });

        executionContext = {
          conversationId,
          runId: foregroundRun?.runId,
          sessionId: resolvedRuntime?.sessionId,
          agentId: resolvedRuntime?.agentId,
          agentType: resolvedRuntime?.agentType,
          currentAtomicStepId: foregroundRun?.stepId,
          abortSignal: foregroundRun?.signal ?? null,
          workplacePath,
          workingDirectory: workplacePath,
          historyStore,
          rawConversationMessages: effectiveMessages,
          runtimeConfig: runtimeExecutionConfig,
          memoryStore,
          skillCatalog,
          skillValidator,
          skillPromptBuilder,
          activeSkillNames: Array.isArray(resolvedRuntime?.activeSkillNames)
            ? resolvedRuntime.activeSkillNames
            : [],
          developerPrompt: String(resolvedRuntime?.developerPrompt ?? "").trim(),
          orchestratorStore,
          orchestratorSchedulerService,
          orchestratorSupervisorService
        };

        runResult = await runtimeChatAgent.run({
          messages: [
            ...promptMessages,
            ...modelHistoryMessages
          ],
          runtimeConfig: runtimeExecutionConfig,
          executionContext,
          approvalMode,
          approvalStore: historyStore,
          approvalRules: await loadApprovalRules(approvalRulesStore),
          onEvent: (payload) => {
            if (payload?.type === "usage") {
              const usage = normalizeUsageRecordPayload(payload.usage);
              if (usage) {
                historyStore.recordConversationTokenUsage(conversationId, usage, {
                  model: String(payload.model ?? runtimeExecutionConfig.model ?? "").trim()
                });
                recorder.applyEvent({
                  ...payload,
                  usage
                });
              }
            } else {
              recorder.applyEvent(payload);
            }

            emitRunEvent(foregroundRun, payload, conversationRunCoordinator, res);
          }
        });

        const nextMessages = recorder.getMessages();
        existingConversation = historyStore.mergeConversation({
          conversationId,
          title: existingConversation?.title,
          workplacePath: existingConversation?.workplacePath,
          parentConversationId: existingConversation?.parentConversationId,
          source: existingConversation?.source,
          model: runtimeExecutionConfig.model,
          approvalMode: existingConversation?.approvalMode ?? approvalMode,
          skills: existingConversation?.skills,
          developerPrompt: existingConversation?.developerPrompt,
          messages: nextMessages
        });

        if (
          !resolvedRuntime?.isSubagent &&
          runResult?.status !== "pending_approval"
        ) {
          memorySummaryService?.scheduleRefresh?.({
            conversationId
          });
        }

        if (runResult?.status === "pending_approval") {
          foregroundStatus = "waiting_approval";
          emitRunEvent(
            foregroundRun,
            {
            type: "session_pause",
            pendingApprovalId: runResult.approvalId,
            toolCallId: runResult.toolCallId,
            toolName: runResult.toolName,
            history: existingConversation
            },
            conversationRunCoordinator,
            res
          );
        } else {
          foregroundStatus = "idle";
          emitRunEvent(
            foregroundRun,
            {
            type: "session_end",
            history: existingConversation
            },
            conversationRunCoordinator,
            res
          );
        }

        completionDispatchRequest = resolveSubagentCompletionDispatchRequest({
          executionContext,
          runResult,
          status: foregroundStatus,
          displayName:
            orchestratorStore?.findAgentByConversationId?.(conversationId)?.displayName ?? "",
          agentType: resolvedRuntime?.agentType
        });
      } catch (error) {
        foregroundStatus = isAbortError(error) ? "idle" : "error";
        if (!isAbortError(error)) {
          emitRunEvent(
            foregroundRun,
            {
              type: "error",
              message: error?.message || "chat stream failed"
            },
            conversationRunCoordinator,
            res
          );
        } else if (!res.writableEnded) {
          emitRunEvent(
            foregroundRun,
            {
              type: "session_end",
              status: "aborted"
            },
            conversationRunCoordinator,
            res
          );
        }
      } finally {
        detachForegroundRunResponse?.();
        detachForegroundRunBroadcast?.();
        if (foregroundRun) {
          await wakeDispatcher?.finishForegroundRun?.({
            sessionId: foregroundRun.sessionId,
            agentId: foregroundRun.agentId,
            status: foregroundStatus
          });
        }
        if (completionDispatchRequest) {
          await orchestratorSupervisorService?.dispatchCompletionToPrimary?.(completionDispatchRequest);
        }
        endSse(res);
      }
    }
  };
}
