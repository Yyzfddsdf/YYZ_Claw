import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules"
]);

export function normalizeWorkspaceRelativePath(inputPath = "") {
  const normalized = String(inputPath ?? "").replace(/\\/g, "/").trim();
  if (!normalized || normalized === "." || normalized === "/") {
    return "";
  }

  return normalized.replace(/^\/+/, "");
}

export function resolveWorkspacePath(rootDir, inputPath = "") {
  const relativePath = normalizeWorkspaceRelativePath(inputPath);
  const absolutePath = path.resolve(rootDir, relativePath);
  const rootWithSeparator = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;

  if (absolutePath !== rootDir && !absolutePath.startsWith(rootWithSeparator)) {
    const error = new Error("路径超出工作区范围");
    error.statusCode = 400;
    throw error;
  }

  return {
    absolutePath,
    relativePath
  };
}

export async function readWorkspaceDirectory(rootDir, inputPath = "") {
  const { absolutePath, relativePath } = resolveWorkspacePath(rootDir, inputPath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  return entries
    .filter((entry) => {
      if (entry.isDirectory()) {
        return !IGNORED_DIR_NAMES.has(entry.name);
      }
      return true;
    })
    .map((entry) => {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      return {
        name: entry.name,
        path: childRelativePath,
        type: entry.isDirectory() ? "directory" : "file"
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-CN");
    });
}
