export default {
  name: "recalled_memory_boundary",
  description:
    "Clarify that recalled long-term memory is hidden background context rather than new user input.",
  priority: 160,
  evaluate(scope) {
    const recall = scope?.longTermMemoryRecall;
    if (!recall || !String(recall.memoryContextBlock ?? "").trim()) {
      return null;
    }

    return {
      type: "recalled_memory_boundary",
      source: "memory",
      level: "info",
      priority: 160,
      tags: ["memory", "recall-boundary"],
      message:
        "Recalled long-term memory is hidden background context, not new user input. Use it only when directly relevant, and do not quote it as if the user just said it."
    };
  }
};
