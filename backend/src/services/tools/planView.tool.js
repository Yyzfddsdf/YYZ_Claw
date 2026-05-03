import { createPlanToolResult, readPlanState } from "./planToolShared.js";

export default {
  name: "plan_view",
  description:
    "View the current visible execution plan without changing it. Use when you need to confirm remaining steps before continuing or finishing.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const plan = readPlanState(executionContext);
    if (!plan) {
      return {
        ok: false,
        message: "当前没有活动计划。",
        plan: null
      };
    }

    return createPlanToolResult(plan, "当前计划已读取。");
  }
};
