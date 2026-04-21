import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../../utils/safeJsonParse.js";

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const key = skillName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(skillName);
  }

  return normalized;
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    activeProviderKey: normalizeProviderKey(source.activeProviderKey),
    workspacePath: String(source.workspacePath ?? "").trim(),
    developerPrompt: String(source.developerPrompt ?? "").trim(),
    activeSkillNames: normalizeSkillNames(source.activeSkillNames)
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
}
