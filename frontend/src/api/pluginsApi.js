import { requestJson } from "./httpClient";

export function fetchPlugins() {
  return requestJson("/plugins");
}

export function refreshPlugins() {
  return requestJson("/plugins/refresh", {
    method: "POST"
  });
}
