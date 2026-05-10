import fs from "node:fs/promises";
import path from "node:path";

import {
  createDefaultHookSettings,
  hookSettingsSchema
} from "../../schemas/hookSettingsSchema.js";
import { safeJsonParse } from "../../utils/safeJsonParse.js";

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class HookSettingsStore {
  constructor(configFilePath) {
    this.configFilePath = configFilePath;
  }

  async ensureFile() {
    const dirPath = path.dirname(this.configFilePath);
    await fs.mkdir(dirPath, { recursive: true });

    const exists = await fileExists(this.configFilePath);
    if (!exists) {
      await fs.writeFile(
        this.configFilePath,
        `${JSON.stringify(createDefaultHookSettings(), null, 2)}\n`,
        "utf8"
      );
    }
  }

  async read() {
    await this.ensureFile();

    const raw = await fs.readFile(this.configFilePath, "utf8");
    const parsed = safeJsonParse(raw, createDefaultHookSettings());
    return hookSettingsSchema.parse(parsed);
  }

  async save(nextConfig) {
    await this.ensureFile();

    const validated = hookSettingsSchema.parse(nextConfig);
    await fs.writeFile(this.configFilePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    return validated;
  }
}
