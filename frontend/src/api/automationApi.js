import { requestJson } from "./httpClient";

export function fetchAutomationTasks() {
  return requestJson("/automation/tasks");
}

export function createAutomationTask(payload) {
  return requestJson("/automation/tasks", {
    method: "POST",
    body: payload
  });
}

export function updateAutomationTask(taskId, payload) {
  return requestJson(`/automation/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: payload
  });
}

export function deleteAutomationTask(taskId) {
  return requestJson(`/automation/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

export function runAutomationTaskNow(taskId) {
  return requestJson(`/automation/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST"
  });
}

export function fetchAutomationHistories() {
  return requestJson("/automation/histories");
}

export function deleteAutomationHistoryById(conversationId) {
  return requestJson(`/automation/histories/${encodeURIComponent(conversationId)}`, {
    method: "DELETE"
  });
}
