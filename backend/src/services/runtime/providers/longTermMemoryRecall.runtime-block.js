export default {
  name: "long_term_memory_recall_block",
  description:
    "Expose the recalled long-term memory block as a runtime block for the current user message.",
  priority: 220,
  resolve(scope) {
    const memoryContextBlock = String(scope?.longTermMemoryRecall?.memoryContextBlock ?? "").trim();
    if (!memoryContextBlock) {
      return null;
    }

    return {
      type: "long_term_memory_recall",
      source: "memory",
      channel: "current_user",
      priority: 220,
      level: "strong",
      content: memoryContextBlock,
      tags: ["memory", "recall"]
    };
  }
};
