import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_FILE_NAME = "settings.json";
const ALLOWED_EXTENSIONS = new Map([
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

function normalizeOpacity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.68;
  }
  return Math.min(0.98, Math.max(0.18, numeric));
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    selectedFile: normalizeFileName(source.selectedFile),
    surfaceOpacity: normalizeOpacity(source.surfaceOpacity)
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export class BackgroundStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
  }

  async ensureDir() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const settingsPath = this.resolveSettingsPath();
    if (!(await pathExists(settingsPath))) {
      await fs.writeFile(settingsPath, `${JSON.stringify(normalizeSettings({}), null, 2)}\n`, "utf8");
    }
  }

  resolveSettingsPath() {
    return path.join(this.rootDir, SETTINGS_FILE_NAME);
  }

  resolveAssetPath(fileName) {
    const safeName = normalizeFileName(fileName);
    if (!safeName || safeName === SETTINGS_FILE_NAME) {
      return "";
    }

    const root = path.resolve(this.rootDir);
    const target = path.resolve(root, safeName);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return "";
    }

    return target;
  }

  getMimeType(fileName) {
    return ALLOWED_EXTENSIONS.get(path.extname(fileName).toLowerCase()) ?? "";
  }

  async readSettings() {
    await this.ensureDir();
    const raw = await fs.readFile(this.resolveSettingsPath(), "utf8");
    const settings = normalizeSettings(safeJsonParse(raw, {}));
    if (settings.selectedFile && !(await pathExists(this.resolveAssetPath(settings.selectedFile)))) {
      return { ...settings, selectedFile: "" };
    }
    return settings;
  }

  async saveSettings(nextSettings = {}) {
    await this.ensureDir();
    const settings = normalizeSettings(nextSettings);
    if (settings.selectedFile && !(await pathExists(this.resolveAssetPath(settings.selectedFile)))) {
      throw new Error("background image not found");
    }

    await fs.writeFile(this.resolveSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }

  async listBackgrounds() {
    await this.ensureDir();
    const dirents = await fs.readdir(this.rootDir, { withFileTypes: true });
    const items = [];

    for (const dirent of dirents) {
      if (!dirent.isFile()) {
        continue;
      }

      const name = normalizeFileName(dirent.name);
      const mimeType = this.getMimeType(name);
      if (!name || name === SETTINGS_FILE_NAME || !mimeType) {
        continue;
      }

      const filePath = this.resolveAssetPath(name);
      const stat = await fs.stat(filePath);
      items.push({
        name,
        mimeType,
        size: stat.size,
        updatedAt: stat.mtimeMs,
        url: `/api/backgrounds/assets/${encodeURIComponent(name)}?v=${Math.trunc(stat.mtimeMs)}`
      });
    }

    return items.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async saveUploadedBackground(file = {}) {
    await this.ensureDir();
    const originalName = normalizeFileName(file.originalname);
    const mimeType = normalizeText(file.mimetype, 80).toLowerCase();
    const ext = path.extname(originalName).toLowerCase();
    const expectedMime = ALLOWED_EXTENSIONS.get(ext);
    if (!originalName || !expectedMime || expectedMime !== mimeType || !file.buffer?.length) {
      throw new Error("background must be an image file: png, jpg, jpeg, webp, gif, avif, or svg");
    }

    const baseName = path.basename(originalName, ext).slice(0, 120) || "background";
    let fileName = `${baseName}${ext}`;
    let suffix = 2;
    while (await pathExists(this.resolveAssetPath(fileName))) {
      fileName = `${baseName}_${suffix}${ext}`;
      suffix += 1;
    }

    await fs.writeFile(this.resolveAssetPath(fileName), file.buffer);
    return (await this.listBackgrounds()).find((item) => item.name === fileName) ?? null;
  }

  async deleteBackground(fileName) {
    const safeName = normalizeFileName(fileName);
    const filePath = this.resolveAssetPath(safeName);
    if (!filePath || !(await pathExists(filePath))) {
      return false;
    }

    const settings = await this.readSettings();
    await fs.rm(filePath, { force: true });
    if (settings.selectedFile === safeName) {
      await this.saveSettings({ ...settings, selectedFile: "" });
    }
    return true;
  }

  async getAsset(fileName) {
    const safeName = normalizeFileName(fileName);
    const mimeType = this.getMimeType(safeName);
    const filePath = this.resolveAssetPath(safeName);
    if (!mimeType || !filePath || !(await pathExists(filePath))) {
      return null;
    }

    return {
      contentType: mimeType,
      buffer: await fs.readFile(filePath)
    };
  }
}
