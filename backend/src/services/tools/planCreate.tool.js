import { createPlanToolResult, normalizePlanItem, writePlanState } from "./planToolShared.js";

export default {
  name: "plan_create",
  description:
    "Create a visible execution plan for the current task. Use when the task has multiple meaningful steps and the user should see progress.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short plan title."
      },
      items: {
        type: "array",
        minItems: 1,
        description: "Plan steps in execution order.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Stable step id, for example step_1."
            },
            title: {
              type: "string",
              description: "Human-readable step title."
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "blocked", "cancelled"],
              description: "Initial step status."
            },
            note: {
              type: "string",
              description: "Optional short note."
            }
          },
          required: ["title"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const items = Array.isArray(args.items)
      ? args.items.map((item, index) => normalizePlanItem(item, index)).filter(Boolean)
      : [];

    if (items.length === 0) {
      throw new Error("plan_create requires at least one valid item.");
    }

    const plan = writePlanState(executionContext, {
      title: args.title,
      items
    });

    return createPlanToolResult(plan, "计划已创建。");
  }
};
