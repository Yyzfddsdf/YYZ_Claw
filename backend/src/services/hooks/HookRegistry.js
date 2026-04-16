import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizePriority(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 100;
}

function normalizeHookDefinition(hookModule) {
  const candidate = hookModule?.default ?? hookModule?.hook ?? hookModule;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Hook module must export an object.");
  }

  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error("Hook name must be a non-empty string.");
  }

  if (
    typeof candidate.description !== "string" ||
    candidate.description.trim().length === 0
  ) {
    throw new Error(`Hook ${candidate.name} is missing description.`);
  }

  if (typeof candidate.evaluate !== "function") {
    throw new Error(`Hook ${candidate.name} must provide an evaluate function.`);
  }

  return {
    name: candidate.name,
    description: candidate.description,
    priority: normalizePriority(candidate.priority),
    evaluate: candidate.evaluate
  };
}

export class HookRegistry {
  constructor() {
    this.hookMap = new Map();
  }

  async autoRegisterFromDir(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const hookFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".hook.js"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of hookFiles) {
      const fullPath = path.join(dirPath, fileName);
      const importedModule = await import(pathToFileURL(fullPath).href);
      const hook = normalizeHookDefinition(importedModule);
      this.register(hook);
    }

    return this.listHooks();
  }

  register(hook) {
    const normalized = normalizeHookDefinition(hook);
    this.hookMap.set(normalized.name, normalized);
  }

  getHook(hookName) {
    return this.hookMap.get(String(hookName ?? "").trim()) ?? null;
  }

  listHooks() {
    return Array.from(this.hookMap.values()).sort((left, right) => right.priority - left.priority);
  }
}
