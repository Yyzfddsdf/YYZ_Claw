import { requestJson } from "./httpClient";

export function fetchPlugins() {
  return requestJson("/plugins");
}

export function refreshPlugins() {
  return requestJson("/plugins/refresh", {
    method: "POST"
  });
}

export function setPluginEnabled(pluginName, enabled) {
  return requestJson(`/plugins/${encodeURIComponent(pluginName)}/enabled`, {
    method: "POST",
    body: {
      enabled: Boolean(enabled)
    }
  });
}
