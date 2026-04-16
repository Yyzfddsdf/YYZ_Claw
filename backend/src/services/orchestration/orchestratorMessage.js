export const ORCHESTRATOR_MESSAGE_KIND = "orchestrator_message";

function createMessageId(prefix = "orchestrator_msg") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeLineList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    : [];
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clipText(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function resolveAgentLabel(agentId) {
  const normalized = String(agentId ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("primary:")) {
    return "主智能体";
  }

  if (normalized.startsWith("subagent:")) {
    const parts = normalized.split(":");
    return clipText(parts[2] || "子智能体", 40);
  }

  return clipText(normalized, 40);
}

function resolveHeaderLabel(subtype, broadcastMode) {
  const normalizedSubtype = String(subtype ?? "").trim();
  const normalizedBroadcastMode = String(broadcastMode ?? "").trim();

  if (normalizedSubtype === "agent_dispatch") {
    return "调度";
  }

  if (normalizedSubtype === "subagent_finish_report") {
    return "完成";
  }

  if (normalizedSubtype === "agent_report" || normalizedSubtype.endsWith("_full")) {
    return "汇报";
  }

  if (normalizedSubtype.endsWith("_light") || normalizedBroadcastMode === "light") {
    return "广播";
  }

  return "调度器";
}

function buildVisibleLines(title, summaryLines, detailLines) {
  const seen = new Set();
  const visibleLines = [];
  const normalizedTitle = clipText(title, 120);

  for (const line of [...summaryLines, ...detailLines]) {
    const normalized = clipText(line, 320);
    if (!normalized) {
      continue;
    }

    if (normalizedTitle && normalized === normalizedTitle) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    visibleLines.push(normalized);
  }

  return visibleLines;
}

function buildPayloadPreview(payload) {
  if (payload === null || payload === undefined) {
    return "";
  }

  if (typeof payload === "string") {
    return clipText(payload, 200);
  }

  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }

  return "";
}

export function buildOrchestratorStructuredContent(options = {}) {
  const subtype = String(options.subtype ?? "generic").trim() || "generic";
  const broadcastMode = String(options.broadcastMode ?? "direct").trim() || "direct";
  const title = clipText(String(options.title ?? "").trim(), 120);
  const summaryLines = normalizeLineList(options.summaryLines);
  const detailLines = normalizeLineList(options.detailLines);
  const sourceLabel = resolveAgentLabel(options.sourceAgentId);
  const headerLabel = resolveHeaderLabel(subtype, broadcastMode);
  const subtypeSuffix =
    headerLabel === "调度器" && subtype !== "generic" ? `|${clipText(subtype, 40)}` : "";
  const header = sourceLabel
    ? `[${headerLabel}:${sourceLabel}${subtypeSuffix}]`
    : `[${headerLabel}${subtypeSuffix}]`;
  const visibleLines = buildVisibleLines(title, summaryLines, detailLines);
  const payloadPreview =
    !title && visibleLines.length === 0 ? buildPayloadPreview(options.payload) : "";
  const lines = [header];

  if (title) {
    lines.push(title);
  }

  if (visibleLines.length === 1 && !title) {
    lines.push(visibleLines[0]);
  } else {
    for (const line of visibleLines) {
      lines.push(`- ${line}`);
    }
  }

  if (payloadPreview) {
    lines.push(payloadPreview);
  }

  return lines.join("\n").trim();
}

export function buildOrchestratorMessage(options = {}) {
  const kind = String(options.kind ?? ORCHESTRATOR_MESSAGE_KIND).trim() || ORCHESTRATOR_MESSAGE_KIND;
  const subtype = String(options.subtype ?? "generic").trim() || "generic";
  const timestamp = Number(options.timestamp ?? Date.now());
  const metadata = normalizeMetadata(options.metadata);
  const content = buildOrchestratorStructuredContent({
    ...options,
    createdAt: timestamp
  });

  return {
    id: String(options.id ?? createMessageId()).trim() || createMessageId(),
    role: "user",
    content,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    meta: {
      kind,
      subtype,
      orchestrator: {
        sourceAgentId: String(options.sourceAgentId ?? "").trim(),
        targetAgentId: String(options.targetAgentId ?? "").trim(),
        deliveryMode: String(options.deliveryMode ?? "queued_after_atomic").trim()
          || "queued_after_atomic",
        broadcastMode: String(options.broadcastMode ?? "direct").trim() || "direct",
        sessionId: String(options.sessionId ?? "").trim(),
        atomicStepId: String(options.atomicStepId ?? "").trim(),
        title: String(options.title ?? "").trim(),
        summaryLines: normalizeLineList(options.summaryLines),
        detailLines: normalizeLineList(options.detailLines),
        payload: options.payload ?? null,
        metadata
      }
    }
  };
}
