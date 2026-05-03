import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT, YYZ_DIR } from "./paths.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getDefaultAssetCandidates() {
  const candidates = [
    normalizeText(process.env.YYZ_CLAW_DEFAULTS_DIR),
    path.join(PROJECT_ROOT, "resources", "defaults")
  ];

  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "resources", "defaults"),
      path.join(process.resourcesPath, "defaults")
    );
  }

  return [...new Set(candidates.filter(Boolean).map((item) => path.resolve(item)))];
}

async function copyMissingTree(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyMissingTree(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || (await pathExists(targetPath))) {
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

export async function initializeDefaultYyzAssets(options = {}) {
  const targetDir = path.resolve(options.targetDir || YYZ_DIR);
  const candidates = Array.isArray(options.defaultAssetDirs)
    ? options.defaultAssetDirs
    : getDefaultAssetCandidates();

  await fs.mkdir(targetDir, { recursive: true });

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    await copyMissingTree(candidate, targetDir);
    return {
      seeded: true,
      sourceDir: candidate,
      targetDir
    };
  }

  return {
    seeded: false,
    sourceDir: "",
    targetDir
  };
}
