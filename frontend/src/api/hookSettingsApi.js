import { requestJson } from "./httpClient";

export function fetchHookSettings() {
  return requestJson("/hook-settings");
}

export function saveHookSettings(settings) {
  return requestJson("/hook-settings", {
    method: "POST",
    body: settings
  });
}
