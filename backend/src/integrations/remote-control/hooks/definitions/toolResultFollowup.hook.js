function findLatestHookedToolResult(scope) {
  const events = Array.isArray(scope?.recentToolEvents) ? scope.recentToolEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const metadata =
      event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata
        : {};
    const hookCount = Number(metadata.hooks ?? 0);
    if (event?.phase === "result" && hookCount > 0) {
      return {
        event,
        hookCount
      };
    }
  }
  return null;
}

export default {
  name: "remote_tool_result_followup",
  description:
    "When tool_result hooks exist, remind the model they are runtime guidance from tools and should drive the next reasoning step.",
  priority: 170,
  evaluate(scope) {
    const latest = findLatestHookedToolResult(scope);
    if (!latest) {
      return null;
    }

    const toolName = String(latest.event?.toolName ?? "").trim() || "unknown_tool";
    return {
      type: "remote_tool_result_followup",
      source: "tool",
      level: "warning",
      priority: 170,
      tags: ["remote", "tool-result-hooks", "followup"],
      message: `The latest tool result from ${toolName} contains ${latest.hookCount} runtime hook(s). Apply these hooks in reasoning and execution, but do not present them as new user input.`
    };
  }
};

