import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../utils/safeJsonParse.js";

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
      return parsed;
    }

    return {};
  }

  async save(nextConfig) {
    await this.ensureFile();

    const payload = JSON.stringify(nextConfig, null, 2) + "\n";
    await fs.writeFile(this.configFilePath, payload, "utf8");

    return nextConfig;
  }
}
