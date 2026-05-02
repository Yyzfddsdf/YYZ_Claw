function normalizeText(value) {
  return String(value ?? "").trim();
}

export default {
  name: "goal_submit",
  description:
    "Submit the active conversation goal as completed. Use only when the configured goal has truly been finished.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Concise completion summary for the configured goal."
      },
      evidence: {
        type: "string",
        description: "Optional evidence, verification result, or final deliverable reference."
      }
    },
    required: ["summary"],
    additionalProperties: false
  },
  isAvailable(executionContext = {}) {
    return Boolean(normalizeText(executionContext?.goal));
  },
  async execute(args = {}, executionContext = {}) {
    const summary = normalizeText(args.summary);
    const evidence = normalizeText(args.evidence);
    const goal = normalizeText(executionContext?.goal);

    const goalState =
      executionContext.goalState &&
      typeof executionContext.goalState === "object" &&
      !Array.isArray(executionContext.goalState)
        ? executionContext.goalState
        : {};

    goalState.submitted = true;
    goalState.submittedAt = Date.now();
    goalState.summary = summary;
    goalState.evidence = evidence;
    goalState.goal = goal;
    executionContext.goalState = goalState;

    return {
      submitted: true,
      summary,
      evidence,
      goal,
      message: "目标已提交完成。"
    };
  }
};
