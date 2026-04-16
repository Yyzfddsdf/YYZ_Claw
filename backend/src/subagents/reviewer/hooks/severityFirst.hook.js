export default {
  name: "reviewer_severity_first",
  description: "Keep reviewer output focused on findings ordered by severity.",
  priority: 150,
  evaluate(scope) {
    const scopedMessages = Array.isArray(scope?.scopedMessages) ? scope.scopedMessages : [];
    if (scopedMessages.length === 0) {
      return null;
    }

    return {
      type: "reviewer_severity_first",
      level: "warning",
      message:
        "Review output should prioritize concrete findings by severity, then list open questions or residual risks, and only then give short summary."
    };
  }
};
