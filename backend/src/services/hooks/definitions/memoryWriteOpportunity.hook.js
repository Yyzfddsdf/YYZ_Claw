import { analyzeMemoryWriteSignals } from "../memoryWriteSignals.js";

const MEMORY_WRITE_TOOL_NAMES = new Set([
  "memory_create_topic",
  "memory_create_content",
  "memory_create_node",
  "memory_update_topic",
  "memory_update_content",
  "memory_update_node",
  "memory_merge_nodes"
]);

function hasRecentMemoryWrite(scope) {
  return scope.recentToolEvents.some(
    (event) => event.phase === "result" && MEMORY_WRITE_TOOL_NAMES.has(event.toolName)
  );
}

export default {
  name: "memory_write_opportunity",
  description:
    "Detect when the current turn likely contains durable long-term memory worth saving.",
  priority: 180,
  evaluate(scope) {
    const signal = analyzeMemoryWriteSignals(scope);
    if (!signal.text || hasRecentMemoryWrite(scope) || !signal.shouldConsider) {
      return null;
    }

    return {
      type: "memory_write_opportunity",
      source: "message",
      level: signal.level,
      priority: signal.level === "strong" ? 210 : 180,
      tags: ["memory", "write-opportunity"],
      message:
        "This turn likely contains durable long-term memory. If the information is stable and reusable across future sessions, consider saving it after answering."
    };
  }
};
