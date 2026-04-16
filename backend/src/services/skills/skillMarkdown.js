import YAML from "yaml";

function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function trimTrailingWhitespace(text) {
  return String(text ?? "").replace(/[ \t]+$/gm, "");
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseYamlObject(rawContent) {
  try {
    const parsed = YAML.parse(String(rawContent ?? ""));
    return toPlainObject(parsed);
  } catch {
    return {};
  }
}

export function extractFrontmatterAndBody(rawContent) {
  const normalized = trimTrailingWhitespace(normalizeLineEndings(rawContent));

  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return {
      hasFrontmatter: false,
      frontmatterText: "",
      body: normalized
    };
  }

  const frontmatterText = String(match[1] ?? "");
  const body = normalized.slice(String(match[0] ?? "").length);

  return {
    hasFrontmatter: true,
    frontmatterText,
    body
  };
}

export function parseFrontmatter(frontmatterText) {
  return parseYamlObject(frontmatterText);
}

export function parseSkillMarkdown(rawContent) {
  const extracted = extractFrontmatterAndBody(rawContent);
  const frontmatter = extracted.hasFrontmatter ? parseFrontmatter(extracted.frontmatterText) : {};

  return {
    frontmatter,
    body: extracted.body,
    hasFrontmatter: extracted.hasFrontmatter
  };
}

function normalizeBoolean(value, defaultValue = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return defaultValue;
}

export function parseOpenAiYaml(rawContent) {
  const parsed = parseYamlObject(rawContent);
  const ui = toPlainObject(parsed.interface);
  const policy = toPlainObject(parsed.policy);

  return {
    displayName: String(
      ui.display_name ??
        ui.displayName ??
        parsed.display_name ??
        parsed.displayName ??
        ""
    ).trim(),
    shortDescription: String(
      ui.short_description ??
        ui.shortDescription ??
        parsed.short_description ??
        parsed.shortDescription ??
        ""
    ).trim(),
    defaultPrompt: String(
      ui.default_prompt ??
        ui.defaultPrompt ??
        parsed.default_prompt ??
        parsed.defaultPrompt ??
        ""
    ).trim(),
    iconSmall: String(ui.icon_small ?? ui.iconSmall ?? parsed.icon_small ?? parsed.iconSmall ?? "").trim(),
    iconLarge: String(ui.icon_large ?? ui.iconLarge ?? parsed.icon_large ?? parsed.iconLarge ?? "").trim(),
    brandColor: String(
      ui.brand_color ?? ui.brandColor ?? parsed.brand_color ?? parsed.brandColor ?? ""
    ).trim(),
    allowImplicitInvocation: normalizeBoolean(
      policy.allow_implicit_invocation ??
        policy.allowImplicitInvocation ??
        parsed.allow_implicit_invocation ??
        parsed.allowImplicitInvocation,
      true
    ),
    raw: parsed
  };
}
