function normalizeAbortMessage(reason) {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }

  if (reason instanceof Error && typeof reason.message === "string" && reason.message.trim()) {
    return reason.message.trim();
  }

  if (
    reason &&
    typeof reason === "object" &&
    typeof reason.message === "string" &&
    reason.message.trim()
  ) {
    return reason.message.trim();
  }

  return "run aborted";
}

export function createAbortError(reason) {
  const error = new Error(normalizeAbortMessage(reason));
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.statusCode = 499;
  return error;
}

export function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    error?.statusCode === 499
  );
}

export function throwIfAborted(signal) {
  if (!signal) {
    return;
  }

  if (typeof signal.throwIfAborted === "function") {
    try {
      signal.throwIfAborted();
      return;
    } catch (error) {
      throw isAbortError(error) ? error : createAbortError(signal.reason ?? error);
    }
  }

  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }
}

export function sleepWithSignal(ms, signal) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms ?? 0)));

    const abortHandler = () => {
      cleanup();
      reject(createAbortError(signal?.reason));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", abortHandler);
    };

    signal?.addEventListener?.("abort", abortHandler, { once: true });
  });
}
