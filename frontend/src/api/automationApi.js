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

export function fetchAutomationBindings() {
  return requestJson("/automation/bindings");
}

export function upsertAutomationBinding(payload) {
  return requestJson("/automation/bindings", {
    method: "POST",
    body: payload
  });
}

export function updateAutomationBinding(bindingId, payload) {
  return requestJson(`/automation/bindings/${encodeURIComponent(bindingId)}`, {
    method: "PUT",
    body: payload
  });
}

export function deleteAutomationBinding(bindingId) {
  return requestJson(`/automation/bindings/${encodeURIComponent(bindingId)}`, {
    method: "DELETE"
  });
}

export function runAutomationBindingNow(bindingId) {
  return requestJson(`/automation/bindings/${encodeURIComponent(bindingId)}/run`, {
    method: "POST"
  });
}
