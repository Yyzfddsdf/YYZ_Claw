import fs from "node:fs/promises";
import path from "node:path";

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePluginSettings(rawSettings = {}) {
  const plugins =
    rawSettings?.plugins && typeof rawSettings.plugins === "object" && !Array.isArray(rawSettings.plugins)
      ? rawSettings.plugins
      : {};
  const normalizedPlugins = {};

  for (const [pluginName, settings] of Object.entries(plugins)) {
    const normalizedName = String(pluginName ?? "").trim();
    if (!normalizedName) {
      continue;
    }

    normalizedPlugins[normalizedName] = {
      enabled: normalizeBoolean(settings?.enabled, false)
    };
  }

  return {
    plugins: normalizedPlugins
  };
}

export class PluginSettingsStore {
  constructor(filePath) {
    this.filePath = path.resolve(String(filePath ?? ""));
  }

  async ensureFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(
        this.filePath,
        JSON.stringify(
          {
            plugins: {}
          },
          null,
          2
        ),
        "utf8"
      );
    }
  }

  async read() {
    await this.ensureFile();
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      return normalizePluginSettings(JSON.parse(rawContent));
    } catch {
      return {
        plugins: {}
      };
    }
  }

  async write(settings) {
    const normalized = normalizePluginSettings(settings);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }

  async setPluginEnabled(pluginName, enabled) {
    const normalizedName = String(pluginName ?? "").trim();
    if (!normalizedName) {
      throw new Error("pluginName is required");
    }

    const settings = await this.read();
    settings.plugins[normalizedName] = {
      ...(settings.plugins[normalizedName] ?? {}),
      enabled: Boolean(enabled)
    };
    return this.write(settings);
  }
}
