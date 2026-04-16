import { requestJson } from "./httpClient";

export function fetchConfig() {
  return requestJson("/config");
}

export function saveConfig(config) {
  return requestJson("/config", {
    method: "POST",
    body: config
  });
}
