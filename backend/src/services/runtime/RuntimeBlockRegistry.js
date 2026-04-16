import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizePriority(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 100;
}

function normalizeRuntimeBlockProvider(runtimeBlockModule) {
  const candidate = runtimeBlockModule?.default ?? runtimeBlockModule?.provider ?? runtimeBlockModule;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Runtime block module must export an object.");
  }

  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error("Runtime block provider name must be a non-empty string.");
  }

  if (
    typeof candidate.description !== "string" ||
    candidate.description.trim().length === 0
  ) {
    throw new Error(`Runtime block provider ${candidate.name} is missing description.`);
  }

  if (typeof candidate.resolve !== "function") {
    throw new Error(`Runtime block provider ${candidate.name} must provide a resolve function.`);
  }

  return {
    name: candidate.name,
    description: candidate.description,
    priority: normalizePriority(candidate.priority),
    resolve: candidate.resolve
  };
}

export class RuntimeBlockRegistry {
  constructor() {
    this.providerMap = new Map();
  }

  async autoRegisterFromDir(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const providerFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".runtime-block.js"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of providerFiles) {
      const fullPath = path.join(dirPath, fileName);
      const importedModule = await import(pathToFileURL(fullPath).href);
      const provider = normalizeRuntimeBlockProvider(importedModule);
      this.register(provider);
    }

    return this.listProviders();
  }

  register(provider) {
    const normalized = normalizeRuntimeBlockProvider(provider);
    this.providerMap.set(normalized.name, normalized);
  }

  getProvider(providerName) {
    return this.providerMap.get(String(providerName ?? "").trim()) ?? null;
  }

  listProviders() {
    return Array.from(this.providerMap.values()).sort((left, right) => right.priority - left.priority);
  }
}
