import { streamSseJson } from "./sseClient";
import { requestJson } from "./httpClient";

function parseEventSourceJson(data) {
  if (typeof data !== "string") {
    return data ?? null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function fetchHistories() {
  return requestJson("/chat/histories");
}

export function selectWorkplaceBySystemDialog(initialPath) {
  return requestJson("/chat/workplace/select", {
    method: "POST",
    body: {
      initialPath: String(initialPath ?? "")
    }
  });
}

export function fetchHistoryById(conversationId) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}`);
}

export function forkHistoryById(conversationId) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/fork`, {
    method: "POST"
  });
}

export function updateHistoryWorkplaceById(conversationId, workplacePath) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/workplace`, {
    method: "PUT",
    body: { workplacePath }
  });
}

export function updateHistoryApprovalModeById(conversationId, approvalMode) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/approval-mode`, {
    method: "PUT",
    body: { approvalMode }
  });
}

export function updateHistorySkillsById(conversationId, skills) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/skills`, {
    method: "PUT",
    body: { skills }
  });
}

export function updateHistoryDeveloperPromptById(conversationId, developerPrompt) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/developer-prompt`, {
    method: "PUT",
    body: { developerPrompt }
  });
}

export function upsertHistoryById(conversationId, payload) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}`, {
    method: "PUT",
    body: payload
  });
}

export function stopConversationRunById(conversationId) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/stop`, {
    method: "POST"
  });
}

export function compressHistoryById(conversationId, payload) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/compress`, {
    method: "POST",
    body: payload
  });
}

export function deleteHistoryById(conversationId) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}`, {
    method: "DELETE"
  });
}

export function clearHistoryById(conversationId) {
  return requestJson(`/chat/histories/${encodeURIComponent(conversationId)}/clear`, {
    method: "POST"
  });
}

export function deleteHistoryMessageById(conversationId, messageId) {
  return requestJson(
    `/chat/histories/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "DELETE"
    }
  );
}

export function fetchSkills(params = {}) {
  const query = new URLSearchParams();

  if (params.workspacePath) {
    query.set("workspacePath", String(params.workspacePath));
  }

  if (params.query) {
    query.set("query", String(params.query));
  }

  if (params.category) {
    query.set("category", String(params.category));
  }

  if (params.includeGlobal === false) {
    query.set("includeGlobal", "false");
  }

  if (params.includeProject === false) {
    query.set("includeProject", "false");
  }

  if (params.includeSystem === false) {
    query.set("includeSystem", "false");
  }

  if (Array.isArray(params.selectedSkillNames) && params.selectedSkillNames.length > 0) {
    query.set("selectedSkillNames", params.selectedSkillNames.join(","));
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson(`/skills${suffix}`);
}

export function fetchSkillByName(skillName, params = {}) {
  const query = new URLSearchParams();
  const workspacePath =
    params.workspacePath ?? params.workplacePath ?? params.workingDirectory ?? "";

  if (workspacePath) {
    query.set("workspacePath", String(workspacePath));
  }

  if (params.filePath) {
    query.set("filePath", String(params.filePath));
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson(`/skills/${encodeURIComponent(skillName)}${suffix}`);
}

export function validateSkillByName(skillName) {
  return requestJson(`/skills/${encodeURIComponent(skillName)}/validate`);
}

export function confirmToolApprovalById(
  approvalId,
  signal,
  onAgentEvent,
  confirmPayload = undefined
) {
  return streamSseJson({
    url: `/api/chat/tool-approvals/${encodeURIComponent(approvalId)}/confirm`,
    body: confirmPayload,
    signal,
    onMessage: (packet) => {
      if (packet.event === "agent" && packet.data && typeof packet.data === "object") {
        onAgentEvent?.(packet.data);
      }
    }
  });
}

export function rejectToolApprovalById(approvalId) {
  return requestJson(`/chat/tool-approvals/${encodeURIComponent(approvalId)}/reject`, {
    method: "POST"
  });
}

export function subscribeChatEvents({ onAgentEvent, onError } = {}) {
  const eventSource = new EventSource("/api/chat/events/subscribe");

  eventSource.addEventListener("agent", (event) => {
    const data = parseEventSourceJson(event?.data);
    if (data && typeof data === "object") {
      onAgentEvent?.(data);
    }
  });

  eventSource.onerror = (error) => {
    onError?.(error);
  };

  return () => {
    eventSource.close();
  };
}

export async function parseChatFiles(files, signal) {
  const normalizedFiles = Array.isArray(files)
    ? files.filter((file) => file && typeof file === "object")
    : [];

  if (normalizedFiles.length === 0) {
    return {
      files: [],
      truncatedFileCount: 0
    };
  }

  const formData = new FormData();
  for (const file of normalizedFiles) {
    const fileName = String(file?.name ?? "upload.bin").trim() || "upload.bin";
    formData.append("files", file, fileName);
  }

  const response = await fetch("/api/chat/files/parse", {
    method: "POST",
    body: formData,
    signal
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data?.error || `POST /chat/files/parse failed with ${response.status}`);
  }

  return data;
}

export async function streamChat({
  conversationId,
  messages,
  approvalMode,
  developerPrompt,
  enableDeepThinking,
  signal,
  onAgentEvent
}) {
  await streamSseJson({
    url: "/api/chat/stream",
    body: {
      conversationId,
      messages,
      approvalMode,
      developerPrompt,
      enableDeepThinking: Boolean(enableDeepThinking)
    },
    signal,
    onMessage: (packet) => {
      if (packet.event === "agent" && packet.data && typeof packet.data === "object") {
        onAgentEvent?.(packet.data);
      }
    }
  });
}
