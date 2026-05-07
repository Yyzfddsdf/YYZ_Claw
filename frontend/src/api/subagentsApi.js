import { requestJson } from "./httpClient";

export function fetchSubagents() {
  return requestJson("/subagents");
}

export function createSubagent(payload) {
  return requestJson("/subagents", {
    method: "POST",
    body: payload
  });
}

export function updateSubagent(agentType, payload) {
  return requestJson(`/subagents/${encodeURIComponent(agentType)}`, {
    method: "PUT",
    body: payload
  });
}

export function deleteSubagent(agentType) {
  return requestJson(`/subagents/${encodeURIComponent(agentType)}`, {
    method: "DELETE"
  });
}
