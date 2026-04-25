import { requestJson } from "./httpClient";

export function fetchDebates() {
  return requestJson("/debates");
}

export function fetchDebateById(debateId) {
  return requestJson(`/debates/${encodeURIComponent(debateId)}`);
}

export function createDebate(payload) {
  return requestJson("/debates", {
    method: "POST",
    body: payload
  });
}

export function deleteDebate(debateId) {
  return requestJson(`/debates/${encodeURIComponent(debateId)}`, {
    method: "DELETE"
  });
}
