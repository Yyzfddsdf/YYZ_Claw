import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceDescriptor(value) {
  if (isPlainObject(value)) {
    return {
      type: normalizeText(value.source || value.type),
      url: normalizeText(value.url),
      repository: normalizeText(value.repository || value.repo),
      path: normalizeText(value.path),
      ref: normalizeText(value.ref),
      sha: normalizeText(value.sha)
    };
  }
  return normalizeText(value);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(normalizeText(value));
}

function isGitUrl(value) {
  return /^(?:git@|ssh:\/\/|git:\/\/)/i.test(normalizeText(value))
    || /\.git(?:[#?].*)?$/i.test(normalizeText(value));
}

function isGithubShorthand(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalizeText(value));
}

function isRemoteSource(value) {
  const source = normalizeText(value);
  return isHttpUrl(source) || isGitUrl(source) || isGithubShorthand(source);
}

function toGithubRawUrl(shorthand, relativePath) {
  return `https://raw.githubusercontent.com/${normalizeText(shorthand)}/main/${relativePath}`;
}

function toGithubRepoUrl(shorthand) {
  return `https://github.com/${normalizeText(shorthand)}.git`;
}

function resolveRemoteRepositoryUrl(source) {
  const normalizedSource = normalizeText(source);
  if (isGithubShorthand(normalizedSource)) {
    return toGithubRepoUrl(normalizedSource);
  }
  if (isHttpUrl(normalizedSource) && normalizedSource.includes("github.com/")) {
    const match = normalizedSource.match(/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    if (match?.[1]) {
      return toGithubRepoUrl(match[1]);
    }
  }
  return "";
}

function isPathInside(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function pathExists(candidatePath) {
  return fs.access(candidatePath).then(() => true).catch(() => false);
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false
  });
}

async function cloneRepository(sourceUrl, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await execFileAsync("git", ["clone", "--depth", "1", sourceUrl, targetDir], {
    windowsHide: true,
    timeout: 120000
  });
}

async function cloneSubdirectory(sourceUrl, subdirectory, targetDir, ref = "") {
  const tempDir = `${targetDir}.tmp-${Date.now()}`;
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(sourceUrl, tempDir);
  try {
    await execFileAsync("git", args, {
      windowsHide: true,
      timeout: 120000
    });
    const sourceDir = path.join(tempDir, subdirectory);
    const stats = await fs.stat(sourceDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error("plugin subdirectory not found");
    }
    await copyDirectory(sourceDir, targetDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function safePluginDirName(name) {
  return normalizeText(name)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || `plugin-${Date.now()}`;
}

function expandSourcePath(source, yyzDir, projectRootDir = "") {
  const normalizedSource = normalizeText(source);
  if (!normalizedSource || isRemoteSource(normalizedSource)) {
    return "";
  }

  const resolvedYyzDir = path.resolve(yyzDir);
  const resolvedProjectRootDir = projectRootDir ? path.resolve(projectRootDir) : "";
  return normalizedSource
    .replaceAll("${YYZ_DIR}", resolvedYyzDir)
    .replaceAll("$YYZ_DIR", resolvedYyzDir)
    .replaceAll("${PROJECT_ROOT}", resolvedProjectRootDir)
    .replaceAll("$PROJECT_ROOT", resolvedProjectRootDir);
}

function resolveInstallSource(entry = {}, options = {}) {
  const sourceDescriptor = normalizeSourceDescriptor(
    entry.source || entry.path || entry.localPath || entry.repository || entry.url
  );
  const sourceText = isPlainObject(sourceDescriptor)
    ? normalizeText(sourceDescriptor.url || sourceDescriptor.repository)
    : sourceDescriptor;
  const marketplaceRepositoryUrl = normalizeText(entry?.marketplace?.repositoryUrl);

  if (!sourceText) {
    return { kind: "missing" };
  }

  if (marketplaceRepositoryUrl && sourceText.startsWith("./")) {
    return {
      kind: "git-subdir",
      url: marketplaceRepositoryUrl,
      path: sourceText.replace(/^\.\/+/u, ""),
      ref: ""
    };
  }

  if (isPlainObject(sourceDescriptor) && sourceDescriptor.type === "git-subdir") {
    return {
      kind: "git-subdir",
      url: sourceText,
      path: sourceDescriptor.path,
      ref: sourceDescriptor.ref
    };
  }

  if (isPlainObject(sourceDescriptor) && sourceDescriptor.type === "github") {
    return {
      kind: "git-repo",
      url: toGithubRepoUrl(sourceText)
    };
  }

  if (isPlainObject(sourceDescriptor) && sourceDescriptor.type === "url") {
    return {
      kind: "git-repo",
      url: sourceText.endsWith(".git") ? sourceText : `${sourceText}.git`
    };
  }

  if (isGithubShorthand(sourceText)) {
    return {
      kind: "git-repo",
      url: toGithubRepoUrl(sourceText)
    };
  }

  if (isGitUrl(sourceText)) {
    return {
      kind: "git-repo",
      url: sourceText
    };
  }

  if (isHttpUrl(sourceText)) {
    return {
      kind: "git-repo",
      url: sourceText.endsWith(".git") ? sourceText : `${sourceText}.git`
    };
  }

  const localPath = expandSourcePath(
    sourceText,
    options.localMarketplaceRootDir,
    options.projectRootDir
  );

  return localPath
    ? { kind: "local-dir", path: localPath }
    : { kind: "missing" };
}

function normalizeMarketplaceRecord(record = {}) {
  const source = normalizeText(record.source);
  const name = normalizeText(record.name) || safePluginDirName(record.displayName || source);
  return {
    id: normalizeText(record.id) || normalizeName(name) || `marketplace-${Date.now()}`,
    name,
    displayName: normalizeText(record.displayName) || name,
    description: normalizeText(record.description),
    source,
    sourceType: isRemoteSource(source) ? "remote" : "path",
    addedAt: Number(record.addedAt ?? Date.now()),
    updatedAt: Number(record.updatedAt ?? 0),
    error: normalizeText(record.error)
  };
}

function normalizePluginEntry(entry = {}, marketplace = {}) {
  const name = normalizeText(entry.name);
  if (!name) {
    return null;
  }

  const sourceDescriptor = normalizeSourceDescriptor(entry.source || entry.path || entry.localPath || entry.repository || entry.url);
  const rawPluginPath = isPlainObject(sourceDescriptor)
    ? normalizeText(sourceDescriptor.url || sourceDescriptor.repository)
    : sourceDescriptor;
  const marketplaceBaseDir = normalizeText(marketplace.baseDir);
  const resolvedPluginPath =
    rawPluginPath && marketplaceBaseDir && !path.isAbsolute(rawPluginPath) && !isRemoteSource(rawPluginPath)
      ? path.resolve(marketplaceBaseDir, rawPluginPath)
      : rawPluginPath;

  return {
    name,
    displayName: normalizeText(entry.displayName) || name,
    version: normalizeText(entry.version),
    description: normalizeText(entry.description),
    repository: normalizeText(entry.repository),
    entry: normalizeText(entry.entry) || `${name}@${marketplace.name}`,
    homepage: normalizeText(entry.homepage),
    author: isPlainObject(entry.author) ? entry.author : normalizeText(entry.author),
    path: resolvedPluginPath,
    url: normalizeText(entry.url || entry.downloadUrl),
    source: sourceDescriptor,
    marketplace: {
      id: marketplace.id,
      name: marketplace.name,
      displayName: marketplace.displayName,
      source: marketplace.source,
      repositoryUrl: marketplace.repositoryUrl || ""
    }
  };
}

function normalizeCatalog(rawCatalog = {}, marketplace = {}) {
  const plugins = Array.isArray(rawCatalog.plugins)
    ? rawCatalog.plugins.map((entry) => normalizePluginEntry(entry, marketplace)).filter(Boolean)
    : [];

  return {
    name: normalizeText(rawCatalog.name) || marketplace.name,
    displayName: normalizeText(rawCatalog.displayName) || marketplace.displayName,
    description: normalizeText(rawCatalog.description) || marketplace.description,
    plugins
  };
}

export class MarketplaceStore {
  constructor(options = {}) {
    this.filePath = path.resolve(String(options.filePath ?? ""));
    this.rootDir = path.resolve(String(options.rootDir ?? path.dirname(this.filePath)));
    this.localMarketplaceRootDir = path.resolve(String(options.localMarketplaceRootDir ?? path.dirname(this.rootDir)));
    this.localMarketplaceFilePath = path.resolve(
      String(options.localMarketplaceFilePath ?? path.join(this.localMarketplaceRootDir, ".plugin", "marketplace.json"))
    );
    this.projectRootDir = path.resolve(String(options.projectRootDir ?? ""));
    this.pluginInstallDir = path.resolve(String(options.pluginInstallDir ?? ""));
  }

  async ensureFile() {
    await fs.mkdir(this.rootDir, { recursive: true });
    if (!(await pathExists(this.filePath))) {
      await fs.writeFile(this.filePath, JSON.stringify({ marketplaces: [] }, null, 2), "utf8");
    }
    await fs.mkdir(path.dirname(this.localMarketplaceFilePath), { recursive: true });
    if (!(await pathExists(this.localMarketplaceFilePath))) {
      await fs.writeFile(this.localMarketplaceFilePath, JSON.stringify({
        name: "yyz-local",
        displayName: "YYZ 本地插件市场",
        description: "Local plugins installed under .yyz/plugins",
        plugins: []
      }, null, 2), "utf8");
    }
  }

  async readConfig() {
    await this.ensureFile();
    const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    const marketplaces = Array.isArray(parsed?.marketplaces)
      ? parsed.marketplaces.map(normalizeMarketplaceRecord)
      : [];
    return { marketplaces };
  }

  async saveConfig(config) {
    const marketplaces = Array.isArray(config?.marketplaces)
      ? config.marketplaces.map(normalizeMarketplaceRecord)
      : [];
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ marketplaces }, null, 2), "utf8");
    return { marketplaces };
  }

  async addMarketplace(payload = {}) {
    const source = normalizeText(payload.source);
    if (!source) {
      throw new Error("marketplace source is required");
    }

    const current = await this.readConfig();
    const nextRecord = normalizeMarketplaceRecord({
      ...payload,
      source,
      addedAt: Date.now()
    });
    const nextMarketplaces = current.marketplaces.filter(
      (item) => normalizeName(item.id) !== normalizeName(nextRecord.id)
        && normalizeText(item.source) !== source
    );
    nextMarketplaces.push(nextRecord);
    await this.saveConfig({ marketplaces: nextMarketplaces });
    return nextRecord;
  }

  async removeMarketplace(id) {
    const normalizedId = normalizeName(id);
    const current = await this.readConfig();
    const nextMarketplaces = current.marketplaces.filter(
      (item) => normalizeName(item.id) !== normalizedId && normalizeName(item.name) !== normalizedId
    );
    await this.saveConfig({ marketplaces: nextMarketplaces });
    return nextMarketplaces.length !== current.marketplaces.length;
  }

  resolveMarketplaceFile(source) {
    const normalizedSource = expandSourcePath(source, this.localMarketplaceRootDir, this.projectRootDir);
    if (!normalizedSource) {
      return "";
    }
    const resolvedSource = path.resolve(normalizedSource);
    return path.join(resolvedSource, ".plugin", "marketplace.json");
  }

  resolveMarketplaceUrl(source) {
    const normalizedSource = normalizeText(source);
    if (isGithubShorthand(normalizedSource)) {
      return toGithubRawUrl(normalizedSource, ".claude-plugin/marketplace.json");
    }
    if (isHttpUrl(normalizedSource) && /\.json(?:[#?].*)?$/i.test(normalizedSource)) {
      return normalizedSource;
    }
    if (isHttpUrl(normalizedSource) && normalizedSource.includes("github.com/")) {
      const match = normalizedSource.match(/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
      if (match?.[1]) {
        return toGithubRawUrl(match[1], ".claude-plugin/marketplace.json");
      }
    }
    return "";
  }

  async fetchCatalog(marketplace) {
    const rawSource = normalizeText(marketplace.source);
    const source = isRemoteSource(rawSource)
      ? rawSource
      : expandSourcePath(rawSource, this.localMarketplaceRootDir, this.projectRootDir);
    if (!source) {
      throw new Error("marketplace source is required");
    }

    let rawText = "";
    let baseDir = "";
    let repositoryUrl = "";
    if (isRemoteSource(source)) {
      const marketplaceUrl = this.resolveMarketplaceUrl(source);
      if (!marketplaceUrl) {
        throw new Error("remote marketplace must be a GitHub repo shorthand/url or a marketplace json URL");
      }
      const response = await fetch(marketplaceUrl);
      if (!response.ok) {
        throw new Error(`failed to fetch marketplace: ${response.status}`);
      }
      rawText = await response.text();
      repositoryUrl = resolveRemoteRepositoryUrl(source);
    } else {
      const filePath = this.resolveMarketplaceFile(source);
      baseDir = path.dirname(path.dirname(filePath));
      rawText = await fs.readFile(filePath, "utf8");
    }

    return normalizeCatalog(JSON.parse(rawText), {
      ...marketplace,
      baseDir,
      repositoryUrl
    });
  }

  async listMarketplaces() {
    const current = await this.readConfig();
    const localMarketplace = normalizeMarketplaceRecord({
      id: "yyz-local",
      name: "yyz-local",
      displayName: "YYZ 本地插件市场",
      description: "Local marketplace rooted at .yyz",
      source: "${YYZ_DIR}",
      sourceType: "path",
      addedAt: 0,
      updatedAt: 0
    });
    return [
      localMarketplace,
      ...current.marketplaces.filter((item) => normalizeName(item.id) !== "yyz-local")
    ];
  }

  async listMarketplacePlugins() {
    const marketplaces = await this.listMarketplaces();
    const plugins = [];
    const errors = [];

    for (const marketplace of marketplaces) {
      try {
        const catalog = await this.fetchCatalog(marketplace);
        plugins.push(...catalog.plugins);
      } catch (error) {
        errors.push({
          marketplaceId: marketplace.id,
          marketplaceName: marketplace.name,
          source: marketplace.source,
          message: normalizeText(error?.message) || "marketplace failed to load"
        });
      }
    }

    return { marketplaces, plugins, errors };
  }

  async installPlugin(entry = {}) {
    const pluginName = normalizeText(entry.name);
    if (!pluginName) {
      throw new Error("plugin name is required");
    }
    if (!this.pluginInstallDir) {
      throw new Error("plugin install directory is not configured");
    }

    const installSource = resolveInstallSource(entry, {
      localMarketplaceRootDir: this.localMarketplaceRootDir,
      projectRootDir: this.projectRootDir
    });
    if (installSource.kind === "missing") {
      throw new Error("plugin source is required");
    }

    const targetDir = path.join(this.pluginInstallDir, safePluginDirName(pluginName));
    if (!isPathInside(this.pluginInstallDir, targetDir)) {
      throw new Error("plugin install path escapes plugin directory");
    }

    if (installSource.kind === "git-subdir") {
      await cloneSubdirectory(installSource.url, installSource.path, targetDir, installSource.ref);
    } else if (installSource.kind === "git-repo") {
      await cloneRepository(installSource.url, targetDir);
    } else if (installSource.kind === "local-dir") {
      const resolvedSource = path.resolve(installSource.path);
      const stats = await fs.stat(resolvedSource).catch(() => null);
      if (!stats?.isDirectory()) {
        throw new Error("plugin source directory not found");
      }
      await copyDirectory(resolvedSource, targetDir);
    } else {
      throw new Error("unsupported plugin source");
    }
    return {
      name: pluginName,
      installed: true,
      targetDir
    };
  }
}
