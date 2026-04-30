import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config/paths.js";
import { readWorkspaceDirectory, resolveWorkspacePath } from "../services/workspace/workspacePath.js";

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

function toPublicWorkspaceRoot() {
  return PROJECT_ROOT.replace(/\\/g, "/");
}

export function createWorkspaceController() {
  return {
    async getWorkspaceInfo(_req, res) {
      res.json({
        root: toPublicWorkspaceRoot()
      });
    },

    async listTree(req, res) {
      const entries = await readWorkspaceDirectory(PROJECT_ROOT, req.query.path ?? "");
      res.json({
        root: toPublicWorkspaceRoot(),
        entries
      });
    },

    async readFile(req, res) {
      const { absolutePath, relativePath } = resolveWorkspacePath(PROJECT_ROOT, req.query.path ?? "");
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

    async writeFile(req, res) {
      const targetPath = String(req.body?.path ?? "").trim();
      const content = String(req.body?.content ?? "");

      if (!targetPath) {
        const error = new Error("缺少文件路径");
        error.statusCode = 400;
        throw error;
      }

      const { absolutePath, relativePath } = resolveWorkspacePath(PROJECT_ROOT, targetPath);
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
