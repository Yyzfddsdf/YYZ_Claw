import fs from "node:fs/promises";
import path from "node:path";

import { safeJsonParse } from "../../utils/safeJsonParse.js";

const SECTION_NAMES = ["always_review", "confirm_review"];
const SECTION_HEADING_PATTERN = /^##\s+(always_review|confirm_review)\s*$/i;
const GROUP_HEADING_PATTERN = /^###\s+([A-Za-z0-9_-]+)\s*$/;
const BULLET_PATTERN = /^[-*+]\s+(.*)$/;

function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function createEmptySection() {
  return {
    groups: {}
  };
}

function createEmptyParsedRules(rawMarkdown = "") {
  return {
    rawMarkdown,
    always_review: createEmptySection(),
    confirm_review: createEmptySection(),
    toolGroupLookup: new Map(),
    commandRules: []
  };
}

function getOrCreateGroup(section, groupName) {
  const normalizedGroupName = String(groupName ?? "").trim() || "general";
  section.groups[normalizedGroupName] ??= {
    tools: [],
    commandPatterns: [],
    compiledCommandPatterns: []
  };
  return section.groups[normalizedGroupName];
}

function parseRuleEntry(line) {
  const normalized = String(line ?? "").trim();

  if (!normalized) {
    return null;
  }

  const toolMatch = normalized.match(/^tool:\s*(.+)$/i);
  if (toolMatch) {
    return {
      kind: "tool",
      value: String(toolMatch[1] ?? "").trim()
    };
  }

  const commandMatch = normalized.match(/^(command|pattern|regex):\s*(.+)$/i);
  if (commandMatch) {
    return {
      kind: "command",
      value: String(commandMatch[2] ?? "").trim()
    };
  }

  return {
    kind: "tool",
    value: normalized
  };
}

function compileParsedRules(parsedRules) {
  for (const sectionName of SECTION_NAMES) {
    const section = parsedRules[sectionName];

    for (const [groupName, group] of Object.entries(section.groups)) {
      group.compiledCommandPatterns = [];

      for (const pattern of group.commandPatterns) {
        try {
          const regex = new RegExp(pattern, "i");
          group.compiledCommandPatterns.push(regex);
          parsedRules.commandRules.push({
            section: sectionName,
            groupName,
            pattern,
            regex
          });
        } catch {
          continue;
        }
      }
    }
  }
}

function buildToolLookup(parsedRules) {
  for (const sectionName of SECTION_NAMES) {
    const section = parsedRules[sectionName];

    for (const [groupName, group] of Object.entries(section.groups)) {
      for (const toolName of group.tools) {
        const normalizedToolName = String(toolName ?? "").trim();

        if (!normalizedToolName) {
          continue;
        }

        parsedRules.toolGroupLookup.set(normalizedToolName, {
          section: sectionName,
          groupName
        });
      }
    }
  }
}

function parseApprovalRulesMarkdown(markdown) {
  const parsedRules = createEmptyParsedRules(markdown);
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");

  let currentSectionName = "";
  let currentGroupName = "";

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();

    if (!line || line.startsWith("# ")) {
      continue;
    }

    const sectionMatch = line.match(SECTION_HEADING_PATTERN);
    if (sectionMatch) {
      currentSectionName = String(sectionMatch[1]).toLowerCase();
      currentGroupName = "";
      continue;
    }

    const groupMatch = line.match(GROUP_HEADING_PATTERN);
    if (groupMatch) {
      currentGroupName = String(groupMatch[1]).trim();
      continue;
    }

    const bulletMatch = line.match(BULLET_PATTERN);
    if (!bulletMatch || !currentSectionName) {
      continue;
    }

    const section = parsedRules[currentSectionName];
    const group = getOrCreateGroup(section, currentGroupName);
    const entry = parseRuleEntry(bulletMatch[1]);

    if (!entry) {
      continue;
    }

    if (entry.kind === "command") {
      group.commandPatterns.push(entry.value);
      continue;
    }

    group.tools.push(entry.value);
  }

  compileParsedRules(parsedRules);
  buildToolLookup(parsedRules);

  return parsedRules;
}

function normalizeApprovalMode(value) {
  return String(value ?? "").trim() === "auto" ? "auto" : "confirm";
}

function extractCommandFromToolCall(toolCall) {
  const rawArguments = String(toolCall?.function?.arguments ?? "");
  const parsedArguments = safeJsonParse(rawArguments, {});

  if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
    return "";
  }

  return typeof parsedArguments.command === "string" ? parsedArguments.command.trim() : "";
}

function matchCommandRules(parsedRules, command, approvalMode) {
  const normalizedCommand = String(command ?? "").trim();

  if (!normalizedCommand) {
    return null;
  }

  for (const rule of parsedRules.commandRules) {
    if (approvalMode === "auto" && rule.section !== "always_review") {
      continue;
    }

    if (rule.regex.test(normalizedCommand)) {
      return {
        section: rule.section,
        groupName: rule.groupName,
        pattern: rule.pattern
      };
    }
  }

  return null;
}

export class ApprovalRulesStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async ensureFile() {
    const targetPath = path.resolve(String(this.filePath ?? ""));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (!(await fileExists(targetPath))) {
      await fs.writeFile(targetPath, "", "utf8");
    }
  }

  async read() {
    await this.ensureFile();

    const targetPath = path.resolve(String(this.filePath ?? ""));
    const rawMarkdown = await fs.readFile(targetPath, "utf8");
    const parsed = parseApprovalRulesMarkdown(rawMarkdown);

    return {
      rawMarkdown,
      alwaysReview: parsed.always_review,
      confirmReview: parsed.confirm_review,
      toolGroupLookup: parsed.toolGroupLookup,
      commandRules: parsed.commandRules
    };
  }
}

export function getApprovalGroupForToolCall(approvalRules, toolCall) {
  const toolName = String(toolCall?.function?.name ?? "").trim();
  const directRule = approvalRules?.toolGroupLookup?.get(toolName);

  if (directRule) {
    return directRule;
  }

  const command = extractCommandFromToolCall(toolCall);
  const commandRule = matchCommandRules(approvalRules, command, "confirm");

  if (commandRule) {
    return {
      section: commandRule.section,
      groupName: commandRule.groupName
    };
  }

  return null;
}

export function requiresApprovalForToolCall(approvalRules, toolCall, approvalMode) {
  const normalizedMode = normalizeApprovalMode(approvalMode);
  const toolName = String(toolCall?.function?.name ?? "").trim();
  const directRule = approvalRules?.toolGroupLookup?.get(toolName);

  if (directRule) {
    if (normalizedMode === "auto") {
      return directRule.section === "always_review";
    }

    return true;
  }

  const command = extractCommandFromToolCall(toolCall);
  const commandRule = matchCommandRules(approvalRules, command, normalizedMode);
  if (!commandRule) {
    return false;
  }

  if (normalizedMode === "auto") {
    return commandRule.section === "always_review";
  }

  return true;
}
