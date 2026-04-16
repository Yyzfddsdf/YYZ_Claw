export default {
  name: "researcher_report_progress",
  description: "Remind the researcher subagent to report evidence-backed progress after meaningful work.",
  priority: 140,
  evaluate(scope) {
    const recentToolEvents = Array.isArray(scope?.recentToolEvents) ? scope.recentToolEvents : [];
    if (recentToolEvents.length === 0) {
      return null;
    }

    return {
      type: "researcher_report_progress",
      level: "warning",
      message:
        "If you have finished a meaningful research chunk, send a concise pool_report with findings, evidence, and open questions."
    };
  }
};
