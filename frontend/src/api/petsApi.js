import { requestJson } from "./httpClient";

export function fetchPets() {
  return requestJson("/pets");
}

export function savePetSettings(settings) {
  return requestJson("/pets/settings", {
    method: "POST",
    body: settings
  });
}

export async function uploadPetPackage(files) {
  const formData = new FormData();
  for (const file of Array.isArray(files) ? files : []) {
    const relativeName = String(file?.webkitRelativePath || file?.name || "").trim();
    if (!relativeName) {
      continue;
    }
    formData.append("files", file, relativeName);
  }

  const response = await fetch("/api/pets/upload", {
    method: "POST",
    body: formData
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || `POST /pets/upload failed with ${response.status}`);
  }
  return data;
}
