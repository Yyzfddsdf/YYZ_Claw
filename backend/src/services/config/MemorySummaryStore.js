import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../utils/safeJsonParse.js";

const SCHEMA_VERSION = 1;
const MAX_WORKSPACE_ENTRIES = 24;
const GLOBAL_LIST_MAX_ITEMS = 8;
const GLOBAL_ITEM_MAX_CHARS = 180;
const WORKSPACE_SCOPE_MAX_CHARS = 220;
const WORKSPACE_APPLIES_TO_MAX_ITEMS = 5;
const WORKSPACE_APPLIES_TO_MAX_CHARS = 120;
const WORKSPACE_CURRENT_FOCUS_MAX_ITEMS = 4;
const WORKSPACE_CURRENT_FOCUS_MAX_CHARS = 180;
const WORKSPACE_STABLE_RULES_MAX_ITEMS = 5;
const WORKSPACE_STABLE_RULES_MAX_CHARS = 180;
const WORKSPACE_REUSABLE_KNOWLEDGE_MAX_ITEMS = 5;
const WORKSPACE_REUSABLE_KNOWLEDGE_MAX_CHARS = 180;
const WORKSPACE_PITFALLS_MAX_ITEMS = 4;
const WORKSPACE_PITFALLS_MAX_CHARS = 180;

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxChars) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeCompareKey(value) {
  return normalizeText(value).normalize("NFKC").toLowerCase();
}

function normalizeStringList(value, { maxItems, maxChars }) {
  const source = Array.isArray(value) ? value : [];
  const nextValues = [];
  const seen = new Set();

  for (const item of source) {
    const clipped = clipText(item, maxChars);
    if (!clipped) {
      continue;
    }

    const compareKey = normalizeCompareKey(clipped);
    if (!compareKey || seen.has(compareKey)) {
      continue;
    }

    seen.add(compareKey);
    nextValues.push(clipped);

    if (nextValues.length >= maxItems) {
      break;
    }
  }

  return nextValues;
}

function normalizeWorkspacePathKey(workspacePath) {
  const normalized = normalizeText(workspacePath);
  return normalized ? path.resolve(normalized) : "";
}

function createEmptyGlobalSummary() {
  return {
    userProfile: [],
    userPreferences: [],
    generalTips: []
  };
}

function createEmptyWorkspaceSummary() {
  return {
    scope: "",
    appliesTo: [],
    currentFocus: [],
    stableRules: [],
    reusableKnowledge: [],
    pitfalls: []
  };
}

export function createEmptyMemorySummary() {
  return {
    schemaVersion: SCHEMA_VERSION,
    global: createEmptyGlobalSummary(),
    workspaces: {}
  };
}

export function normalizeGlobalSummary(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  return {
    userProfile: normalizeStringList(source.userProfile, {
      maxItems: GLOBAL_LIST_MAX_ITEMS,
      maxChars: GLOBAL_ITEM_MAX_CHARS
    }),
    userPreferences: normalizeStringList(source.userPreferences, {
      maxItems: GLOBAL_LIST_MAX_ITEMS,
      maxChars: GLOBAL_ITEM_MAX_CHARS
    }),
    generalTips: normalizeStringList(source.generalTips, {
      maxItems: GLOBAL_LIST_MAX_ITEMS,
      maxChars: GLOBAL_ITEM_MAX_CHARS
    })
  };
}

export function normalizeWorkspaceSummary(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  return {
    scope: clipText(source.scope, WORKSPACE_SCOPE_MAX_CHARS),
    appliesTo: normalizeStringList(source.appliesTo, {
      maxItems: WORKSPACE_APPLIES_TO_MAX_ITEMS,
      maxChars: WORKSPACE_APPLIES_TO_MAX_CHARS
    }),
    currentFocus: normalizeStringList(source.currentFocus, {
      maxItems: WORKSPACE_CURRENT_FOCUS_MAX_ITEMS,
      maxChars: WORKSPACE_CURRENT_FOCUS_MAX_CHARS
    }),
    stableRules: normalizeStringList(source.stableRules, {
      maxItems: WORKSPACE_STABLE_RULES_MAX_ITEMS,
      maxChars: WORKSPACE_STABLE_RULES_MAX_CHARS
    }),
    reusableKnowledge: normalizeStringList(source.reusableKnowledge, {
      maxItems: WORKSPACE_REUSABLE_KNOWLEDGE_MAX_ITEMS,
      maxChars: WORKSPACE_REUSABLE_KNOWLEDGE_MAX_CHARS
    }),
    pitfalls: normalizeStringList(source.pitfalls, {
      maxItems: WORKSPACE_PITFALLS_MAX_ITEMS,
      maxChars: WORKSPACE_PITFALLS_MAX_CHARS
    })
  };
}

function isWorkspaceSummaryEmpty(summary) {
  const normalized = normalizeWorkspaceSummary(summary);
  return (
    !normalized.scope &&
    normalized.appliesTo.length === 0 &&
    normalized.currentFocus.length === 0 &&
    normalized.stableRules.length === 0 &&
    normalized.reusableKnowledge.length === 0 &&
    normalized.pitfalls.length === 0
  );
}

export function normalizeMemorySummaryPayload(input) {
  const fallback = createEmptyMemorySummary();
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : fallback;
  const normalizedGlobal = normalizeGlobalSummary(source.global);
  const normalizedWorkspaceEntries = [];
  const rawWorkspaces =
    source.workspaces && typeof source.workspaces === "object" && !Array.isArray(source.workspaces)
      ? source.workspaces
      : {};

  for (const [rawWorkspacePath, rawEntry] of Object.entries(rawWorkspaces)) {
    const workspacePath = normalizeWorkspacePathKey(rawWorkspacePath);
    if (!workspacePath) {
      continue;
    }

    const sourceEntry =
      rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? rawEntry : {};
    const summary = normalizeWorkspaceSummary(sourceEntry.summary);
    const updatedAt = normalizeText(sourceEntry.updatedAt);

    if (isWorkspaceSummaryEmpty(summary) && !updatedAt) {
      continue;
    }

    normalizedWorkspaceEntries.push({
      workspacePath,
      summary,
      updatedAt
    });
  }

  normalizedWorkspaceEntries.sort((left, right) => {
    const leftTime = Number.isFinite(Date.parse(left.updatedAt)) ? Date.parse(left.updatedAt) : 0;
    const rightTime = Number.isFinite(Date.parse(right.updatedAt)) ? Date.parse(right.updatedAt) : 0;

    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return left.workspacePath.localeCompare(right.workspacePath);
  });

  const nextWorkspaces = {};
  for (const entry of normalizedWorkspaceEntries.slice(0, MAX_WORKSPACE_ENTRIES)) {
    nextWorkspaces[entry.workspacePath] = {
      summary: entry.summary,
      updatedAt: entry.updatedAt
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    global: normalizedGlobal,
    workspaces: nextWorkspaces
  };
}

function hasAnyGlobalSummary(globalSummary) {
  const normalized = normalizeGlobalSummary(globalSummary);
  return (
    normalized.userProfile.length > 0 ||
    normalized.userPreferences.length > 0 ||
    normalized.generalTips.length > 0
  );
}

function hasAnyWorkspaceSummary(summary) {
  return !isWorkspaceSummaryEmpty(summary);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class MemorySummaryStore {
  constructor(filePath) {
    this.filePath = path.resolve(String(filePath ?? ""));
  }

  async ensureFile() {
    const dirPath = path.dirname(this.filePath);
    await fs.mkdir(dirPath, { recursive: true });

    if (!(await fileExists(this.filePath))) {
      const payload = JSON.stringify(createEmptyMemorySummary(), null, 2) + "\n";
      await fs.writeFile(this.filePath, payload, "utf8");
    }
  }

  async read() {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    return normalizeMemorySummaryPayload(safeJsonParse(raw, createEmptyMemorySummary()));
  }

  async save(nextValue) {
    await this.ensureFile();
    const normalized = normalizeMemorySummaryPayload(nextValue);
    await fs.writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  resolveWorkspacePathKey(workspacePath) {
    return normalizeWorkspacePathKey(workspacePath);
  }

  async getPromptData(workspacePath = "") {
    const payload = await this.read();
    const workspaceKey = this.resolveWorkspacePathKey(workspacePath);
    const workspaceEntry = workspaceKey ? payload.workspaces[workspaceKey] ?? null : null;

    return {
      filePath: this.filePath,
      workspacePath: workspaceKey,
      global: payload.global,
      workspaceSummary: workspaceEntry?.summary ?? createEmptyWorkspaceSummary(),
      updatedAt: normalizeText(workspaceEntry?.updatedAt)
    };
  }

  hasPromptContent(promptData = {}) {
    return (
      hasAnyGlobalSummary(promptData.global) ||
      hasAnyWorkspaceSummary(promptData.workspaceSummary)
    );
  }
}

export { hasAnyWorkspaceSummary };
