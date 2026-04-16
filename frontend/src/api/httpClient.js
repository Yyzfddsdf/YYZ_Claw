const API_BASE = "/api";

export async function requestJson(path, options = {}) {
  const { method = "GET", body, headers = {}, signal } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data?.error || `${method} ${path} failed with ${response.status}`);
  }

  return data;
}
