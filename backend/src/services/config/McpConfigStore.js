import fs from "node:fs/promises";
import path from "node:path";

import { mcpConfigSchema } from "../../schemas/mcpSchema.js";
import { safeJsonParse } from "../../utils/safeJsonParse.js";

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class McpConfigStore {
  constructor(configFilePath) {
    this.configFilePath = configFilePath;
  }

  async ensureFile() {
    const dirPath = path.dirname(this.configFilePath);
    await fs.mkdir(dirPath, { recursive: true });

    const exists = await fileExists(this.configFilePath);
    if (!exists) {
      await fs.writeFile(this.configFilePath, "{\n  \"servers\": []\n}\n", "utf8");
    }
  }

  async read() {
    await this.ensureFile();

    const raw = await fs.readFile(this.configFilePath, "utf8");
    const parsed = safeJsonParse(raw, {});
    return mcpConfigSchema.parse(parsed);
  }

  async save(nextConfig) {
    await this.ensureFile();

    const validated = mcpConfigSchema.parse(nextConfig);
    const payload = JSON.stringify(validated, null, 2) + "\n";
    await fs.writeFile(this.configFilePath, payload, "utf8");

    return validated;
  }
}
