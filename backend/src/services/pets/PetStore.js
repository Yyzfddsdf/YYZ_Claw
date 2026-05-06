import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_FILE_NAME = "settings.json";
const MANIFEST_FILE_NAME = "pet.json";
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

function normalizeInteger(value, fallback, min = 1, max = 8192) {
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
    description: "一个图片就是一个完整宠物；采用 4x4 常规切块，每行一种状态，每列一帧。",
    sprite: {
      columns: 4,
      rows: 4,
      totalFrames: 16,
      frameWidth: 0,
      frameHeight: 0,
      rowStates: [
        { row: 0, state: "idle", label: "空闲", frames: [0, 1, 2, 3], fps: 4 },
        { row: 1, state: "active", label: "活跃", frames: [4, 5, 6, 7], fps: 6 },
        { row: 2, state: "hover", label: "悬停", frames: [8, 9, 10, 11], fps: 5 },
        { row: 3, state: "detached", label: "拖出窗口", frames: [12, 13, 14, 15], fps: 6 }
      ]
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
      const frames = Array.isArray(rowState?.frames)
        ? rowState.frames
            .map((frame) => Number.parseInt(frame, 10))
            .filter((frame) => Number.isFinite(frame) && frame >= 0)
            .slice(0, 4)
        : [];
      return {
        row: normalizeInteger(rowState?.row, index, 0, 15),
        state: normalizeText(rowState?.state, 40) || ["idle", "active", "hover", "detached"][index] || `state-${index + 1}`,
        label: normalizeText(rowState?.label, 40) || ["空闲", "活跃", "悬停", "拖出窗口"][index] || `状态 ${index + 1}`,
        frames: frames.length > 0 ? frames : [index * 4, index * 4 + 1, index * 4 + 2, index * 4 + 3],
        fps: normalizeInteger(rowState?.fps, [4, 6, 5, 6][index] || 4, 1, 24)
      };
    })
    .slice(0, 4);

  return {
    version: normalizeInteger(source.version, 1, 1, 99),
    description:
      normalizeText(source.description, 240) ||
      "一个图片就是一个完整宠物；采用 4x4 常规切块，每行一种状态，每列一帧。",
    sprite: {
      columns: normalizeInteger(spriteSource.columns, 4, 1, 16),
      rows: normalizeInteger(spriteSource.rows, 4, 1, 16),
      totalFrames: normalizeInteger(spriteSource.totalFrames, 16, 1, 256),
      frameWidth: normalizeInteger(spriteSource.frameWidth, 0, 0, 8192),
      frameHeight: normalizeInteger(spriteSource.frameHeight, 0, 0, 8192),
      rowStates: normalizedRowStates.length > 0 ? normalizedRowStates : defaultManifest().sprite.rowStates
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
    return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async listPetsFromDir(rootDir, source) {
    if (!(await pathExists(rootDir))) {
      return [];
    }
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    const items = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) {
        continue;
      }
      const fileName = normalizeFileName(dirent.name);
      const mimeType = this.getMimeType(fileName);
      if (!fileName || !mimeType) {
        continue;
      }
      const assetPath = path.join(rootDir, fileName);
      const stat = await fs.stat(assetPath);
      items.push({
        id: fileName,
        name: path.basename(fileName, path.extname(fileName)),
        fileName,
        mimeType,
        source,
        size: stat.size,
        updatedAt: stat.mtimeMs,
        url: `/api/pets/assets/${encodeURIComponent(fileName)}?v=${Math.trunc(stat.mtimeMs)}`
      });
    }
    return items;
  }

  async getPetByFileName(fileName) {
    const safeName = normalizeFileName(fileName);
    if (!safeName || !this.getMimeType(safeName)) {
      return null;
    }
    const pets = await this.listPets();
    return pets.find((item) => item.fileName === safeName) ?? null;
  }

  async getAsset(fileName) {
    const safeName = normalizeFileName(fileName);
    const mimeType = this.getMimeType(safeName);
    if (!safeName || !mimeType) {
      return null;
    }

    for (const rootDir of [this.rootDir, this.defaultRootDir]) {
      const assetPath = path.join(rootDir, safeName);
      if (!(await pathExists(assetPath))) {
        continue;
      }
      return {
        contentType: mimeType,
        buffer: await fs.readFile(assetPath)
      };
    }

    return null;
  }

  async saveUploadedPet(file = {}) {
    await this.ensureDir();
    const originalName = normalizeFileName(file.originalname);
    const mimeType = normalizeText(file.mimetype, 80).toLowerCase();
    const ext = path.extname(originalName).toLowerCase();
    const expectedMime = ALLOWED_EXTENSIONS.get(ext);
    if (!originalName || !expectedMime || expectedMime !== mimeType || !file.buffer?.length) {
      throw new Error("pet must be an image file: png, jpg, jpeg, webp, gif, apng, avif, or svg");
    }

    const baseName = path.basename(originalName, ext).slice(0, 120) || "pet";
    let fileName = `${baseName}${ext}`;
    let suffix = 2;
    while (await pathExists(path.join(this.rootDir, fileName))) {
      fileName = `${baseName}_${suffix}${ext}`;
      suffix += 1;
    }

    await fs.writeFile(path.join(this.rootDir, fileName), file.buffer);
    return this.getPetByFileName(fileName);
  }
}
