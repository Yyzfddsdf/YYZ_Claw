const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const MAX_TEXT_LENGTH = 12000;

function normalizeBaseUrl(value) {
  const candidate = String(value ?? "").trim();
  return candidate || DEFAULT_TAVILY_BASE_URL;
}

function normalizeApiKey(value) {
  return String(value ?? "").trim();
}

function clipText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function normalizeSearchItem(item = {}, index = 0) {
  return {
    id: `result_${index + 1}`,
    title: String(item?.title ?? "").trim(),
    url: String(item?.url ?? "").trim(),
    content: clipText(item?.content ?? ""),
    score: Number(item?.score ?? 0)
  };
}

async function requestJson({ baseUrl, path, apiKey, payload }) {
  const endpoint = `${normalizeBaseUrl(baseUrl)}${path}`;
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload, api_key: apiKey }
      : { api_key: apiKey };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(normalizedPayload)
  });

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = String(json?.detail ?? json?.message ?? raw ?? "").trim();
    throw new Error(`Tavily request failed (${response.status}): ${message || "unknown error"}`);
  }

  return json && typeof json === "object" ? json : {};
}

export class TavilyWebProvider {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = normalizeApiKey(options.apiKey);
    if (!this.apiKey) {
      throw new Error("TAVILY_API_KEY is required");
    }
  }

  async search(args = {}) {
    const query = String(args.query ?? "").trim();
    if (!query) {
      throw new Error("query is required");
    }

    const searchDepth = String(args.searchDepth ?? "advanced").trim().toLowerCase();
    const maxResults = Math.min(Math.max(Number(args.maxResults ?? 5) || 5, 1), 10);
    const topic = String(args.topic ?? "general").trim().toLowerCase();

    const payload = await requestJson({
      baseUrl: this.baseUrl,
      path: "/search",
      apiKey: this.apiKey,
      payload: {
        query,
        search_depth: searchDepth === "basic" ? "basic" : "advanced",
        max_results: maxResults,
        topic: topic === "news" ? "news" : "general",
        include_raw_content: false
      }
    });

    const results = Array.isArray(payload?.results) ? payload.results.map(normalizeSearchItem) : [];

    return {
      query,
      answer: String(payload?.answer ?? "").trim(),
      results,
      responseTime: Number(payload?.response_time ?? 0)
    };
  }

  async fetch(args = {}) {
    const url = String(args.url ?? "").trim();
    if (!url) {
      throw new Error("url is required");
    }

    const payload = await requestJson({
      baseUrl: this.baseUrl,
      path: "/extract",
      apiKey: this.apiKey,
      payload: {
        urls: [url],
        include_images: false,
        extract_depth: "advanced"
      }
    });

    const item = Array.isArray(payload?.results) && payload.results.length > 0 ? payload.results[0] : {};
    const content =
      String(item?.raw_content ?? "").trim() ||
      String(item?.content ?? "").trim() ||
      "";

    return {
      url,
      title: String(item?.title ?? "").trim(),
      content: clipText(content),
      responseTime: Number(payload?.response_time ?? 0)
    };
  }
}
