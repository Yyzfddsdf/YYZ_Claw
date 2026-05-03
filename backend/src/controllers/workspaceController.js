import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config/paths.js";
import {
  readWorkspaceDirectory,
  resolveWorkspacePath,
  resolveWorkspaceRoot
} from "../services/workspace/workspacePath.js";

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

function toPublicWorkspaceRoot(rootDir = PROJECT_ROOT) {
  return String(rootDir ?? PROJECT_ROOT).replace(/\\/g, "/");
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
