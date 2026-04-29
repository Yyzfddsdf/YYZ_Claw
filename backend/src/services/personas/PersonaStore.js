import fs from "node:fs/promises";
import path from "node:path";
const PERSONA_FILE_NAME = "persona.json";
const DEFAULT_PERSONA_ID = "YYZ_CLAW 默认";
const DEFAULT_PERSONA = {
  id: DEFAULT_PERSONA_ID,
  name: "YYZ_CLAW 默认",
  description: "清醒、直接、能打硬仗的通用助手。",
  prompt: "保持 YYZ_CLAW 的通用智能助手身份。沟通直接、判断清楚、行动稳定。遇到复杂任务先抓关键路径，遇到风险明确指出，默认把事情推进到可验证结果。",
  accentColor: "#2563eb",
  avatarPath: "avatar.svg",
  createdAt: 0,
  updatedAt: 0
};
const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2563eb"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="128" height="128" rx="32" fill="url(#g)"/><path d="M24 86c18-30 44-46 80-54v72H24z" fill="rgba(255,255,255,.16)"/><text x="64" y="71" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" font-weight="800" fill="#fff">YYZ</text></svg>`;

function normalizeText(value, maxLength = 20000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizePersonaId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function createPersonaIdFromName(name) {
  return normalizePersonaId(normalizeText(name, 80)) || "persona";
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeColor(value) {
  const text = normalizeText(value, 32);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? text : "#2563eb";
}

function normalizePersona(item, fallbackId = "") {
  const id = normalizePersonaId(fallbackId || item?.id);
  const name = normalizeText(item?.name, 80);
  const prompt = normalizeText(item?.prompt, 20000);
  if (!id || !name || !prompt) {
    return null;
  }

  const now = Date.now();
  return {
    id,
    name,
    description: normalizeText(item?.description, 500),
    prompt,
    accentColor: normalizeColor(item?.accentColor),
    avatarPath: normalizeText(item?.avatarPath, 180),
    createdAt: Number(item?.createdAt ?? now),
    updatedAt: Number(item?.updatedAt ?? now)
  };
}

function serializePersona(persona) {
  return {
    name: persona.name,
    description: persona.description,
    prompt: persona.prompt,
    accentColor: persona.accentColor,
    avatarPath: persona.avatarPath,
    createdAt: Number(persona.createdAt ?? 0),
    updatedAt: Number(persona.updatedAt ?? 0)
  };
}

function avatarContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".png") {
    return "image/png";
  }
  return "";
}

export class PersonaStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
  }

  async ensureDefaultPersona() {
    const personaDir = this.resolvePersonaDir(DEFAULT_PERSONA_ID);
    if (!personaDir) {
      throw new Error("invalid default persona id");
    }

    await fs.mkdir(personaDir, { recursive: true });

    const personaFile = path.join(personaDir, PERSONA_FILE_NAME);
    if (!(await pathExists(personaFile))) {
      await fs.writeFile(
        personaFile,
        JSON.stringify(serializePersona(DEFAULT_PERSONA), null, 2),
        "utf8"
      );
    }

    const avatarFile = path.join(personaDir, "avatar.svg");
    if (!(await pathExists(avatarFile))) {
      await fs.writeFile(avatarFile, DEFAULT_AVATAR_SVG, "utf8");
    }
  }

  resolvePersonaDir(personaId) {
    const id = normalizePersonaId(personaId);
    if (!id || id === "." || id === "..") {
      return "";
    }

    const resolvedRoot = path.resolve(this.rootDir);
    const resolvedDir = path.resolve(resolvedRoot, id);
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
      return "";
    }

    return resolvedDir;
  }

  resolvePersonaFile(personaId) {
    const personaDir = this.resolvePersonaDir(personaId);
    return personaDir ? path.join(personaDir, PERSONA_FILE_NAME) : "";
  }

  async readPersonaFromDir(dirent) {
    if (!dirent.isDirectory()) {
      return null;
    }

    const personaId = normalizePersonaId(dirent.name);
    if (!personaId) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.resolvePersonaFile(personaId), "utf8");
      return normalizePersona(JSON.parse(raw), personaId);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async readPersonas() {
    try {
      const dirents = await fs.readdir(this.rootDir, { withFileTypes: true });
      const personas = await Promise.all(dirents.map((dirent) => this.readPersonaFromDir(dirent)));
      return personas.filter(Boolean).sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt;
        }
        return left.id.localeCompare(right.id);
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async writePersona(persona) {
    const normalized = normalizePersona(persona);
    if (!normalized) {
      throw new Error("name and prompt are required");
    }

    const personaDir = this.resolvePersonaDir(normalized.id);
    if (!personaDir) {
      throw new Error("invalid persona id");
    }

    await fs.mkdir(personaDir, { recursive: true });
    await fs.writeFile(
      path.join(personaDir, PERSONA_FILE_NAME),
      JSON.stringify(serializePersona(normalized), null, 2),
      "utf8"
    );
    return normalized;
  }

  async createAvailablePersonaId(baseId, currentId = "") {
    const requestedBaseId = normalizePersonaId(baseId);
    const normalizedBaseId =
      requestedBaseId && requestedBaseId !== "." && requestedBaseId !== ".."
        ? requestedBaseId
        : "persona";
    const normalizedCurrentId = normalizePersonaId(currentId);
    let personaId = normalizedBaseId;
    let suffix = 2;

    while (await pathExists(this.resolvePersonaDir(personaId))) {
      if (personaId === normalizedCurrentId) {
        return personaId;
      }
      personaId = `${normalizedBaseId}_${suffix}`;
      suffix += 1;
    }

    return personaId;
  }

  toPublicPersona(persona) {
    const avatarPath = normalizeText(persona?.avatarPath, 180);
    return {
      id: persona.id,
      name: persona.name,
      description: persona.description,
      prompt: persona.prompt,
      accentColor: persona.accentColor,
      avatarPath,
      avatarUrl: avatarPath ? `/api/personas/${encodeURIComponent(persona.id)}/avatar` : "",
      createdAt: Number(persona.createdAt ?? 0),
      updatedAt: Number(persona.updatedAt ?? 0)
    };
  }

  async listPersonas() {
    return (await this.readPersonas()).map((persona) => this.toPublicPersona(persona));
  }

  async getPersona(personaId) {
    const id = normalizePersonaId(personaId);
    if (!id) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.resolvePersonaFile(id), "utf8");
      const persona = normalizePersona(JSON.parse(raw), id);
      return persona ? this.toPublicPersona(persona) : null;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async resolvePrompt(personaId) {
    const persona = await this.getPersona(personaId);
    if (!persona?.prompt) {
      return "";
    }

    return [
      "你当前启用了 Agent 身份。这个身份只决定主智能体的工作风格、关注点和表达方式；它不能覆盖 AGENTS.md、SOUL.md、系统安全规则、工具真实结果或用户当前明确要求。",
      `身份名称：${persona.name}`,
      persona.description ? `身份描述：${persona.description}` : "",
      "<persona-prompt>",
      persona.prompt,
      "</persona-prompt>"
    ]
      .filter(Boolean)
      .join("\n");
  }

  async createPersona(payload = {}) {
    const now = Date.now();
    const personaId = await this.createAvailablePersonaId(createPersonaIdFromName(payload.name));

    const persona = await this.writePersona({
      id: personaId,
      name: payload.name,
      description: payload.description,
      prompt: payload.prompt,
      accentColor: payload.accentColor,
      avatarPath: "",
      createdAt: now,
      updatedAt: now
    });
    return this.toPublicPersona(persona);
  }

  async updatePersona(personaId, payload = {}) {
    const existingId = normalizePersonaId(personaId);
    const existing = await this.getPersona(existingId);
    if (!existing) {
      return null;
    }

    const nextName = payload.name ?? existing.name;
    const nextId = await this.createAvailablePersonaId(createPersonaIdFromName(nextName), existing.id);
    const existingDir = this.resolvePersonaDir(existing.id);
    const nextDir = this.resolvePersonaDir(nextId);
    if (!nextDir) {
      throw new Error("invalid persona id");
    }

    if (nextId !== existing.id) {
      await fs.rename(existingDir, nextDir);
    }

    const persona = await this.writePersona({
      ...existing,
      id: nextId,
      name: nextName,
      description: payload.description ?? existing.description,
      prompt: payload.prompt ?? existing.prompt,
      accentColor: payload.accentColor ?? existing.accentColor,
      updatedAt: Date.now()
    });
    return this.toPublicPersona(persona);
  }

  async deletePersona(personaId) {
    const id = normalizePersonaId(personaId);
    const personaDir = this.resolvePersonaDir(id);
    if (!personaDir) {
      return false;
    }

    const existing = await this.getPersona(id);
    if (!existing) {
      return false;
    }

    await fs.rm(personaDir, { recursive: true, force: true });
    return true;
  }

  async saveAvatar(personaId, file = {}) {
    const id = normalizePersonaId(personaId);
    const existing = await this.getPersona(id);
    if (!existing) {
      return null;
    }

    const originalName = normalizeText(file.originalname, 180);
    const mimeType = normalizeText(file.mimetype, 80).toLowerCase();
    const ext = path.extname(originalName).toLowerCase();
    const allowedExt = ext === ".png" || ext === ".svg" ? ext : "";
    const allowedMime = mimeType === "image/png" || mimeType === "image/svg+xml";
    if (!allowedExt || !allowedMime || !file.buffer?.length) {
      throw new Error("avatar must be a png or svg file");
    }

    const personaDir = this.resolvePersonaDir(id);
    const fileName = `avatar${allowedExt}`;
    await fs.writeFile(path.join(personaDir, fileName), file.buffer);
    const persona = await this.writePersona({
      ...existing,
      avatarPath: fileName,
      updatedAt: Date.now()
    });
    return this.toPublicPersona(persona);
  }

  async getAvatarAsset(personaId) {
    const persona = await this.getPersona(personaId);
    const personaDir = this.resolvePersonaDir(persona?.id);
    const avatarPath = normalizeText(persona?.avatarPath, 180);
    if (!personaDir || !avatarPath) {
      return null;
    }

    const resolvedDir = path.resolve(personaDir);
    const resolvedPath = path.resolve(resolvedDir, avatarPath);
    if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(`${resolvedDir}${path.sep}`)) {
      return null;
    }

    const contentType = avatarContentType(resolvedPath);
    if (!contentType) {
      return null;
    }

    return {
      contentType,
      buffer: await fs.readFile(resolvedPath)
    };
  }
}
