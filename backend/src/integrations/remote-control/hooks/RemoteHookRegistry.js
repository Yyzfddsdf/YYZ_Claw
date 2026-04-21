import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizePriority(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 100;
}

function normalizeHookDefinition(hookModule) {
  const candidate = hookModule?.default ?? hookModule?.hook ?? hookModule;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Remote hook module must export an object.");
  }

  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error("Remote hook name must be a non-empty string.");
  }

  if (typeof candidate.description !== "string" || candidate.description.trim().length === 0) {
    throw new Error(`Remote hook ${candidate.name} is missing description.`);
  }

  if (typeof candidate.evaluate !== "function") {
    throw new Error(`Remote hook ${candidate.name} must provide an evaluate function.`);
  }

  return {
    name: candidate.name,
    description: candidate.description,
    priority: normalizePriority(candidate.priority),
    evaluate: candidate.evaluate
  };
}

export class RemoteHookRegistry {
  constructor() {
    this.hookMap = new Map();
  }

  async autoRegisterFromDir(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const hookFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".hook.js"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const fileName of hookFiles) {
      const fullPath = path.join(dirPath, fileName);
      const importedModule = await import(pathToFileURL(fullPath).href);
      this.register(importedModule);
    }

    return this.listHooks();
  }

  register(hookModule) {
    const normalized = normalizeHookDefinition(hookModule);
    this.hookMap.set(normalized.name, normalized);
  }

  getHook(hookName) {
    return this.hookMap.get(String(hookName ?? "").trim()) ?? null;
  }

  listHooks() {
    return Array.from(this.hookMap.values()).sort((left, right) => right.priority - left.priority);
  }
}

