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
