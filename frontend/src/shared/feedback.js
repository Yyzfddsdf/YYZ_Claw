const listeners = new Set();

let noticeIdSeed = 0;
let confirmIdSeed = 0;
const notices = [];
let activeConfirm = null;

function emit() {
  const snapshot = {
    notices: [...notices],
    confirm: activeConfirm
  };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function subscribeFeedback(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  listeners.add(listener);
  listener({
    notices: [...notices],
    confirm: activeConfirm
  });

  return () => {
    listeners.delete(listener);
  };
}

export function notify(input) {
  const options =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : { message: input };
  const message = String(options.message ?? "").trim();
  if (!message) {
    return "";
  }

  const id = `notice_${Date.now()}_${++noticeIdSeed}`;
  notices.push({
    id,
    message,
    title: String(options.title ?? "").trim(),
    tone: String(options.tone ?? "info").trim() || "info",
    createdAt: Date.now()
  });

  while (notices.length > 4) {
    notices.shift();
  }

  emit();
  window.setTimeout(() => {
    dismissNotice(id);
  }, Number(options.durationMs ?? 3600));

  return id;
}

export function dismissNotice(id) {
  const normalizedId = String(id ?? "").trim();
  const index = notices.findIndex((notice) => notice.id === normalizedId);
  if (index < 0) {
    return;
  }

  notices.splice(index, 1);
  emit();
}

export function confirmAction(input) {
  const options =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : { message: input };
  const message = String(options.message ?? "").trim();

  return new Promise((resolve) => {
    activeConfirm = {
      id: `confirm_${Date.now()}_${++confirmIdSeed}`,
      title: String(options.title ?? "确认操作").trim() || "确认操作",
      message,
      detail: String(options.detail ?? "").trim(),
      tone: String(options.tone ?? "danger").trim() || "danger",
      confirmLabel: String(options.confirmLabel ?? "确认").trim() || "确认",
      cancelLabel: String(options.cancelLabel ?? "取消").trim() || "取消",
      resolve
    };
    emit();
  });
}

export function resolveConfirm(accepted) {
  const current = activeConfirm;
  if (!current) {
    return;
  }

  activeConfirm = null;
  current.resolve(Boolean(accepted));
  emit();
}
