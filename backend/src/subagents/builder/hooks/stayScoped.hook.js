export default {
  name: "builder_stay_scoped",
  description: "Keep the builder subagent focused on the assigned slice and reporting validated outcomes.",
  priority: 150,
  evaluate(scope) {
    const recentToolEvents = Array.isArray(scope?.recentToolEvents) ? scope.recentToolEvents : [];
    if (recentToolEvents.length === 0) {
      return null;
    }

    return {
      type: "builder_stay_scoped",
      level: "warning",
      message:
        "Keep the implementation scoped. After a validated atomic unit, send pool_report with changed area, verification, and remaining risks."
    };
  }
};
