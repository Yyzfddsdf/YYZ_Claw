export default {
  name: "subagent_shared_discipline",
  description:
    "Apply lightweight runtime discipline shared by all subagents without splitting logic per agent type.",
  priority: 145,
  evaluate(scope) {
    const recentToolEvents = Array.isArray(scope?.recentToolEvents) ? scope.recentToolEvents : [];
    const scopedMessages = Array.isArray(scope?.scopedMessages) ? scope.scopedMessages : [];
    if (recentToolEvents.length === 0 && scopedMessages.length === 0) {
      return null;
    }

    return {
      type: "subagent_shared_discipline",
      source: recentToolEvents.length > 0 ? "tool" : "message",
      level: "warning",
      message:
        "Stay within the assigned slice, keep progress evidence-backed, use pool_report for meaningful interim updates, and reserve subagent_finish_report for final handoff or clear blockers."
    };
  }
};
