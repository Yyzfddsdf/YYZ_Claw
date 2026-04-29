import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../../utils/safeJsonParse.js";

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    activeProviderKey: normalizeProviderKey(source.activeProviderKey),
    targetConversationId: String(source.targetConversationId ?? "").trim()
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

export class RemoteControlConfigStore {
  constructor(filePath) {
    this.filePath = String(filePath ?? "").trim();
  }

  async ensureFile() {
    if (!this.filePath) {
      throw new Error("remote control config path is required");
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
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

  async save(nextValue = {}) {
    await this.ensureFile();
    const normalized = normalizeConfig(nextValue);
    await fs.writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  async replacePersonaId(previousPersonaId, nextPersonaId) {
    return false;
  }
}
