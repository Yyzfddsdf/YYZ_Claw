import {
  MODEL_PROVIDERS,
  DEFAULT_MODEL_PROVIDER,
  createModelProviderCapabilities,
  normalizeModelProvider
} from "../modelProviders/modelProviderDefinitions.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function normalizeBoolean(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function inferLegacyProvider(source = {}) {
  const explicit = normalizeText(source.provider);
  if (explicit) {
    return normalizeModelProvider(explicit);
  }

  const baseURL = normalizeText(source.baseURL).toLowerCase();
  if (baseURL.includes("dashscope.aliyuncs.com")) {
    return MODEL_PROVIDERS.DASHSCOPE_COMPLETION;
  }

  return DEFAULT_MODEL_PROVIDER;
}

function createProfileId(baseId, existingIds) {
  const base = normalizeText(baseId)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "model";
  let candidate = base;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

function createProfileFingerprint(profile = {}) {
  return [
    normalizeText(profile.model),
    normalizeText(profile.baseURL),
    normalizeText(profile.apiKey)
  ].join("\n");
}

export function normalizeModelProfile(profile = {}) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  const id = normalizeText(source.id);
  const provider = inferLegacyProvider(source);
  const name = normalizeText(source.name);
  const model = normalizeText(source.model);
  const baseURL = normalizeText(source.baseURL);
  const apiKey = normalizeText(source.apiKey);

  if (!id || !name || !model || !baseURL || !apiKey) {
    return null;
  }

  return {
    id,
    provider,
    name,
    model,
    baseURL,
    apiKey,
    maxContextWindow: normalizeNumber(source.maxContextWindow),
    supportsVision: normalizeBoolean(
      source.supportsVision,
      createModelProviderCapabilities(provider).supportsVision
    )
  };
}

export function normalizeModelProfiles(config = {}) {
  const profiles = [];
  const existingIds = new Set();
  const configuredProfiles = Array.isArray(config?.modelProfiles) ? config.modelProfiles : [];

  for (const profile of configuredProfiles) {
    const normalized = normalizeModelProfile(profile);
    if (!normalized || existingIds.has(normalized.id)) {
      continue;
    }
    existingIds.add(normalized.id);
    profiles.push(normalized);
  }

  const hasProfile = (id) => profiles.some((profile) => profile.id === id);
  const hasVisionProfile = (id) =>
    profiles.some((profile) => profile.id === id && profile.supportsVision !== false);
  const firstProfileId = profiles[0]?.id ?? "";
  const firstVisionProfileId =
    profiles.find((profile) => profile.supportsVision !== false)?.id ?? "";

  return {
    profiles,
    defaultMainModelProfileId: hasProfile(config.defaultMainModelProfileId)
      ? normalizeText(config.defaultMainModelProfileId)
      : firstProfileId,
    defaultSubagentModelProfileId: hasProfile(config.defaultSubagentModelProfileId)
      ? normalizeText(config.defaultSubagentModelProfileId)
      : firstProfileId,
    defaultCompressionModelProfileId: hasProfile(config.defaultCompressionModelProfileId)
      ? normalizeText(config.defaultCompressionModelProfileId)
      : firstProfileId,
    defaultVisionModelProfileId: hasVisionProfile(config.defaultVisionModelProfileId)
      ? normalizeText(config.defaultVisionModelProfileId)
      : firstVisionProfileId
  };
}

function appendMigratedProfile({ profiles, existingIds, fingerprints, id, name, source }) {
  const model = normalizeText(source.model);
  const baseURL = normalizeText(source.baseURL);
  const apiKey = normalizeText(source.apiKey);
  if (!model || !baseURL || !apiKey) {
    return "";
  }

  const fingerprint = createProfileFingerprint({ model, baseURL, apiKey });
  if (fingerprints.has(fingerprint)) {
    return fingerprints.get(fingerprint);
  }

  const provider = inferLegacyProvider(source);
  const profile = {
    id: createProfileId(id, existingIds),
    provider,
    name,
    model,
    baseURL,
    apiKey,
    maxContextWindow: normalizeNumber(source.maxContextWindow),
    supportsVision: normalizeBoolean(
      source.supportsVision,
      createModelProviderCapabilities(provider).supportsVision
    )
  };
  profiles.push(profile);
  fingerprints.set(fingerprint, profile.id);
  return profile.id;
}

export function migrateLegacyModelConfig(config = {}) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const normalized = normalizeModelProfiles(source);
  const profiles = [...normalized.profiles];
  const existingIds = new Set(profiles.map((profile) => profile.id));
  const fingerprints = new Map(
    profiles.map((profile) => [createProfileFingerprint(profile), profile.id])
  );

  const mainId =
    normalized.defaultMainModelProfileId ||
    appendMigratedProfile({
      profiles,
      existingIds,
      fingerprints,
      id: "main",
      name: "主模型",
      source: {
        model: source.model,
        baseURL: source.baseURL,
        apiKey: source.apiKey,
        maxContextWindow: source.maxContextWindow,
        supportsVision: source.supportsVision
      }
    });

  const subagentId =
    normalized.defaultSubagentModelProfileId ||
    appendMigratedProfile({
      profiles,
      existingIds,
      fingerprints,
      id: "subagent",
      name: "子智能体模型",
      source: {
        model: source.subagentModel || source.model,
        baseURL: source.subagentBaseURL || source.baseURL,
        apiKey: source.subagentApiKey || source.apiKey,
        maxContextWindow: source.subagentMaxContextWindow || source.maxContextWindow,
        supportsVision: source.subagentSupportsVision ?? source.supportsVision
      }
    }) ||
    mainId;

  const compressionId =
    normalized.defaultCompressionModelProfileId ||
    appendMigratedProfile({
      profiles,
      existingIds,
      fingerprints,
      id: "compression",
      name: "压缩模型",
      source: {
        model: source.compressionModel || source.model,
        baseURL: source.compressionBaseURL || source.baseURL,
        apiKey: source.compressionApiKey || source.apiKey,
        maxContextWindow: source.compressionMaxContextWindow || source.maxContextWindow,
        supportsVision: false
      }
    }) ||
    mainId;
  const visionId =
    normalized.defaultVisionModelProfileId ||
    profiles.find((profile) => profile.supportsVision !== false)?.id ||
    "";

  return {
    modelProfiles: profiles,
    defaultMainModelProfileId: mainId || profiles[0]?.id || "",
    defaultSubagentModelProfileId: subagentId || mainId || profiles[0]?.id || "",
    defaultCompressionModelProfileId: compressionId || mainId || profiles[0]?.id || "",
    defaultVisionModelProfileId: visionId,
    webProvider: normalizeText(source.webProvider),
    tavilyApiKey: normalizeText(source.tavilyApiKey),
    compressionMaxOutputTokens: normalizeNumber(source.compressionMaxOutputTokens),
    sttProvider: "cloudflare",
    sttCloudflareApiToken: normalizeText(source.sttCloudflareApiToken),
    sttCloudflareAccountId: normalizeText(source.sttCloudflareAccountId),
    sttCloudflareModel:
      normalizeText(source.sttCloudflareModel) || "@cf/openai/whisper-large-v3-turbo"
  };
}

export function resolveModelProfile(config = {}, profileId = "", role = "main") {
  const normalized = normalizeModelProfiles(config);
  const requestedId = normalizeText(profileId);
  const defaultIdByRole = {
    main: normalized.defaultMainModelProfileId,
    subagent: normalized.defaultSubagentModelProfileId,
    compression: normalized.defaultCompressionModelProfileId,
    vision: normalized.defaultVisionModelProfileId
  };
  const selectedId = requestedId || defaultIdByRole[role] || normalized.defaultMainModelProfileId;

  return (
    normalized.profiles.find((profile) => profile.id === selectedId) ??
    normalized.profiles.find((profile) => profile.id === defaultIdByRole[role]) ??
    normalized.profiles[0] ??
    null
  );
}

export function applyModelProfileToRuntimeConfig(config = {}, profile = null) {
  if (!profile) {
    return { ...config };
  }

  return {
    ...config,
    modelProfileId: profile.id,
    modelProfileName: profile.name,
    provider: normalizeModelProvider(profile.provider),
    providerCapabilities: createModelProviderCapabilities(profile.provider),
    model: profile.model,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    maxContextWindow: profile.maxContextWindow,
    supportsVision:
      profile.supportsVision !== false &&
      createModelProviderCapabilities(profile.provider).supportsVision !== false
  };
}
