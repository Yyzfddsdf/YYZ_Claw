import { requestJson } from "./httpClient";

export function fetchRemoteControlConfig() {
  return requestJson("/remote-control/config");
}

export function saveRemoteControlConfig(payload) {
  return requestJson("/remote-control/config", {
    method: "POST",
    body: payload
  });
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
