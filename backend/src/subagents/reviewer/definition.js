export default {
  agentType: "reviewer",
  displayName: "审查子智能体",
  description: "擅长发现缺陷、回归和验证缺口。",
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
    specialty: "review"
  }
};
