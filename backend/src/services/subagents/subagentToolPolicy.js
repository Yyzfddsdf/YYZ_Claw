function normalizeToolName(value) {
  return String(value ?? "").trim();
}

export const SUBAGENT_TOOL_BLACKLIST = Object.freeze([
  "clarify",
  "send_file",
  "send_message",
  "subagent_create",
  "subagent_delete",
  "subagent_dispatch",
  "subagent_list",
  "subagent_types_list"
]);

export function normalizeSubagentToolBlacklist() {
  return SUBAGENT_TOOL_BLACKLIST.map((item) => normalizeToolName(item)).filter(Boolean);
}
