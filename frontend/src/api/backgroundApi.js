import { requestJson } from "./httpClient";

export function fetchBackgrounds() {
  return requestJson("/backgrounds");
}

export function saveBackgroundSettings(settings) {
  return requestJson("/backgrounds/settings", {
    method: "POST",
    body: settings
  });
}

export async function uploadBackground(file) {
  const formData = new FormData();
  formData.append("background", file);

  const response = await fetch("/api/backgrounds/upload", {
    method: "POST",
    body: formData
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || `POST /backgrounds/upload failed with ${response.status}`);
  }
  return data;
}

export function deleteBackground(fileName) {
  return requestJson(`/backgrounds/${encodeURIComponent(fileName)}`, {
    method: "DELETE"
  });
}
