import {
  createPlanToolResult,
  normalizePlanItem,
  readPlanState,
  writePlanState
} from "./planToolShared.js";

export default {
  name: "plan_modify",
  description:
    "Modify the visible execution plan when the task scope changes. Use to add, remove, rename, or reorder steps without pretending unfinished work is complete.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional new plan title."
      },
      items: {
        type: "array",
        minItems: 1,
        description:
          "The full updated step list. Include existing unfinished steps unless they are truly obsolete.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Stable step id."
            },
            title: {
              type: "string",
              description: "Step title."
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "blocked", "cancelled"],
              description: "Step status."
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
    const currentPlan = readPlanState(executionContext);
    const items = Array.isArray(args.items)
      ? args.items.map((item, index) => normalizePlanItem(item, index)).filter(Boolean)
      : [];

    if (items.length === 0) {
      throw new Error("plan_modify requires at least one valid item.");
    }

    const nextPlan = writePlanState(executionContext, {
      title: args.title ?? currentPlan?.title,
      items
    });

    return createPlanToolResult(nextPlan, "计划已修改。");
  }
};
