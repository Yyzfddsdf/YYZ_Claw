import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";

import { safeJsonParse } from "../../utils/safeJsonParse.js";
import { migrateLegacyModelConfig } from "./modelProfileConfig.js";

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class ConfigStore {
  constructor(configFilePath) {
    this.configFilePath = configFilePath;
  }

  async ensureFile() {
    const dirPath = path.dirname(this.configFilePath);
    await fs.mkdir(dirPath, { recursive: true });

    const exists = await fileExists(this.configFilePath);
    if (!exists) {
      await fs.writeFile(this.configFilePath, "{}\n", "utf8");
    }
  }

  async read() {
    await this.ensureFile();

    const raw = await fs.readFile(this.configFilePath, "utf8");
    const parsed = safeJsonParse(raw, {});

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const migrated = migrateLegacyModelConfig(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
        await this.save(migrated);
      }
      return migrated;
    }

    const migrated = migrateLegacyModelConfig({});
    await this.save(migrated);
    return migrated;
  }

  readSync() {
    const dirPath = path.dirname(this.configFilePath);
    fsSync.mkdirSync(dirPath, { recursive: true });

    if (!fsSync.existsSync(this.configFilePath)) {
      fsSync.writeFileSync(this.configFilePath, "{}\n", "utf8");
    }

    const raw = fsSync.readFileSync(this.configFilePath, "utf8");
    const parsed = safeJsonParse(raw, {});
    const migrated = migrateLegacyModelConfig(
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    );

    if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
      fsSync.writeFileSync(this.configFilePath, JSON.stringify(migrated, null, 2) + "\n", "utf8");
    }

    return migrated;
  }

  async save(nextConfig) {
    await this.ensureFile();

    const payload = JSON.stringify(nextConfig, null, 2) + "\n";
    await fs.writeFile(this.configFilePath, payload, "utf8");

    return nextConfig;
  }
}
