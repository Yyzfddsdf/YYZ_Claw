import { requestJson } from "./httpClient";

export function fetchPersonas() {
  return requestJson("/personas");
}

export function createPersona(payload) {
  return requestJson("/personas", {
    method: "POST",
    body: payload
  });
}

export function updatePersona(personaId, payload) {
  return requestJson(`/personas/${encodeURIComponent(personaId)}`, {
    method: "PUT",
    body: payload
  });
}

export function deletePersona(personaId) {
  return requestJson(`/personas/${encodeURIComponent(personaId)}`, {
    method: "DELETE"
  });
}

export async function uploadPersonaAvatar(personaId, file) {
  const formData = new FormData();
  formData.append("avatar", file);
  const response = await fetch(`/api/personas/${encodeURIComponent(personaId)}/avatar`, {
    method: "POST",
    body: formData
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || `POST /personas/${personaId}/avatar failed with ${response.status}`);
  }
  return data;
}
