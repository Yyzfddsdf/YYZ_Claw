import fs from "node:fs/promises";
import path from "node:path";

import { parseOpenAiYaml, parseSkillMarkdown } from "../skills/skillMarkdown.js";

const MANIFEST_CANDIDATES = [
  path.join(".plugin", "plugin.json"),
  "plugin.json",
  path.join(".claude-plugin", "plugin.json"),
  path.join(".codex-plugin", "plugin.json")
];

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function isPathInside(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function safeRelativePath(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).replace(/\\/g, "/");
}

function resolvePluginPath(pluginRootDir, requestedPath, fallbackPath = "") {
  const normalizedPath = normalizeText(requestedPath || fallbackPath);
  if (!normalizedPath) {
    return "";
  }

  const resolvedPath = path.resolve(pluginRootDir, normalizedPath);
  if (!isPathInside(pluginRootDir, resolvedPath)) {
    throw new Error(`path escapes plugin root: ${normalizedPath}`);
  }
  return resolvedPath;
}

async function findManifest(pluginRootDir) {
  for (const candidate of MANIFEST_CANDIDATES) {
    const manifestPath = path.join(pluginRootDir, candidate);
    if (await fileExists(manifestPath)) {
      return {
        manifestPath,
        manifestKind: candidate.replace(/\\/g, "/")
      };
    }
  }
  return null;
}

async function collectSkillRoots(rootDir) {
  const roots = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkillFile) {
      roots.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      await walk(path.join(currentDir, entry.name));
    }
  }

  if (rootDir && await fileExists(rootDir)) {
    await walk(rootDir);
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function readFileStats(filePath) {
  const stats = await fs.stat(filePath);
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs)
  };
}

function resolveImageMimeType(filePath, assetLabel = "plugin assets") {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType =
    extension === ".svg"
      ? "image/svg+xml; charset=utf-8"
      : extension === ".png"
        ? "image/png"
        : "";
  if (!mimeType) {
    throw new Error(`only svg and png ${assetLabel} are allowed`);
  }
  return mimeType;
}

async function readRules(pluginRootDir, rulesValue) {
  const rules = [];

  if (typeof rulesValue === "string" && rulesValue.trim()) {
    const rulesPath = resolvePluginPath(pluginRootDir, rulesValue);
    if (await fileExists(rulesPath)) {
      rules.push({
        path: safeRelativePath(pluginRootDir, rulesPath),
        content: await fs.readFile(rulesPath, "utf8")
      });
    }
    return rules;
  }

  for (const item of Array.isArray(rulesValue) ? rulesValue : []) {
    if (typeof item === "string") {
      const textOrPath = item.trim();
      if (!textOrPath) {
        continue;
      }
      if (textOrPath.startsWith("./") || textOrPath.includes("/") || textOrPath.includes("\\")) {
        const rulesPath = resolvePluginPath(pluginRootDir, textOrPath);
        if (await fileExists(rulesPath)) {
          rules.push({
            path: safeRelativePath(pluginRootDir, rulesPath),
            content: await fs.readFile(rulesPath, "utf8")
          });
        }
      } else {
        rules.push({
          path: "",
          content: textOrPath
        });
      }
      continue;
    }

    if (isPlainObject(item)) {
      const pathValue = normalizeText(item.path);
      const contentValue = normalizeText(item.content ?? item.text ?? item.rule);
      if (pathValue) {
        const rulesPath = resolvePluginPath(pluginRootDir, pathValue);
        if (await fileExists(rulesPath)) {
          rules.push({
            path: safeRelativePath(pluginRootDir, rulesPath),
            content: await fs.readFile(rulesPath, "utf8")
          });
        }
      } else if (contentValue) {
        rules.push({
          path: "",
          content: contentValue
        });
      }
    }
  }

  const defaultRulesPath = path.join(pluginRootDir, "rules.md");
  if (rules.length === 0 && await fileExists(defaultRulesPath)) {
    rules.push({
      path: "rules.md",
      content: await fs.readFile(defaultRulesPath, "utf8")
    });
  }

  return rules;
}

function normalizeInterface(rawInterface = {}) {
  const ui = isPlainObject(rawInterface) ? rawInterface : {};
  return {
    displayName: normalizeText(ui.displayName),
    shortDescription: normalizeText(ui.shortDescription),
    longDescription: normalizeText(ui.longDescription),
    developerName: normalizeText(ui.developerName),
    category: normalizeText(ui.category),
    capabilities: toStringArray(ui.capabilities),
    brandColor: normalizeText(ui.brandColor),
    composerIcon: normalizeText(ui.composerIcon),
    logo: normalizeText(ui.logo),
    screenshots: toStringArray(ui.screenshots),
    defaultPrompt: toStringArray(ui.defaultPrompt).slice(0, 3)
  };
}

function normalizeAuthor(rawAuthor = {}) {
  if (typeof rawAuthor === "string") {
    return {
      name: normalizeText(rawAuthor),
      email: "",
      url: ""
    };
  }

  const author = isPlainObject(rawAuthor) ? rawAuthor : {};
  return {
    name: normalizeText(author.name),
    email: normalizeText(author.email),
    url: normalizeText(author.url)
  };
}

function normalizeManifest(rawManifest, fallbackName) {
  const manifest = isPlainObject(rawManifest) ? rawManifest : {};
  const name = normalizeText(manifest.name) || fallbackName;
  if (!name) {
    throw new Error("plugin name is required");
  }
  const description = normalizeText(manifest.description);
  if (!description) {
    throw new Error("plugin description is required");
  }

  return {
    name,
    normalizedName: normalizeName(name),
    version: normalizeText(manifest.version) || "1.0.0",
    description,
    keywords: toStringArray(manifest.keywords),
    author: normalizeAuthor(manifest.author),
    skills: normalizeText(manifest.skills || "./skills"),
    mcpServers: normalizeText(manifest.mcpServers || manifest.mcp || "./.mcp.json"),
    hooks: normalizeText(manifest.hooks || path.join("./hooks", "hooks.json")),
    rules: manifest.rules,
    interface: normalizeInterface(manifest.interface)
  };
}

function normalizeSkillRecord(plugin, skillRootDir, parsed, stats) {
  const relativePath = safeRelativePath(plugin.skillsRootDir, skillRootDir);
  const pathSegments = relativePath.split("/").filter(Boolean);
  const rawFrontmatter = isPlainObject(parsed.frontmatter) ? parsed.frontmatter : {};
  const metadata = isPlainObject(rawFrontmatter.metadata) ? rawFrontmatter.metadata : {};
  const hermes = isPlainObject(metadata.hermes) ? metadata.hermes : {};
  const name = normalizeText(rawFrontmatter.name) || pathSegments.at(-1) || path.basename(skillRootDir);
  const ui = isPlainObject(parsed.ui) ? parsed.ui : {};
  const skillKey = `plugin:${plugin.name}/${relativePath}`;

  return {
    scope: "plugin",
    pluginName: plugin.name,
    pluginDisplayName: plugin.displayName,
    skillKey,
    normalizedSkillKey: normalizeName(skillKey),
    name,
    normalizedName: normalizeName(name),
    normalizedRelativePath: normalizeName(relativePath),
    displayName: normalizeText(ui.displayName) || name,
    shortDescription:
      normalizeText(ui.shortDescription) || normalizeText(rawFrontmatter.description),
    defaultPrompt: normalizeText(ui.defaultPrompt),
    iconSmall: normalizeText(ui.iconSmall),
    iconLarge: normalizeText(ui.iconLarge),
    brandColor: normalizeText(ui.brandColor) || plugin.interface.brandColor,
    allowImplicitInvocation: ui.allowImplicitInvocation !== false,
    description: normalizeText(rawFrontmatter.description),
    version: normalizeText(rawFrontmatter.version) || plugin.version,
    author: normalizeText(rawFrontmatter.author) || plugin.interface.developerName,
    license: normalizeText(rawFrontmatter.license),
    metadata: rawFrontmatter.metadata ?? {},
    hermes: {
      enabled: hermes.enabled !== false,
      hidden: Boolean(hermes.hidden)
    },
    rootDir: skillRootDir,
    catalogRootDir: plugin.skillsRootDir,
    skillFilePath: path.join(skillRootDir, "SKILL.md"),
    relativePath,
    category: plugin.displayName,
    isSystem: false,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    bodyLength: normalizeText(parsed.body).length
  };
}

export class PluginCatalog {
  constructor(options = {}) {
    this.rootDir = path.resolve(String(options.rootDir ?? ""));
    this.settingsStore = options.settingsStore ?? null;
    this.cache = null;
  }

  async ensureDirectory() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async readSettings() {
    if (!this.settingsStore || typeof this.settingsStore.read !== "function") {
      return {
        plugins: {}
      };
    }
    return this.settingsStore.read();
  }

  async discoverPlugin(pluginRootDir, settings) {
    const fallbackName = path.basename(pluginRootDir);
    const foundManifest = await findManifest(pluginRootDir);
    if (!foundManifest) {
      throw new Error("manifest not found");
    }

    const rawManifest = JSON.parse(await fs.readFile(foundManifest.manifestPath, "utf8"));
    const manifest = normalizeManifest(rawManifest, fallbackName);
    const pluginSettings = settings.plugins[manifest.name] ?? settings.plugins[manifest.normalizedName] ?? {};
    const enabled = pluginSettings.enabled !== false;
    const skillsRootDir = resolvePluginPath(pluginRootDir, manifest.skills, "./skills");
    const mcpPath = resolvePluginPath(pluginRootDir, manifest.mcpServers, "./.mcp.json");
    const hooksPath = resolvePluginPath(pluginRootDir, manifest.hooks, path.join("./hooks", "hooks.json"));
    const rules = await readRules(pluginRootDir, manifest.rules);
    const plugin = {
      ...manifest,
      displayName: manifest.interface.displayName || manifest.name,
      rootDir: pluginRootDir,
      manifestPath: foundManifest.manifestPath,
      manifestKind: foundManifest.manifestKind,
      relativeManifestPath: safeRelativePath(pluginRootDir, foundManifest.manifestPath),
      enabled,
      settings: {
        enabled
      },
      skillsRootDir,
      mcpPath,
      hooksPath,
      hasSkills: await fileExists(skillsRootDir),
      hasMcp: await fileExists(mcpPath),
      hasHooks: await fileExists(hooksPath),
      rules,
      errors: []
    };

    return plugin;
  }

  async read(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    if (this.cache && !forceRefresh) {
      return this.cache;
    }

    await this.ensureDirectory();
    const settings = await this.readSettings();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const plugins = [];
    const errors = [];

    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const pluginRootDir = path.join(this.rootDir, entry.name);
      try {
        plugins.push(await this.discoverPlugin(pluginRootDir, settings));
      } catch (error) {
        errors.push({
          name: entry.name,
          rootDir: pluginRootDir,
          message: normalizeText(error?.message) || "plugin failed to load"
        });
      }
    }

    const catalog = {
      generatedAt: Date.now(),
      rootDir: this.rootDir,
      plugins,
      errors
    };
    this.cache = catalog;
    return catalog;
  }

  async refresh() {
    this.cache = null;
    return this.read({ forceRefresh: true });
  }

  async listPlugins() {
    const catalog = await this.read();
    return catalog.plugins.map((plugin) => ({
      name: plugin.name,
      displayName: plugin.displayName,
      version: plugin.version,
      description: plugin.description,
      author: plugin.author,
      enabled: plugin.enabled,
      manifestKind: plugin.manifestKind,
      interface: plugin.interface,
      components: {
        skills: plugin.hasSkills,
        mcp: plugin.hasMcp,
        hooks: plugin.hasHooks,
        rules: plugin.rules.length > 0
      },
      skillCount: 0,
      ruleCount: plugin.rules.length,
      errors: plugin.errors
    }));
  }

  async listEnabledPlugins() {
    const catalog = await this.read();
    return catalog.plugins.filter((plugin) => plugin.enabled);
  }

  async findPlugin(identifier) {
    const normalizedIdentifier = normalizeName(identifier);
    if (!normalizedIdentifier) {
      return null;
    }

    const catalog = await this.read();
    return catalog.plugins.find((plugin) =>
      plugin.normalizedName === normalizedIdentifier ||
      normalizeName(plugin.name) === normalizedIdentifier ||
      normalizeName(plugin.displayName) === normalizedIdentifier
    ) ?? null;
  }

  async collectPluginSkills(options = {}) {
    const enabledOnly = options.enabledOnly !== false;
    const catalog = await this.read();
    const selectedPluginNames = Array.isArray(options.selectedPluginNames)
      ? new Set(options.selectedPluginNames.map((item) => normalizeName(item)).filter(Boolean))
      : null;
    const plugins = (enabledOnly ? catalog.plugins : catalog.plugins)
      .filter((plugin) => !selectedPluginNames || selectedPluginNames.has(plugin.normalizedName));
    const skills = [];

    for (const plugin of plugins) {
      if (!plugin.hasSkills) {
        continue;
      }

      const skillRoots = await collectSkillRoots(plugin.skillsRootDir);
      for (const skillRootDir of skillRoots) {
        const skillFilePath = path.join(skillRootDir, "SKILL.md");
        const stats = await readFileStats(skillFilePath);
        const parsed = parseSkillMarkdown(await fs.readFile(skillFilePath, "utf8"));
        const agentPath = path.join(skillRootDir, "agents", "openai.yaml");
        const ui = (await fileExists(agentPath))
          ? parseOpenAiYaml(await fs.readFile(agentPath, "utf8"))
          : null;
        skills.push(normalizeSkillRecord(plugin, skillRootDir, { ...parsed, ui }, stats));
      }
    }

    return skills;
  }

  async findPluginSkill(identifier, options = {}) {
    const normalizedIdentifier = normalizeName(identifier);
    if (!normalizedIdentifier) {
      return null;
    }

    const skills = await this.collectPluginSkills(options);
    return (
      skills.find(
        (skill) =>
          skill.normalizedSkillKey === normalizedIdentifier ||
          skill.normalizedName === normalizedIdentifier ||
          skill.normalizedRelativePath === normalizedIdentifier ||
          normalizeName(`${skill.pluginName}/${skill.relativePath}`) === normalizedIdentifier
      ) ?? null
    );
  }

  async getPluginSkillContent(identifier, filePath = "SKILL.md", options = {}) {
    const skill = await this.findPluginSkill(identifier, options);
    if (!skill) {
      return null;
    }

    const normalizedFilePath = normalizeText(filePath) || "SKILL.md";
    const resolvedPath = path.resolve(skill.rootDir, normalizedFilePath);
    if (!isPathInside(skill.rootDir, resolvedPath)) {
      throw new Error("filePath escapes plugin skill root");
    }

    return {
      skill,
      filePath: safeRelativePath(skill.rootDir, resolvedPath),
      content: await fs.readFile(resolvedPath, "utf8")
    };
  }

  async getPluginSkillAsset(identifier, filePath = "", options = {}) {
    const skill = await this.findPluginSkill(identifier, options);
    if (!skill) {
      return null;
    }

    const normalizedFilePath = normalizeText(filePath);
    if (!normalizedFilePath) {
      throw new Error("filePath is required");
    }

    const mimeType = resolveImageMimeType(normalizedFilePath, "plugin skill assets");

    const resolvedPath = path.resolve(skill.rootDir, normalizedFilePath);
    if (!isPathInside(skill.rootDir, resolvedPath)) {
      throw new Error("filePath escapes plugin skill root");
    }

    return {
      skill,
      filePath: safeRelativePath(skill.rootDir, resolvedPath),
      content: await fs.readFile(resolvedPath),
      mimeType
    };
  }

  async getPluginAsset(identifier, filePath = "") {
    const plugin = await this.findPlugin(identifier);
    if (!plugin) {
      return null;
    }

    const normalizedFilePath = normalizeText(filePath);
    if (!normalizedFilePath) {
      throw new Error("filePath is required");
    }

    const mimeType = resolveImageMimeType(normalizedFilePath, "plugin assets");
    const resolvedPath = path.resolve(plugin.rootDir, normalizedFilePath);
    if (!isPathInside(plugin.rootDir, resolvedPath)) {
      throw new Error("filePath escapes plugin root");
    }

    return {
      plugin,
      filePath: safeRelativePath(plugin.rootDir, resolvedPath),
      content: await fs.readFile(resolvedPath),
      mimeType
    };
  }
}
