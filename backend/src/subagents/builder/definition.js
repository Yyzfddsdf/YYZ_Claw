export default {
  agentType: "builder",
  displayName: "实现子智能体",
  description: "擅长局部实现、修补和验证。",
  promptFile: "prompt.md",
  toolsDir: "tools",
  hooksDir: "hooks",
  inheritedBaseToolNames: [
    "list_dir",
    "read_file",
    "search_files",
    "run_terminal",
    "create_file",
    "insert_text",
    "replace_text",
    "delete_text",
    "apply_patch",
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
    specialty: "implementation"
  }
};
