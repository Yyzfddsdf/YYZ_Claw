import fs from "node:fs/promises";
import path from "node:path";

const HEADING_SECTION_PATTERN = /^##\s+(always_review|confirm_review)\s*$/i;
const HEADING_GROUP_PATTERN = /^###\s+([A-Za-z0-9_-]+)\s*$/;
const BULLET_PATTERN = /^[-*+]\s+(.*)$/;

export const APPROVAL_RULES_DEFAULT_MARKDOWN = `# Approval Rules

本文件控制哪些工具和命令在审批模式下需要用户确认。

## always_review

### shell
- tool: run_terminal
- command: ^(?:git\\s+push\\b|rm\\s+-rf\\b|del(?:\\s+|$)|rmdir(?:\\s+|$))

## confirm_review

### file_edit
- tool: create_file
- tool: delete_text
- tool: insert_text
- tool: replace_text

### patch_edit
- tool: apply_patch
`;

function createEmptySection() {
  return {
    groups: {}
  };
}

function createEmptyRules() {
  return {
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
    commands: []
  };
  return section.groups[normalizedGroupName];
}

function parseRuleItem(line) {
  const normalized = String(line ?? "").trim();

  if (!normalized) {
    return null;
  }

  const toolMatch = normalized.match(/^tool:\s*(.+)$/i);
  if (toolMatch) {
    return {
      type: "tool",
      value: String(toolMatch[1] ?? "").trim()
    };
  }

  const commandMatch = normalized.match(/^(command|pattern|regex):\s*(.+)$/i);
  if (commandMatch) {
    return {
      type: "command",
      value: String(commandMatch[2] ?? "").trim()
    };
  }

  return {
    type: "tool",
    value: normalized
  };
}

function compileCommandPatterns(rules) {
  for (const sectionName of ["always_review", "confirm_review"]) {
    const section = rules[sectionName];

    for (const [groupName, group] of Object.entries(section.groups)) {
      const compiledCommands = [];

      for (const pattern of group.commands) {
        try {
          compiledCommands.push(new RegExp(pattern, "i"));
          rules.commandRules.push({
            section: sectionName,
            groupName,
            pattern,
            regex: new RegExp(pattern, "i")
          });
        } catch {
          continue;
        }
      }

      group.compiledCommands = compiledCommands;
    }
  }
}

function buildToolLookup(rules) {
  for (const sectionName of ["always_review", "confirm_review"]) {
    const section = rules[sectionName];

    for (const [groupName, group] of Object.entries(section.groups)) {
      for (const toolName of group.tools) {
        const normalizedToolName = String(toolName ?? "").trim();

        if (!normalizedToolName) {
          continue;
        }

        const current = rules.toolGroupLookup.get(normalizedToolName);
        if (current?.section === "always_review") {
          continue;
        }

        rules.toolGroupLookup.set(normalizedToolName, {
          section: sectionName,
          groupName
        });
      }
    }
  }
}

export function parseApprovalRulesMarkdown(markdown) {
  const rules = createEmptyRules();
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");

  let currentSectionName = "";
  let currentGroupName = "";

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();

    if (!line || line.startsWith("# ")) {
      continue;
    }

    const sectionMatch = line.match(HEADING_SECTION_PATTERN);
    if (sectionMatch) {
      currentSectionName = String(sectionMatch[1]).toLowerCase();
      currentGroupName = "";
      continue;
    }

    const groupMatch = line.match(HEADING_GROUP_PATTERN);
    if (groupMatch) {
      currentGroupName = String(groupMatch[1]).trim();
      continue;
    }

    const bulletMatch = line.match(BULLET_PATTERN);
    if (!bulletMatch || !currentSectionName) {
      continue;
    }

    const item = parseRuleItem(bulletMatch[1]);
    if (!item) {
      continue;
    }

    const section = rules[currentSectionName];
    const group = getOrCreateGroup(section, currentGroupName);

    if (item.type === "command") {
      group.commands.push(item.value);
      continue;
    }

    group.tools.push(item.value);
  }

  compileCommandPatterns(rules);
  buildToolLookup(rules);

  return rules;
}

export function createApprovalRulesSummary(rules) {
  return {
    always_review: rules.always_review,
    confirm_review: rules.confirm_review,
    toolGroupLookup: rules.toolGroupLookup,
    commandRules: rules.commandRules
  };
}

export async function loadApprovalRulesFromFile(filePath) {
  const resolvedPath = path.resolve(String(filePath ?? ""));
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  try {
    await fs.access(resolvedPath);
  } catch {
    await fs.writeFile(resolvedPath, APPROVAL_RULES_DEFAULT_MARKDOWN, "utf8");
  }

  const markdown = await fs.readFile(resolvedPath, "utf8");
  const parsed = parseApprovalRulesMarkdown(markdown);

  if (parsed.commandRules.length === 0 && parsed.toolGroupLookup.size === 0) {
    return parseApprovalRulesMarkdown(APPROVAL_RULES_DEFAULT_MARKDOWN);
  }

  return parsed;
}

export function getApprovalGroupForToolName(rules, toolName) {
  return rules?.toolGroupLookup?.get(String(toolName ?? "").trim()) ?? null;
}

export function isCommandMatched(rules, command, sectionName) {
  const normalizedCommand = String(command ?? "").trim();

  if (!normalizedCommand) {
    return null;
  }

  for (const rule of rules?.commandRules ?? []) {
    if (sectionName && rule.section !== sectionName) {
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
