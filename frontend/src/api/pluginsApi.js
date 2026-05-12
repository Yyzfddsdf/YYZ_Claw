import { requestJson } from "./httpClient";

export function fetchPlugins() {
  return requestJson("/plugins");
}

export function refreshPlugins() {
  return requestJson("/plugins/refresh", {
    method: "POST"
  });
}

export function fetchPluginMarketplaces() {
  return requestJson("/plugin-marketplaces");
}

export function addPluginMarketplace(payload) {
  return requestJson("/plugin-marketplaces", {
    method: "POST",
    body: payload
  });
}

export function fetchMarketplacePlugins() {
  return requestJson("/plugin-marketplaces/plugins");
}

export function installMarketplacePlugin(plugin) {
  return requestJson("/plugin-marketplaces/plugins/install", {
    method: "POST",
    body: { plugin }
  });
}
