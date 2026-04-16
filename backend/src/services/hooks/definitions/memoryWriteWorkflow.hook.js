import { analyzeMemoryWriteSignals } from "../memoryWriteSignals.js";

const MEMORY_TOOL_PREFIX = "memory_";
const CREATE_TOOL_NAMES = new Set(["memory_create_topic", "memory_create_content", "memory_create_node"]);

function findLatestMemoryToolEvent(scope) {
  const events = Array.isArray(scope?.recentToolEvents) ? scope.recentToolEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (String(event?.toolName ?? "").trim().startsWith(MEMORY_TOOL_PREFIX)) {
      return event;
    }
  }
  return null;
}

export default {
  name: "memory_write_workflow",
  description:
    "Reinforce the memory write workflow: find candidates first, prefer update or merge, and avoid blind create retries.",
  priority: 190,
  evaluate(scope) {
    const signal = analyzeMemoryWriteSignals(scope);
    const latestMemoryToolEvent = findLatestMemoryToolEvent(scope);
    const latestToolName = String(latestMemoryToolEvent?.toolName ?? "").trim();
    const latestToolContent = String(latestMemoryToolEvent?.content ?? "");
    const memoryIntent = signal.shouldConsider;

    if (!memoryIntent && !latestMemoryToolEvent) {
      return null;
    }

    const blockedBlindCreate =
      CREATE_TOOL_NAMES.has(latestToolName) &&
      latestMemoryToolEvent?.isError &&
      /memory_find_candidates|memory_browse|existing topicId|existing contentId/i.test(
        latestToolContent
      );

    const candidateSuggestedUpdate =
      latestToolName === "memory_find_candidates" &&
      /update_or_merge_existing_node|update_or_merge_existing_content|reuse_existing_topic/i.test(
        latestToolContent
      );

    if (blockedBlindCreate || candidateSuggestedUpdate) {
      return {
        type: "memory_write_workflow",
        source: "tool",
        level: "strong",
        priority: 230,
        tags: ["memory", "workflow", "tool"],
        message: blockedBlindCreate
          ? "Do not retry blind memory create. Use memory_find_candidates results or existing ids, then prefer update or merge; create new topic or content only as a last resort."
          : "Use the candidate results you already have: prefer update or merge, reuse existing ids, and keep new topic or content creation as a last resort."
      };
    }

    return {
      type: "memory_write_workflow",
      source: latestMemoryToolEvent ? "tool" : "message",
      level: "warning",
      priority: 190,
      tags: ["memory", "workflow"],
      message:
        "Before any memory write, call memory_find_candidates first. Prefer update or merge over create, and treat new topic or content creation as a last resort."
    };
  }
};
