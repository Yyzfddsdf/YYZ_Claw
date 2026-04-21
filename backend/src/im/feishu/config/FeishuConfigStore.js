import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../../utils/safeJsonParse.js";

function normalizeConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    appId: String(source.appId ?? "").trim(),
    appSecret: String(source.appSecret ?? "").trim()
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class FeishuConfigStore {
  constructor(filePath) {
    this.filePath = String(filePath ?? "").trim();
  }

  async ensureFile() {
    if (!this.filePath) {
      throw new Error("feishu config path is required");
    }

    const dirPath = path.dirname(this.filePath);
    await fs.mkdir(dirPath, { recursive: true });

    const exists = await fileExists(this.filePath);
    if (!exists) {
      await fs.writeFile(
        this.filePath,
        `${JSON.stringify(normalizeConfig({}), null, 2)}\n`,
        "utf8"
      );
    }
  }

  async read() {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    return normalizeConfig(safeJsonParse(raw, {}));
  }

  async save(nextConfig = {}) {
    await this.ensureFile();
    const normalized = normalizeConfig(nextConfig);
    await fs.writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }
}
