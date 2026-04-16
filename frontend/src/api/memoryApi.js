import { requestJson } from "./httpClient";

export function fetchMemoryTopics() {
  return requestJson("/memory/topics");
}

export function fetchMemoryTopicById(topicId) {
  return requestJson(`/memory/topics/${encodeURIComponent(topicId)}`);
}

export function createMemoryTopic(payload) {
  return requestJson("/memory/topics", {
    method: "POST",
    body: payload
  });
}

export function updateMemoryTopic(topicId, payload) {
  return requestJson(`/memory/topics/${encodeURIComponent(topicId)}`, {
    method: "PATCH",
    body: payload
  });
}

export function deleteMemoryTopic(topicId) {
  return requestJson(`/memory/topics/${encodeURIComponent(topicId)}`, {
    method: "DELETE"
  });
}

export function fetchMemoryContentById(contentId) {
  return requestJson(`/memory/contents/${encodeURIComponent(contentId)}`);
}

export function createMemoryContent(payload) {
  return requestJson("/memory/contents", {
    method: "POST",
    body: payload
  });
}

export function updateMemoryContent(contentId, payload) {
  return requestJson(`/memory/contents/${encodeURIComponent(contentId)}`, {
    method: "PATCH",
    body: payload
  });
}

export function deleteMemoryContent(contentId) {
  return requestJson(`/memory/contents/${encodeURIComponent(contentId)}`, {
    method: "DELETE"
  });
}

export function createMemoryNode(payload) {
  return requestJson("/memory/nodes", {
    method: "POST",
    body: payload
  });
}

export function createMemoryNodeRelation(payload) {
  return requestJson("/memory/node-relations", {
    method: "POST",
    body: payload
  });
}

export function updateMemoryNode(nodeId, payload) {
  return requestJson(`/memory/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PATCH",
    body: payload
  });
}

export function deleteMemoryNode(nodeId) {
  return requestJson(`/memory/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE"
  });
}
