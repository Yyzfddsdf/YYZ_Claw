import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BACKEND_ROOT = path.resolve(__dirname, "../..");
export const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");
export const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const MCP_CONFIG_FILE = path.join(CONFIG_DIR, "mcp.json");
export const APPROVAL_RULES_FILE = path.join(PROJECT_ROOT, ".yyz", "rules.md");
export const GLOBAL_AGENTS_FILE = path.join(PROJECT_ROOT, ".yyz", "AGENTS.md");
export const MEMORY_SUMMARY_FILE = path.join(PROJECT_ROOT, ".yyz", "memory_summary.json");
export const SKILLS_DIR = path.join(PROJECT_ROOT, ".yyz", "skills");
export const SKILLS_SNAPSHOT_FILE = path.join(SKILLS_DIR, ".skills.snapshot.json");
export const HISTORY_DIR = path.join(PROJECT_ROOT, "History");
export const HISTORY_DB_FILE = path.join(HISTORY_DIR, "chat_history.sqlite");
export const MEMORY_DB_FILE = path.join(PROJECT_ROOT, "memory.sqlite");
export const TOOLS_DIR = path.join(BACKEND_ROOT, "src", "services", "tools");
export const BUILTIN_TOOLS_DIR = TOOLS_DIR;
export const SUBAGENTS_DIR = path.join(BACKEND_ROOT, "src", "subagents");
export const HOOKS_DIR = path.join(BACKEND_ROOT, "src", "services", "hooks", "definitions");
export const RUNTIME_BLOCKS_DIR = path.join(
  BACKEND_ROOT,
  "src",
  "services",
  "runtime",
  "providers"
);
