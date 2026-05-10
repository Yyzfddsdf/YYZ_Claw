import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_FILE_NAME = "settings.json";
const MANIFEST_FILE_NAME = "pet.json";
const PACKAGE_MANIFEST_FILE_NAME = "pet.json";
const PACKAGE_SPRITESHEET_FILE_NAME = "spritesheet.webp";

const ALLOWED_EXTENSIONS = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"]
]);

const CODEX_DEFAULT_ROW_STATES = [
  {
    row: 0,
    state: "idle",
    label: "待机",
    frames: [0, 1, 2, 3, 4, 5],
    durations: [280, 110, 110, 140, 140, 320]
  },
  {
    row: 1,
    state: "running-right",
    label: "向右跑动",
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    durations: [120, 120, 120, 120, 120, 120, 120, 220]
  },
  {
    row: 2,
    state: "running-left",
    label: "向左跑动",
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    durations: [120, 120, 120, 120, 120, 120, 120, 220]
  },
  {
    row: 3,
    state: "waving",
    label: "挥手",
    frames: [0, 1, 2, 3],
    durations: [140, 140, 140, 280]
  },
  {
    row: 4,
    state: "jumping",
    label: "跳跃",
    frames: [0, 1, 2, 3, 4],
    durations: [140, 140, 140, 140, 280]
  },
  {
    row: 6,
    state: "waiting",
    label: "等待",
    frames: [0, 1, 2, 3, 4, 5],
    durations: [150, 150, 150, 150, 150, 260]
  },
  {
    row: 7,
    state: "running",
    label: "干活中",
    frames: [0, 1, 2, 3, 4, 5],
    durations: [120, 120, 120, 120, 120, 220]
  }
];

function normalizeText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeFileName(value) {
  const baseName = path.basename(normalizeText(value, 180));
  return baseName
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeInteger(value, fallback, min = 0, max = 8192) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeUploadPath(value) {
  const segments = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return [];
  }
  return segments;
}

function stripTopLevelFolder(value) {
  const segments = normalizeUploadPath(value);
  if (segments.length <= 1) {
    return [];
  }
  return segments.slice(1);
}

function normalizeNumberArray(value, maxLength = 64, min = 0, max = 8192) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item >= min && item <= max)
    .slice(0, maxLength);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function defaultManifest() {
  return {
    version: 1,
    description: "Codex 宠物运行清单。",
    sprite: {
      columns: 8,
      rows: 9,
      totalFrames: 72,
      frameWidth: 128,
      frameHeight: 128,
      rowStates: CODEX_DEFAULT_ROW_STATES
    }
  };
}

function normalizeManifest(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const spriteSource =
    source.sprite && typeof source.sprite === "object" && !Array.isArray(source.sprite)
      ? source.sprite
      : {};
  const rowStatesSource = Array.isArray(spriteSource.rowStates) ? spriteSource.rowStates : [];

  const normalizedRowStates = rowStatesSource
    .map((rowState, index) => {
      const frames = normalizeNumberArray(rowState?.frames, 32, 0, 255);
      const durations = normalizeNumberArray(rowState?.durations, 32, 1, 10000);
      const fallback = CODEX_DEFAULT_ROW_STATES[index] || {};
      return {
        row: normalizeInteger(rowState?.row, fallback.row ?? index, 0, 15),
        state:
          normalizeText(rowState?.state, 40) ||
          fallback.state ||
          `state-${index + 1}`,
        label:
          normalizeText(rowState?.label, 40) ||
          fallback.label ||
          `状态 ${index + 1}`,
        frames: frames.length > 0 ? frames : fallback.frames || [index],
        durations:
          durations.length > 0 ? durations : fallback.durations || [160],
        fps: normalizeInteger(rowState?.fps, fallback.fps || 6, 1, 24)
      };
    })
    .slice(0, 9);

  return {
    version: normalizeInteger(source.version, 1, 1, 99),
    description:
      normalizeText(source.description, 240) || defaultManifest().description,
    sprite: {
      columns: normalizeInteger(spriteSource.columns, 8, 1, 16),
      rows: normalizeInteger(spriteSource.rows, 9, 1, 16),
      totalFrames: normalizeInteger(spriteSource.totalFrames, 72, 1, 256),
      frameWidth: normalizeInteger(spriteSource.frameWidth, 128, 0, 8192),
      frameHeight: normalizeInteger(spriteSource.frameHeight, 128, 0, 8192),
      rowStates:
        normalizedRowStates.length > 0 ? normalizedRowStates : defaultManifest().sprite.rowStates
    }
  };
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: normalizeBoolean(source.enabled, true),
    selectedPet: normalizeFileName(source.selectedPet),
    detached: normalizeBoolean(source.detached, false),
    detachedPosition: {
      x: normalizeInteger(source?.detachedPosition?.x, 80, -10000, 10000),
      y: normalizeInteger(source?.detachedPosition?.y, 80, -10000, 10000)
    }
  };
}

function packageAssetUrl(fileName, assetName, mtimeMs) {
  return `/api/pets/assets/${encodeURIComponent(fileName)}/${encodeURIComponent(assetName)}?v=${Math.trunc(mtimeMs)}`;
}

function isFileInsideRoot(filePath, rootPath) {
  const resolvedRoot = `${rootPath}${path.sep}`;
  return filePath === rootPath || filePath.startsWith(resolvedRoot);
}

export class PetStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || "");
    this.defaultRootDir = path.resolve(options.defaultRootDir || this.rootDir);
  }

  resolveSettingsPath() {
    return path.join(this.rootDir, SETTINGS_FILE_NAME);
  }

  resolveManifestPath() {
    return path.join(this.rootDir, MANIFEST_FILE_NAME);
  }

  getMimeType(fileName) {
    return ALLOWED_EXTENSIONS.get(path.extname(fileName).toLowerCase()) ?? "";
  }

  async ensureDir() {
    await fs.mkdir(this.rootDir, { recursive: true });

    if (!(await pathExists(this.resolveSettingsPath()))) {
      await fs.writeFile(
        this.resolveSettingsPath(),
        `${JSON.stringify(normalizeSettings({}), null, 2)}\n`,
        "utf8"
      );
    }

    if (!(await pathExists(this.resolveManifestPath()))) {
      await fs.writeFile(
        this.resolveManifestPath(),
        `${JSON.stringify(defaultManifest(), null, 2)}\n`,
        "utf8"
      );
    }
  }

  async readManifest() {
    await this.ensureDir();
    const raw = await fs.readFile(this.resolveManifestPath(), "utf8");
    return normalizeManifest(safeJsonParse(raw, defaultManifest()));
  }

  async saveManifest(nextManifest = {}) {
    await this.ensureDir();
    const manifest = normalizeManifest(nextManifest);
    await fs.writeFile(this.resolveManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async readSettings() {
    await this.ensureDir();
    const raw = await fs.readFile(this.resolveSettingsPath(), "utf8");
    const settings = normalizeSettings(safeJsonParse(raw, {}));
    if (settings.selectedPet) {
      const pet = await this.getPetByFileName(settings.selectedPet);
      if (!pet) {
        return { ...settings, selectedPet: "" };
      }
    }
    return settings;
  }

  async saveSettings(nextSettings = {}) {
    await this.ensureDir();
    const settings = normalizeSettings(nextSettings);
    if (settings.selectedPet) {
      const pet = await this.getPetByFileName(settings.selectedPet);
      if (!pet) {
        throw new Error("pet image not found");
      }
    }
    await fs.writeFile(this.resolveSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }

  async readPackageManifest(packageDir) {
    const manifestPath = path.join(packageDir, PACKAGE_MANIFEST_FILE_NAME);
    if (!(await pathExists(manifestPath))) {
      return null;
    }

    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = safeJsonParse(raw, null);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return null;
    }

    const spritesheetName =
      path.basename(normalizeText(manifest.spritesheetPath, 180)) ||
      PACKAGE_SPRITESHEET_FILE_NAME;
    const spritesheetPath = path.join(packageDir, spritesheetName);
    if (!(await pathExists(spritesheetPath))) {
      return null;
    }

    const stat = await fs.stat(spritesheetPath);
    const fallbackName = path.basename(packageDir);
    return {
      id: normalizeFileName(manifest.id) || fallbackName,
      displayName: normalizeText(manifest.displayName, 120) || fallbackName,
      description: normalizeText(manifest.description, 240),
      spritesheetPath: spritesheetName,
      size: stat.size,
      updatedAt: stat.mtimeMs
    };
  }

  async listPets() {
    await this.ensureDir();
    const manifests = await Promise.all([
      this.listPetsFromDir(this.defaultRootDir, "default"),
      this.listPetsFromDir(this.rootDir, "user")
    ]);
    const byName = new Map();
    for (const pet of manifests.flat()) {
      byName.set(pet.fileName, pet);
    }
    return Array.from(byName.values()).sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-CN")
    );
  }

  async listPetsFromDir(rootDir, source) {
    if (!(await pathExists(rootDir))) {
      return [];
    }

    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    const items = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const packageDir = path.join(rootDir, dirent.name);
      const packageManifest = await this.readPackageManifest(packageDir);
      if (!packageManifest) {
        continue;
      }

      items.push({
        id: packageManifest.id,
        fileName: dirent.name,
        name: packageManifest.displayName,
        displayName: packageManifest.displayName,
        description: packageManifest.description,
        kind: "codex-package",
        source,
        size: packageManifest.size,
        updatedAt: packageManifest.updatedAt,
        spritesheetPath: packageManifest.spritesheetPath,
        url: packageAssetUrl(
          dirent.name,
          packageManifest.spritesheetPath,
          packageManifest.updatedAt
        )
      });
    }
    return items;
  }

  async getPetByFileName(fileName) {
    const safeName = normalizeFileName(fileName);
    if (!safeName) {
      return null;
    }
    const pets = await this.listPets();
    return pets.find((item) => item.fileName === safeName) ?? null;
  }

  async getAsset(fileName, assetName = "") {
    const safeName = normalizeFileName(fileName);
    const safeAsset = normalizeFileName(assetName);
    if (!safeName) {
      return null;
    }

    for (const rootDir of [this.rootDir, this.defaultRootDir]) {
      const packageDir = path.join(rootDir, safeName);
      if (!(await pathExists(packageDir))) {
        continue;
      }

      const targetAsset = safeAsset || PACKAGE_SPRITESHEET_FILE_NAME;
      const assetPath = path.join(packageDir, targetAsset);
      if (!(await pathExists(assetPath))) {
        continue;
      }

      return {
        contentType: this.getMimeType(targetAsset) || "image/webp",
        buffer: await fs.readFile(assetPath)
      };
    }

    return null;
  }

  async saveUploadedPetPackage(uploadedFiles = []) {
    await this.ensureDir();

    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
      throw new Error("pet package files are required");
    }

    const normalizedFiles = [];

    for (const file of uploadedFiles) {
      const relativePath = normalizeUploadPath(file?.originalname ?? file?.filename ?? "");
      if (relativePath.length === 0) {
        throw new Error("pet package file path is required");
      }

      normalizedFiles.push({
        buffer: Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer ?? []),
        relativePath: relativePath.join(path.sep)
      });
    }

    const topLevelNames = normalizedFiles.map((item) => item.relativePath.split(path.sep)[0]);
    const sharedTopLevel = topLevelNames.length > 0 && topLevelNames.every((item) => item === topLevelNames[0]);
    const hasNestedPaths = normalizedFiles.some((item) => item.relativePath.includes(path.sep));
    const packageRootName = sharedTopLevel && hasNestedPaths ? topLevelNames[0] : "";

    const fileEntries = new Map();
    for (const item of normalizedFiles) {
      const relativePath = packageRootName
        ? item.relativePath.split(path.sep).slice(1).join(path.sep)
        : item.relativePath;
      if (!relativePath) {
        throw new Error("pet package file path is required");
      }
      if (fileEntries.has(relativePath)) {
        throw new Error(`duplicate file found in upload: ${relativePath}`);
      }
      fileEntries.set(relativePath, {
        buffer: item.buffer,
        relativePath
      });
    }

    const manifestEntry = fileEntries.get(MANIFEST_FILE_NAME);
    if (!manifestEntry) {
      throw new Error("pet.json is required");
    }

    const parsedManifest = safeJsonParse(manifestEntry.buffer.toString("utf8"), null);
    if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) {
      throw new Error("pet.json must be valid JSON");
    }

    const spritesheetName =
      path.basename(normalizeText(parsedManifest.spritesheetPath, 180)) ||
      PACKAGE_SPRITESHEET_FILE_NAME;
    if (!fileEntries.has(spritesheetName)) {
      throw new Error(`spritesheet file is required: ${spritesheetName}`);
    }

    const packageName = normalizeFileName(parsedManifest.id) || normalizeFileName(packageRootName);
    if (!packageName) {
      throw new Error("pet package id is required");
    }

    const targetDir = path.join(this.rootDir, packageName);
    if (!isFileInsideRoot(targetDir, this.rootDir)) {
      throw new Error("invalid pet package target");
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });

    for (const { buffer, relativePath } of fileEntries.values()) {
      const outputPath = path.join(targetDir, relativePath);
      if (!isFileInsideRoot(outputPath, targetDir)) {
        throw new Error(`invalid file path: ${relativePath}`);
      }
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, buffer);
    }

    const packageManifest = await this.readPackageManifest(targetDir);
    if (!packageManifest) {
      throw new Error("uploaded pet package is invalid");
    }

    return {
      id: packageManifest.id,
      fileName: packageName,
      name: packageManifest.displayName,
      displayName: packageManifest.displayName,
      description: packageManifest.description,
      kind: "codex-package",
      source: "user",
      size: packageManifest.size,
      updatedAt: packageManifest.updatedAt,
      spritesheetPath: packageManifest.spritesheetPath,
      url: packageAssetUrl(packageName, packageManifest.spritesheetPath, packageManifest.updatedAt)
    };
  }
}
