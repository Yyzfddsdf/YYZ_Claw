export default {
  agentType: "researcher",
  displayName: "研究子智能体",
  description: "擅长检索、阅读、整理证据和形成结论。",
  promptFile: "prompt.md",
  toolsDir: "tools",
  hooksDir: "hooks",
  inheritedBaseToolNames: [
    "list_dir",
    "read_file",
    "search_files",
    "run_terminal",
    "session_search",
    "skill_view",
    "skill_validate",
    "get_current_time",
    "pool_list",
    "pool_read",
    "pool_report"
  ],
  inheritedBaseHookNames: [
    "parsed_files_grounding",
    "recalled_memory_boundary"
  ],
  metadata: {
    specialty: "research"
  }
};
