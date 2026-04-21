import { requestJson } from "./httpClient";

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  if (Number.isFinite(Number(params.limit)) && Number(params.limit) > 0) {
    query.set("limit", String(Math.trunc(Number(params.limit))));
  }
  if (Number.isFinite(Number(params.cursor)) && Number(params.cursor) > 0) {
    query.set("cursor", String(Math.trunc(Number(params.cursor))));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function fetchRemoteControlConfig() {
  return requestJson("/remote-control/config");
}

export function saveRemoteControlConfig(payload) {
  return requestJson("/remote-control/config", {
    method: "POST",
    body: payload
  });
}

export function fetchRemoteControlRecords(params = {}) {
  return requestJson(`/remote-control/records${buildQuery(params)}`);
}

export function fetchRemoteControlStatus() {
  return requestJson("/remote-control/status");
}

export function enqueueRemoteControlMessage(payload) {
  return requestJson("/remote-control/messages", {
    method: "POST",
    body: payload
  });
}

export function flushRemoteControlQueue() {
  return requestJson("/remote-control/flush", {
    method: "POST"
  });
}
