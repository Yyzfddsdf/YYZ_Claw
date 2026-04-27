import fs from "node:fs/promises";
import path from "node:path";

import { parseOpenAiYaml, parseSkillMarkdown } from "./skillMarkdown.js";

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function safeRelativePath(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).replace(/\\/g, "/");
}

function isPathInside(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeCatalogKey(scope, relativePath) {
  return normalizeName(`${scope}:${String(relativePath ?? "").trim()}`);
}

async function readFileStats(filePath) {
  const stats = await fs.stat(filePath);
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs)
  };
}

async function collectSkillRoots(rootDir) {
  const roots = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");

    if (hasSkillFile) {
      roots.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name.startsWith(".") && entry.name !== "_system") {
        continue;
      }

      await walk(path.join(currentDir, entry.name));
    }
  }

  if (await fileExists(rootDir)) {
    await walk(rootDir);
  }

  return roots.sort((left, right) => left.localeCompare(right));
}

async function collectBundleFiles(skillRootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }

  for (const folderName of ["references", "scripts", "assets", "agents"]) {
    const folderPath = path.join(skillRootDir, folderName);
    if (await fileExists(folderPath)) {
      await walk(folderPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export class SkillCatalog {
  constructor(options) {
    this.rootDir = path.resolve(String(options.rootDir ?? ""));
    this.snapshotFile = path.resolve(String(options.snapshotFile ?? ""));
    this.cacheByKey = new Map();
  }

  async ensureDirectory() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async resolveCatalogRoots(options = {}) {
    const roots = [];
    const includeGlobal = options.includeGlobal !== false;
    const includeProject = options.includeProject !== false;
    const workspacePath = String(options.workspacePath ?? "").trim();

    if (includeGlobal) {
      roots.push({ scope: "global", rootDir: this.rootDir });
    }

    if (includeProject && workspacePath) {
      const projectRootDir = path.join(path.resolve(workspacePath), ".yyz", "skills");
      if (path.resolve(projectRootDir) !== path.resolve(this.rootDir)) {
        roots.push({ scope: "project", rootDir: projectRootDir });
      }
    }

    const seen = new Set();
    return roots.filter((item) => {
      const key = path.resolve(item.rootDir);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  buildCatalogKey(rootEntries) {
    return rootEntries.map((item) => `${item.scope}:${path.resolve(item.rootDir)}`).join("|");
  }

  async collectFingerprintForRoots(rootEntries) {
    const fingerprint = [];

    for (const rootEntry of rootEntries) {
      if (!(await fileExists(rootEntry.rootDir))) {
        continue;
      }

      const skillRoots = await collectSkillRoots(rootEntry.rootDir);

      for (const skillRootDir of skillRoots) {
        const skillFilePath = path.join(skillRootDir, "SKILL.md");
        const agentFilePath = path.join(skillRootDir, "agents", "openai.yaml");
        const stats = await readFileStats(skillFilePath);
        const agentStats = (await fileExists(agentFilePath)) ? await readFileStats(agentFilePath) : null;

        fingerprint.push({
          scope: rootEntry.scope,
          rootDir: path.resolve(rootEntry.rootDir),
          relativePath: safeRelativePath(rootEntry.rootDir, skillRootDir),
          skillFilePath: safeRelativePath(rootEntry.rootDir, skillFilePath),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          agentFilePath: agentStats ? safeRelativePath(rootEntry.rootDir, agentFilePath) : "",
          agentSize: agentStats ? agentStats.size : 0,
          agentMtimeMs: agentStats ? agentStats.mtimeMs : 0
        });
      }
    }

    fingerprint.sort((left, right) =>
      `${left.scope}:${left.rootDir}:${left.relativePath}`.localeCompare(
        `${right.scope}:${right.rootDir}:${right.relativePath}`
      )
    );

    return fingerprint;
  }

  async ensureSeedSkills() {
    await this.ensureDirectory();

    const creatorRoot = path.join(this.rootDir, "_system", "skills_creator");
    const skillFilePath = path.join(creatorRoot, "SKILL.md");
    const agentFilePath = path.join(creatorRoot, "agents", "openai.yaml");
    const referenceFilePath = path.join(creatorRoot, "references", "openai_yaml.md");
    const initScriptPath = path.join(creatorRoot, "scripts", "init_skill.py");
    const generateScriptPath = path.join(creatorRoot, "scripts", "generate_openai_yaml.py");
    const validateScriptPath = path.join(creatorRoot, "scripts", "quick_validate.py");

    await fs.mkdir(path.dirname(skillFilePath), { recursive: true });
    await fs.mkdir(path.dirname(agentFilePath), { recursive: true });
    await fs.mkdir(path.dirname(referenceFilePath), { recursive: true });
    await fs.mkdir(path.dirname(initScriptPath), { recursive: true });

    if (!(await fileExists(skillFilePath))) {
      await fs.writeFile(
        skillFilePath,
        [
          "---",
          "name: skills_creator",
          "description: Guide for creating effective skills. Use when creating or updating a skill that extends Codex with specialized knowledge, workflows, or tool integrations.",
          "---",
          "",
          "# Skills Creator",
          "",
          "This skill provides guidance for creating, updating, and validating effective skills.",
          "",
          "## About Skills",
          "",
          "Skills are modular, self-contained folders that extend Codex's capabilities by providing specialized knowledge, workflows, and tools.",
          "",
          "## Core Principles",
          "",
          "- Concise is key.",
          "- Prefer low context overhead.",
          "- Keep references in bundled files.",
          "",
          "## Skill Files",
          "",
          "- `SKILL.md` is the authoritative skill definition.",
          "- `agents/openai.yaml` is optional UI metadata and invocation guidance.",
          "- If `agents/openai.yaml` exists, use it.",
          "- If it does not exist, fall back to `SKILL.md` frontmatter and folder defaults.",
          "",
          "## Bundled Resources",
          "",
          "- `scripts/` for deterministic steps",
          "- `references/` for detailed docs",
          "- `assets/` for output files",
          "",
          "## Use the Bundled Scripts",
          "",
          "- `scripts/init_skill.py` scaffolds a standard skill folder.",
          "- `scripts/generate_openai_yaml.py` regenerates optional `agents/openai.yaml`.",
          "- `scripts/quick_validate.py` checks the core skill contract without requiring `agents/openai.yaml`."
        ].join("\n"),
        "utf8"
      );
    }

    if (!(await fileExists(agentFilePath))) {
      await fs.writeFile(
        agentFilePath,
        [
          "interface:",
          '  display_name: "Skills Creator"',
          '  short_description: "Create and update standard skills"',
          '  default_prompt: "Use $skills_creator to scaffold, validate, or update a skill. Generate openai.yaml only when UI metadata is needed."',
          "policy:",
          "  allow_implicit_invocation: true",
          ""
        ].join("\n"),
        "utf8"
      );
    }

    if (!(await fileExists(referenceFilePath))) {
      await fs.writeFile(
        referenceFilePath,
        `# openai.yaml\n\n\`agents/openai.yaml\` stores UI metadata for a skill.\n\n## Fields\n\n- \`interface.display_name\`: user-facing name shown in skill lists\n- \`interface.short_description\`: short UI blurb\n- \`interface.default_prompt\`: example prompt that explicitly names the skill\n- \`interface.icon_small\`: optional icon path\n- \`interface.icon_large\`: optional larger icon path\n- \`interface.brand_color\`: optional accent color\n- \`policy.allow_implicit_invocation\`: whether the skill can be auto-injected\n\n## Rules\n\n- Quote string values.\n- Keep keys unquoted.\n- Keep the prompt short and action-oriented.\n- Use paths relative to the skill folder.\n\n## Example\n\n\`\`\`yaml\ninterface:\n  display_name: \"PDF Processing\"\n  short_description: \"Extract, edit, and generate PDFs\"\n  default_prompt: \"Use $pdf-processing to inspect and edit a PDF.\"\npolicy:\n  allow_implicit_invocation: true\n\`\`\`\n`,
        `# openai.yaml\n\n\`agents/openai.yaml\` stores optional UI metadata for a skill.\n\nIt is an overlay, not the source of truth. If it exists, use it. If it does not exist, fall back to \`SKILL.md\` frontmatter and folder defaults.\n\n## Fields\n\n- \`interface.display_name\`: user-facing name shown in skill lists\n- \`interface.short_description\`: short UI blurb\n- \`interface.default_prompt\`: example prompt that explicitly names the skill\n- \`interface.icon_small\`: optional icon path\n- \`interface.icon_large\`: optional larger icon path\n- \`interface.brand_color\`: optional accent color\n- \`policy.allow_implicit_invocation\`: whether the skill can be auto-injected\n\n## Rules\n\n- Quote string values.\n- Keep keys unquoted.\n- Keep the prompt short and action-oriented.\n- Use paths relative to the skill folder.\n- Keep the file small and metadata-only.\n\n## Example\n\n\`\`\`yaml\ninterface:\n  display_name: \"PDF Processing\"\n  short_description: \"Extract, edit, and generate PDFs\"\n  default_prompt: \"Use $pdf-processing to inspect and edit a PDF.\"\npolicy:\n  allow_implicit_invocation: true\n\`\`\`\n`,
        "utf8"
      );
    }

    await fs.mkdir(path.dirname(initScriptPath), { recursive: true });
  }

  normalizeSkillRecord(scope, catalogRootDir, skillRootDir, parsed, stats) {
    const relativePath = safeRelativePath(catalogRootDir, skillRootDir);
    const pathSegments = relativePath.split("/").filter(Boolean);
    const category = pathSegments.length > 1 ? pathSegments.slice(0, -1).join("/") : "";
    const rawFrontmatter = toPlainObject(parsed.frontmatter);
    const metadata = toPlainObject(rawFrontmatter.metadata);
    const hermes = toPlainObject(metadata.hermes);
    const name =
      String(rawFrontmatter.name ?? "").trim() ||
      pathSegments.at(-1) ||
      path.basename(skillRootDir);
    const description = String(rawFrontmatter.description ?? "").trim();
    const version = String(rawFrontmatter.version ?? "").trim() || "1.0.0";
    const author = String(rawFrontmatter.author ?? "").trim();
    const license = String(rawFrontmatter.license ?? "").trim();
    const platforms = toStringArray(rawFrontmatter.platforms);
    const requiredEnvironmentVariables = toStringArray(
      rawFrontmatter.required_environment_variables
    );
    const prerequisites = toStringArray(rawFrontmatter.prerequisites);
    const relatedSkills = toStringArray(hermes.related_skills);
    const requiresTools = toStringArray(hermes.requires_tools);
    const requiresToolsets = toStringArray(hermes.requires_toolsets);
    const fallbackForTools = toStringArray(hermes.fallback_for_tools);
    const fallbackForToolsets = toStringArray(hermes.fallback_for_toolsets);
    const enabled = hermes.enabled !== false;
    const hidden = Boolean(hermes.hidden);
    const label = String(hermes.label ?? "").trim();
    const isSystem = pathSegments[0] === "_system" || scope === "system";
    const displayName = String(parsed.ui?.displayName ?? "").trim();
    const shortDescription = String(parsed.ui?.shortDescription ?? "").trim();
    const defaultPrompt = String(parsed.ui?.defaultPrompt ?? "").trim();
    const iconSmall = String(parsed.ui?.iconSmall ?? "").trim();
    const iconLarge = String(parsed.ui?.iconLarge ?? "").trim();
    const brandColor = String(parsed.ui?.brandColor ?? "").trim();
    const allowImplicitInvocation = parsed.ui?.allowImplicitInvocation !== false;
    const skillKey = `${scope}:${relativePath}`;

    return {
      scope,
      skillKey,
      normalizedSkillKey: normalizeCatalogKey(scope, relativePath),
      name,
      normalizedName: normalizeName(name),
      normalizedRelativePath: normalizeName(relativePath),
      displayName: displayName || name,
      shortDescription: shortDescription || description,
      defaultPrompt,
      iconSmall,
      iconLarge,
      brandColor,
      allowImplicitInvocation,
      description,
      version,
      author,
      license,
      platforms,
      requiredEnvironmentVariables,
      prerequisites,
      metadata: rawFrontmatter.metadata ?? {},
      hermes: {
        label,
        enabled,
        hidden,
        relatedSkills,
        requiresTools,
        requiresToolsets,
        fallbackForTools,
        fallbackForToolsets
      },
      rootDir: skillRootDir,
      catalogRootDir,
      skillFilePath: path.join(skillRootDir, "SKILL.md"),
      relativePath,
      category,
      isSystem,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      bodyLength: String(parsed.body ?? "").trim().length
    };
  }

  async discoverSkills(options = {}) {
    await this.ensureSeedSkills();

    const rootEntries = await this.resolveCatalogRoots(options);
    const cacheKey = this.buildCatalogKey(rootEntries);
    const fingerprint = await this.collectFingerprintForRoots(rootEntries);
    const cached = this.cacheByKey.get(cacheKey);

    if (
      cached &&
      Array.isArray(cached.fingerprint) &&
      JSON.stringify(cached.fingerprint) === JSON.stringify(fingerprint)
    ) {
      return cached;
    }

    const skills = [];

    for (const rootEntry of rootEntries) {
      if (!(await fileExists(rootEntry.rootDir))) {
        continue;
      }

      const skillRoots = await collectSkillRoots(rootEntry.rootDir);

      for (const skillRootDir of skillRoots) {
        const skillFilePath = path.join(skillRootDir, "SKILL.md");
        const stats = await readFileStats(skillFilePath);
        const rawContent = await fs.readFile(skillFilePath, "utf8");
        const parsed = parseSkillMarkdown(rawContent);
        const agentPath = path.join(skillRootDir, "agents", "openai.yaml");
        const ui = (await fileExists(agentPath))
          ? parseOpenAiYaml(await fs.readFile(agentPath, "utf8"))
          : null;
        skills.push(
          this.normalizeSkillRecord(rootEntry.scope, rootEntry.rootDir, skillRootDir, { ...parsed, ui }, stats)
        );
      }
    }

    const scopeOrder = { project: 0, global: 1, system: 2 };
    skills.sort((left, right) => {
      const scopeComparison = (scopeOrder[left.scope] ?? 99) - (scopeOrder[right.scope] ?? 99);
      if (scopeComparison !== 0) {
        return scopeComparison;
      }

      const categoryComparison = left.category.localeCompare(right.category);
      if (categoryComparison !== 0) {
        return categoryComparison;
      }

      const nameComparison = left.name.localeCompare(right.name);
      if (nameComparison !== 0) {
        return nameComparison;
      }

      return left.relativePath.localeCompare(right.relativePath);
    });

    const skillMap = new Map();
    for (const skill of skills) {
      if (!skillMap.has(skill.normalizedSkillKey)) {
        skillMap.set(skill.normalizedSkillKey, skill);
      }
    }

    const catalog = {
      generatedAt: Date.now(),
      fingerprint,
      skills,
      skillMap,
      rootEntries
    };

    this.cacheByKey.set(cacheKey, catalog);
    return catalog;
  }

  async read(options = {}) {
    return this.discoverSkills(options);
  }

  async refresh(options = {}) {
    const rootEntries = await this.resolveCatalogRoots(options);
    const cacheKey = this.buildCatalogKey(rootEntries);
    this.cacheByKey.delete(cacheKey);
    return this.read(options);
  }

  matchesSelectedIdentifiers(skill, selectedNames) {
    if (!(selectedNames instanceof Set) || selectedNames.size === 0) {
      return false;
    }

    const candidates = [
      skill.skillKey,
      skill.relativePath,
      skill.name,
      path.basename(skill.rootDir),
      `${skill.scope}:${skill.relativePath}`
    ];

    return candidates.some((item) => selectedNames.has(normalizeName(item)));
  }

  async listSkills(options = {}) {
    const catalog = await this.read(options);
    const query = String(options.query ?? "").trim().toLowerCase();
    const category = String(options.category ?? "").trim();
    const includeSystem = options.includeSystem !== false;
    const includeGlobal = options.includeGlobal !== false;
    const includeProject = options.includeProject !== false;
    const selectedNames = new Set(
      toStringArray(options.selectedSkillNames).map((item) => normalizeName(item))
    );

    return catalog.skills
      .filter((skill) => includeGlobal || skill.scope !== "global")
      .filter((skill) => includeProject || skill.scope !== "project")
      .filter((skill) => includeSystem || !skill.isSystem)
      .filter((skill) => {
        if (!category) {
          return true;
        }

        return skill.category === category || skill.relativePath.startsWith(`${category}/`);
      })
      .filter((skill) => {
        if (!query) {
          return true;
        }

        const haystack = [
          skill.name,
          skill.description,
          skill.category,
          skill.relativePath,
          skill.skillKey,
          ...(skill.platforms || []),
          ...(skill.prerequisites || [])
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(query);
      })
      .map((skill) => ({
        scope: skill.scope,
        skillKey: skill.skillKey,
        name: skill.name,
        displayName: skill.displayName,
        shortDescription: skill.shortDescription,
        defaultPrompt: skill.defaultPrompt,
        iconSmall: skill.iconSmall,
        iconLarge: skill.iconLarge,
        brandColor: skill.brandColor,
        allowImplicitInvocation: skill.allowImplicitInvocation !== false,
        description: skill.description,
        version: skill.version,
        author: skill.author,
        license: skill.license,
        category: skill.category,
        relativePath: skill.relativePath,
        isSystem: skill.isSystem,
        enabled: skill.hermes.enabled !== false,
        hidden: Boolean(skill.hermes.hidden),
        selected: this.matchesSelectedIdentifiers(skill, selectedNames)
      }));
  }

  async findSkill(identifier, options = {}) {
    const catalog = await this.read(options);
    const normalizedIdentifier = normalizeName(identifier);

    if (!normalizedIdentifier) {
      return null;
    }

    const exact = catalog.skills.find(
      (skill) =>
        skill.normalizedSkillKey === normalizedIdentifier ||
        skill.normalizedName === normalizedIdentifier ||
        skill.normalizedRelativePath === normalizedIdentifier ||
        normalizeName(path.basename(skill.rootDir)) === normalizedIdentifier
    );

    if (exact) {
      return exact;
    }

    return (
      catalog.skills.find(
        (skill) =>
          normalizeName(skill.relativePath) === normalizedIdentifier ||
          normalizeName(`${skill.scope}:${skill.relativePath}`) === normalizedIdentifier ||
          normalizeName(`${skill.scope}/${skill.relativePath}`) === normalizedIdentifier ||
          normalizeName(path.basename(skill.rootDir)) === normalizedIdentifier
      ) ?? null
    );
  }

  async listBundleFiles(identifier, options = {}) {
    const skill = await this.findSkill(identifier, options);
    if (!skill) {
      return [];
    }

    return collectBundleFiles(skill.rootDir);
  }

  async getSkillContent(identifier, filePath = "SKILL.md", options = {}) {
    const skill = await this.findSkill(identifier, options);
    if (!skill) {
      return null;
    }

    const normalizedFilePath = String(filePath ?? "").trim() || "SKILL.md";
    const resolvedPath = path.resolve(skill.rootDir, normalizedFilePath);

    if (!resolvedPath.startsWith(path.resolve(skill.rootDir))) {
      throw new Error("filePath escapes skill root");
    }

    const content = await fs.readFile(resolvedPath, "utf8");
    return {
      skill,
      filePath: safeRelativePath(skill.rootDir, resolvedPath),
      content
    };
  }

  async getSkillAsset(identifier, filePath = "", options = {}) {
    const skill = await this.findSkill(identifier, options);
    if (!skill) {
      return null;
    }

    const normalizedFilePath = String(filePath ?? "").trim();
    if (!normalizedFilePath) {
      throw new Error("filePath is required");
    }

    const extension = path.extname(normalizedFilePath).toLowerCase();
    const mimeType =
      extension === ".svg"
        ? "image/svg+xml; charset=utf-8"
        : extension === ".png"
          ? "image/png"
          : "";
    if (!mimeType) {
      throw new Error("only svg and png skill assets are allowed");
    }

    const resolvedPath = path.resolve(skill.rootDir, normalizedFilePath);
    if (!isPathInside(skill.rootDir, resolvedPath)) {
      throw new Error("filePath escapes skill root");
    }

    const content = await fs.readFile(resolvedPath);
    return {
      skill,
      filePath: safeRelativePath(skill.rootDir, resolvedPath),
      content,
      mimeType
    };
  }

  async validateSkill(identifier, options = {}) {
    const skill = await this.findSkill(identifier, options);
    if (!skill) {
      return {
        valid: false,
        errors: ["skill not found"],
        warnings: []
      };
    }

    const errors = [];
    const warnings = [];
    const exists = await fileExists(skill.skillFilePath);
    const agentFile = path.join(skill.rootDir, "agents", "openai.yaml");

    if (!exists) {
      errors.push("SKILL.md is missing");
    }

    if (!skill.name) {
      errors.push("frontmatter.name is required");
    }

    if (!skill.description) {
      errors.push("frontmatter.description is required");
    }

    if (skill.bodyLength === 0) {
      warnings.push("skill body is empty");
    }

    if (!(await fileExists(agentFile))) {
      warnings.push("agents/openai.yaml is missing");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      skill: {
        name: skill.name,
        relativePath: skill.relativePath,
        category: skill.category,
        isSystem: skill.isSystem
      }
    };
  }
}
