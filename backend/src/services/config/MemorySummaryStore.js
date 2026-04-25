import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../utils/safeJsonParse.js";

const WORKSPACES_DIR_NAME = "workspaces";
const GLOBAL_MEMORY_FILE_NAME = "global.md";
const MAX_MEMORY_DOCUMENT_CHARS = 20000;

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMarkdown(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length <= MAX_MEMORY_DOCUMENT_CHARS) {
    return normalized;
  }

  return normalized.slice(0, MAX_MEMORY_DOCUMENT_CHARS).trimEnd();
}

function hasMarkdownContent(value) {
  return normalizeMarkdown(value).length > 0;
}

function normalizeWorkspacePathKey(workspacePath) {
  const normalized = normalizeText(workspacePath);
  return normalized ? path.resolve(normalized) : "";
}

function createWorkspaceFileName(workspacePath) {
  const workspaceKey = normalizeWorkspacePathKey(workspacePath);
  const baseName = path.basename(workspaceKey) || "workspace";
  const safeBaseName = baseName
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "workspace";
  const hash = createHash("sha256").update(workspaceKey).digest("hex").slice(0, 12);
  return `${safeBaseName}-${hash}.md`;
}

function appendMarkdownList(sections, title, items = []) {
  const values = Array.isArray(items)
    ? items.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  if (values.length === 0) {
    return;
  }

  if (title) {
    sections.push([title, ...values.map((item) => `- ${item}`)].join("\n"));
    return;
  }

  sections.push(values.map((item) => `- ${item}`).join("\n"));
}

function convertLegacyGlobalSummaryToMarkdown(globalSummary = {}) {
  const sections = ["# Global Memory"];

  appendMarkdownList(sections, "## User Profile", globalSummary.userProfile);
  appendMarkdownList(sections, "## User Preferences", globalSummary.userPreferences);
  appendMarkdownList(sections, "## General Tips", globalSummary.generalTips);

  return sections.length > 1 ? `${sections.join("\n\n")}\n` : "";
}

function convertLegacyWorkspaceSummaryToMarkdown(workspacePath, summary = {}) {
  const sections = ["# Workspace Memory", `Workspace: ${workspacePath}`];
  const purpose = normalizeText(summary.purpose ?? summary.scope);

  if (purpose) {
    sections.push("## Purpose");
    sections.push(purpose);
  }

  appendMarkdownList(sections, "## Key Surfaces", summary.surfaces ?? summary.appliesTo);
  appendMarkdownList(sections, "## Invariants", summary.invariants ?? summary.stableRules);
  appendMarkdownList(
    sections,
    "## Entrypoints",
    summary.entrypoints ?? summary.reusableKnowledge
  );
  appendMarkdownList(sections, "## Gotchas", summary.gotchas ?? summary.pitfalls);

  return sections.length > 2 ? `${sections.join("\n\n")}\n` : "";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function getFileUpdatedAt(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime.toISOString();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class MemorySummaryStore {
  constructor(options = {}) {
    const source = typeof options === "string" ? { rootDir: options } : options;
    this.rootDir = path.resolve(String(source.rootDir ?? ""));
    this.legacyJsonFilePath = source.legacyJsonFilePath
      ? path.resolve(String(source.legacyJsonFilePath))
      : "";
    this.globalFilePath = path.join(this.rootDir, GLOBAL_MEMORY_FILE_NAME);
    this.workspacesDir = path.join(this.rootDir, WORKSPACES_DIR_NAME);
  }

  async ensureFile() {
    await fs.mkdir(this.workspacesDir, { recursive: true });

    if (!(await fileExists(this.globalFilePath))) {
      await writeFileAtomic(this.globalFilePath, "");
    }

    await this.migrateLegacyJsonIfNeeded();
  }

  async migrateLegacyJsonIfNeeded() {
    if (!this.legacyJsonFilePath || !(await fileExists(this.legacyJsonFilePath))) {
      return;
    }

    const currentGlobal = normalizeMarkdown(await readTextFile(this.globalFilePath));
    const rawLegacy = await readTextFile(this.legacyJsonFilePath);
    const legacy = safeJsonParse(rawLegacy, null);
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return;
    }

    if (!currentGlobal) {
      const globalMarkdown = convertLegacyGlobalSummaryToMarkdown(legacy.global);
      if (globalMarkdown) {
        await writeFileAtomic(this.globalFilePath, globalMarkdown);
      }
    }

    const workspaces =
      legacy.workspaces && typeof legacy.workspaces === "object" && !Array.isArray(legacy.workspaces)
        ? legacy.workspaces
        : {};
    for (const [workspacePath, entry] of Object.entries(workspaces)) {
      const workspaceKey = this.resolveWorkspacePathKey(workspacePath);
      if (!workspaceKey) {
        continue;
      }

      const workspaceFilePath = this.resolveWorkspaceFilePath(workspaceKey);
      if (normalizeMarkdown(await readTextFile(workspaceFilePath))) {
        continue;
      }

      const workspaceMarkdown = convertLegacyWorkspaceSummaryToMarkdown(
        workspaceKey,
        entry?.summary ?? {}
      );
      if (workspaceMarkdown) {
        await writeFileAtomic(workspaceFilePath, workspaceMarkdown);
      }
    }
  }

  resolveWorkspacePathKey(workspacePath) {
    return normalizeWorkspacePathKey(workspacePath);
  }

  resolveWorkspaceFilePath(workspacePath) {
    const workspaceKey = this.resolveWorkspacePathKey(workspacePath);
    return path.join(this.workspacesDir, createWorkspaceFileName(workspaceKey));
  }

  async getPromptData(workspacePath = "") {
    await this.ensureFile();

    const workspaceKey = this.resolveWorkspacePathKey(workspacePath);
    const workspaceFilePath = workspaceKey ? this.resolveWorkspaceFilePath(workspaceKey) : "";
    const globalMarkdown = normalizeMarkdown(await readTextFile(this.globalFilePath));
    const workspaceMarkdown = workspaceFilePath
      ? normalizeMarkdown(await readTextFile(workspaceFilePath))
      : "";

    return {
      rootDir: this.rootDir,
      globalFilePath: this.globalFilePath,
      workspaceFilePath,
      workspacePath: workspaceKey,
      globalMarkdown,
      workspaceMarkdown,
      globalUpdatedAt: await getFileUpdatedAt(this.globalFilePath),
      workspaceUpdatedAt: workspaceFilePath ? await getFileUpdatedAt(workspaceFilePath) : ""
    };
  }

  hasPromptContent(promptData = {}) {
    return (
      hasMarkdownContent(promptData.globalMarkdown) ||
      hasMarkdownContent(promptData.workspaceMarkdown)
    );
  }

  async saveGlobalMarkdown(markdown) {
    await this.ensureFile();
    const normalized = normalizeMarkdown(markdown);
    await writeFileAtomic(this.globalFilePath, normalized ? `${normalized}\n` : "");
    return normalized;
  }

  async saveWorkspaceMarkdown(workspacePath, markdown) {
    await this.ensureFile();
    const workspaceKey = this.resolveWorkspacePathKey(workspacePath);
    if (!workspaceKey) {
      return "";
    }

    const filePath = this.resolveWorkspaceFilePath(workspaceKey);
    const normalized = normalizeMarkdown(markdown);
    await writeFileAtomic(filePath, normalized ? `${normalized}\n` : "");
    return normalized;
  }
}
