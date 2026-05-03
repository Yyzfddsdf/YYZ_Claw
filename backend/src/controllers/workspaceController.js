import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config/paths.js";
import {
  readWorkspaceDirectory,
  resolveWorkspacePath,
  resolveWorkspaceRoot
} from "../services/workspace/workspacePath.js";

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_SEARCH_RESULTS = 40;
const SEARCH_IGNORED_DIR_NAMES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "release"
]);

function toPublicWorkspaceRoot(rootDir = PROJECT_ROOT) {
  return String(rootDir ?? PROJECT_ROOT).replace(/\\/g, "/");
}

function fuzzyIncludes(value, query) {
  const target = String(value ?? "").toLowerCase();
  const needle = String(query ?? "").toLowerCase();
  return Boolean(needle) && target.includes(needle);
}

async function searchWorkspaceFiles(rootDir, query) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    return [];
  }

  const results = [];
  async function walk(relativeDir = "") {
    if (results.length >= MAX_WORKSPACE_SEARCH_RESULTS) {
      return;
    }

    const { absolutePath } = resolveWorkspacePath(rootDir, relativeDir);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_WORKSPACE_SEARCH_RESULTS) {
        return;
      }
      if (entry.isDirectory() && SEARCH_IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const childPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childPath);
        continue;
      }

      if (entry.isFile() && fuzzyIncludes(childPath, normalizedQuery)) {
        results.push({
          name: entry.name,
          path: childPath.replace(/\\/g, "/"),
          type: "file"
        });
      }
    }
  }

  await walk("");
  return results;
}

export function createWorkspaceController() {
  return {
    async getWorkspaceInfo(req, res) {
      const rootDir = await resolveWorkspaceRoot(req.query.root ?? "", PROJECT_ROOT);
      res.json({
        root: toPublicWorkspaceRoot(rootDir)
      });
    },

    async listTree(req, res) {
      const rootDir = await resolveWorkspaceRoot(req.query.root ?? "", PROJECT_ROOT);
      const entries = await readWorkspaceDirectory(rootDir, req.query.path ?? "");
      res.json({
        root: toPublicWorkspaceRoot(rootDir),
        entries
      });
    },

    async searchFiles(req, res) {
      const rootDir = await resolveWorkspaceRoot(req.query.root ?? "", PROJECT_ROOT);
      const entries = await searchWorkspaceFiles(rootDir, req.query.query ?? "");
      res.json({
        root: toPublicWorkspaceRoot(rootDir),
        entries
      });
    },

    async readFile(req, res) {
      const rootDir = await resolveWorkspaceRoot(req.query.root ?? "", PROJECT_ROOT);
      const { absolutePath, relativePath } = resolveWorkspacePath(rootDir, req.query.path ?? "");
      const stat = await fs.stat(absolutePath);

      if (!stat.isFile()) {
        const error = new Error("只能读取文件");
        error.statusCode = 400;
        throw error;
      }

      if (stat.size > MAX_EDITABLE_FILE_BYTES) {
        const error = new Error("文件过大，暂不在编辑器中打开");
        error.statusCode = 413;
        throw error;
      }

      const content = await fs.readFile(absolutePath, "utf8");
      res.json({
        path: relativePath,
        name: path.basename(absolutePath),
        content,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    },

    async streamAsset(req, res) {
      const rootDir = await resolveWorkspaceRoot(req.query.root ?? "", PROJECT_ROOT);
      const { absolutePath } = resolveWorkspacePath(rootDir, req.query.path ?? "");
      const stat = await fs.stat(absolutePath);

      if (!stat.isFile()) {
        const error = new Error("只能预览文件");
        error.statusCode = 400;
        throw error;
      }

      res.sendFile(absolutePath);
    },

    async writeFile(req, res) {
      const targetPath = String(req.body?.path ?? "").trim();
      const content = String(req.body?.content ?? "");

      if (!targetPath) {
        const error = new Error("缺少文件路径");
        error.statusCode = 400;
        throw error;
      }

      const rootDir = await resolveWorkspaceRoot(req.body?.root ?? "", PROJECT_ROOT);
      const { absolutePath, relativePath } = resolveWorkspacePath(rootDir, targetPath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      const stat = await fs.stat(absolutePath);

      res.json({
        path: relativePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  };
}
