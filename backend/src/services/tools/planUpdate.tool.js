import {
  createPlanToolResult,
  findPlanItemIndex,
  normalizePlanStatus,
  readPlanState,
  writePlanState
} from "./planToolShared.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

export default {
  name: "plan_update",
  description:
    "Update the status of one visible plan step. Use immediately after a step starts, completes, becomes blocked, or is cancelled.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Plan step id to update."
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "blocked", "cancelled"],
        description: "New step status."
      },
      note: {
        type: "string",
        description: "Optional short note explaining progress or result."
      }
    },
    required: ["id", "status"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const plan = readPlanState(executionContext);
    if (!plan) {
      throw new Error("No active plan. Call plan_create first.");
    }

    const itemIndex = findPlanItemIndex(plan, args.id);
    if (itemIndex < 0) {
      throw new Error(`Plan item not found: ${normalizeText(args.id)}`);
    }

    const nextItems = plan.items.map((item, index) =>
      index === itemIndex
        ? {
            ...item,
            status: normalizePlanStatus(args.status),
            note: Object.prototype.hasOwnProperty.call(args, "note")
              ? normalizeText(args.note)
              : item.note
          }
        : item
    );
    const nextPlan = writePlanState(executionContext, {
      ...plan,
      items: nextItems
    });

    return createPlanToolResult(nextPlan, "计划状态已更新。");
  }
};
