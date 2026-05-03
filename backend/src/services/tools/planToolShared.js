const PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "blocked", "cancelled"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizePlanStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return PLAN_STATUSES.has(normalized) ? normalized : "pending";
}

export function normalizePlanItem(item, index = 0) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const title = normalizeText(item.title ?? item.text ?? item.content);
  if (!title) {
    return null;
  }

  return {
    id: normalizeText(item.id) || `step_${index + 1}`,
    title,
    status: normalizePlanStatus(item.status),
    note: normalizeText(item.note)
  };
}

export function normalizePlanState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const items = Array.isArray(value.items)
    ? value.items.map((item, index) => normalizePlanItem(item, index)).filter(Boolean)
    : [];

  if (items.length === 0) {
    return null;
  }

  return {
    title: normalizeText(value.title) || "执行计划",
    items,
    updatedAt: Number(value.updatedAt ?? Date.now())
  };
}

export function readPlanState(executionContext = {}) {
  return normalizePlanState(executionContext.planState);
}

export function writePlanState(executionContext = {}, nextPlan) {
  const normalized = normalizePlanState({
    ...nextPlan,
    updatedAt: Date.now()
  });
  executionContext.planState = normalized;
  const conversationId = String(executionContext?.conversationId ?? "").trim();
  if (
    conversationId &&
    executionContext?.historyStore &&
    typeof executionContext.historyStore.updateConversationPlanState === "function"
  ) {
    executionContext.historyStore.updateConversationPlanState(conversationId, normalized);
  }
  return normalized;
}

export function createPlanToolResult(plan, message = "") {
  const normalized = normalizePlanState(plan);
  return {
    ok: Boolean(normalized),
    message: normalizeText(message),
    plan: normalized
  };
}

export function findPlanItemIndex(plan, itemId) {
  const normalizedItemId = normalizeText(itemId);
  if (!plan || !Array.isArray(plan.items) || !normalizedItemId) {
    return -1;
  }

  return plan.items.findIndex((item) => normalizeText(item.id) === normalizedItemId);
}
