import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BACKEND_ROOT = path.resolve(__dirname, "../..");
export const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");
export const USER_HOME = os.homedir();
export const YYZ_DIR = path.resolve(process.env.YYZ_CLAW_HOME || path.join(USER_HOME, ".yyz"));
export const CONFIG_DIR = path.join(YYZ_DIR, "config");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const MCP_CONFIG_FILE = path.join(CONFIG_DIR, "mcp.json");
export const APPROVAL_RULES_FILE = path.join(YYZ_DIR, "rules.md");
export const GLOBAL_AGENTS_FILE = path.join(YYZ_DIR, "AGENTS.md");
export const MEMORY_SUMMARY_FILE = path.join(YYZ_DIR, "memory_summary.json");
export const MEMORY_SUMMARY_DIR = path.join(YYZ_DIR, "memory");
export const PERSONAS_DIR = path.join(YYZ_DIR, "personas");
export const BACKGROUNDS_DIR = path.join(YYZ_DIR, "backgrounds");
export const SKILLS_DIR = path.join(YYZ_DIR, "skills");
export const SKILLS_SNAPSHOT_FILE = path.join(SKILLS_DIR, ".skills.snapshot.json");
export const IM_ROOT_DIR = path.join(YYZ_DIR, "integrations");
export const IM_FEISHU_DIR = path.join(IM_ROOT_DIR, "feishu");
export const FEISHU_CONFIG_FILE = path.join(IM_FEISHU_DIR, "config.json");
export const REMOTE_CONTROL_DIR = path.join(IM_ROOT_DIR, "remote-control");
export const REMOTE_CONTROL_CONFIG_FILE = path.join(CONFIG_DIR, "remote-control.json");
export const HISTORY_DIR = path.join(YYZ_DIR, "history");
export const HISTORY_DB_FILE = path.join(HISTORY_DIR, "chat_history.sqlite");
export const DEBATE_DB_FILE = path.join(HISTORY_DIR, "ai_debates.sqlite");
export const MEMORY_DB_FILE = path.join(YYZ_DIR, "memory.sqlite");
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
