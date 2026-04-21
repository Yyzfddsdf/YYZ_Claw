function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeProviderLabel(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export class RemoteControlProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider = {}) {
    const key = normalizeProviderKey(provider.key);
    if (!key) {
      throw new Error("provider key is required");
    }

    const normalized = {
      key,
      label: normalizeProviderLabel(provider.label, key),
      adapter: provider.adapter ?? null
    };
    this.providers.set(key, normalized);
    return normalized;
  }

  has(key) {
    return this.providers.has(normalizeProviderKey(key));
  }

  get(key) {
    return this.providers.get(normalizeProviderKey(key)) ?? null;
  }

  list() {
    return Array.from(this.providers.values()).map((provider) => ({
      key: provider.key,
      label: provider.label
    }));
  }
}
