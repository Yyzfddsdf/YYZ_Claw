import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendSourceRoot = path.join(projectRoot, "backend", "src");
const backendDistRoot = path.join(projectRoot, "backend-dist", "src");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(rootDir) {
  const result = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      result.push(fullPath);
    }
  }

  return result;
}

async function copyPackageJson() {
  const source = path.join(projectRoot, "backend", "package.json");
  const target = path.join(projectRoot, "backend-dist", "package.json");
  const raw = JSON.parse(await fs.readFile(source, "utf8"));
  const minimal = {
    name: raw.name || "backend",
    version: raw.version || "0.1.0",
    private: true,
    type: "module"
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(minimal, null, 2)}\n`, "utf8");
}

async function prepareBackendDist() {
  await fs.rm(path.join(projectRoot, "backend-dist"), { recursive: true, force: true });
  await fs.mkdir(backendDistRoot, { recursive: true });

  const files = await listFiles(backendSourceRoot);
  for (const sourcePath of files) {
    const relativePath = path.relative(backendSourceRoot, sourcePath);
    const targetPath = path.join(backendDistRoot, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (sourcePath.endsWith(".js")) {
      const code = await fs.readFile(sourcePath, "utf8");
      const transformed = await esbuild.transform(code, {
        loader: "js",
        format: "esm",
        target: "node20",
        minify: true,
        legalComments: "none"
      });
      await fs.writeFile(targetPath, transformed.code, "utf8");
      continue;
    }

    await fs.copyFile(sourcePath, targetPath);
  }

  await copyPackageJson();
}

if (!(await pathExists(backendSourceRoot))) {
  throw new Error(`Backend source root not found: ${backendSourceRoot}`);
}

await prepareBackendDist();
console.log("[package] backend runtime prepared");
