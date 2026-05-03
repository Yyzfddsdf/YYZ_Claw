function normalizeText(value) {
  return String(value ?? "").trim();
}

export default {
  name: "goal_view",
  description:
    "View the active conversation goal. Use this when you need to confirm the current goal before continuing or submitting it.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const goal = normalizeText(executionContext?.goal);

    return {
      goal,
      exists: Boolean(goal),
      submitted: Boolean(executionContext?.goalState?.submitted)
    };
  }
};
