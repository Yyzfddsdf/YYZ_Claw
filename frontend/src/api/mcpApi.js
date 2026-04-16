import { requestJson } from "./httpClient";

export function fetchMcpConfig() {
  return requestJson("/mcp-config");
}

export function saveMcpConfig(config) {
  return requestJson("/mcp-config", {
    method: "POST",
    body: config
  });
}
