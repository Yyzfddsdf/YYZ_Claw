export function getMemoryStore(executionContext = {}) {
  const memoryStore = executionContext.memoryStore;

  if (!memoryStore) {
    throw new Error("long-term memory store is not available");
  }

  return memoryStore;
}

export function normalizeId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

export function normalizeName(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

export function normalizeKeywordArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);

  return Array.from(new Set(normalized));
}

export function normalizeKeywordGroupArray(value, fieldName) {
  const normalized = normalizeKeywordArray(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} requires at least one keyword`);
  }

  return normalized;
}
