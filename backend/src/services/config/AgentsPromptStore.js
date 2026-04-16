import fs from "node:fs/promises";
import path from "node:path";

async function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function readOptionalText(filePath) {
  if (!filePath || !(await fileExists(filePath))) {
    return "";
  }

  const rawText = await fs.readFile(filePath, "utf8");
  return String(rawText ?? "").trim();
}

export class AgentsPromptStore {
  constructor(options) {
    this.globalFilePath = path.resolve(String(options.globalFilePath ?? ""));
  }

  resolveProjectFilePath(workplacePath, fileName = "AGENTS.md") {
    const resolvedWorkplacePath = String(workplacePath ?? "").trim();

    if (!resolvedWorkplacePath) {
      return "";
    }

    return path.join(path.resolve(resolvedWorkplacePath), ".yyz", fileName);
  }

  async read(workplacePath = "") {
    const globalPrompt = await readOptionalText(this.globalFilePath);
    const projectFilePath = this.resolveProjectFilePath(workplacePath);
    const projectPrompt = projectFilePath && path.resolve(projectFilePath) !== path.resolve(this.globalFilePath)
      ? await readOptionalText(projectFilePath)
      : "";
    const soulFilePath = this.resolveProjectFilePath(workplacePath, "SOUL.md");
    const soulPrompt = soulFilePath ? await readOptionalText(soulFilePath) : "";

    return {
      globalFilePath: this.globalFilePath,
      projectFilePath,
      soulFilePath,
      globalPrompt,
      projectPrompt,
      soulPrompt
    };
  }
}
