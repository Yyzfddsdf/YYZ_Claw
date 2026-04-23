import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

function createLogger() {
  const lines = [];

  const pushLine = (...items) => {
    const rendered = items
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
    lines.push(rendered);
  };

  return {
    logger: {
      log: (...items) => pushLine(...items),
      info: (...items) => pushLine(...items),
      warn: (...items) => pushLine(...items),
      error: (...items) => pushLine(...items)
    },
    lines
  };
}

function createToolBridge() {
  const pendingMap = new Map();
  let requestId = 0;

  const handleMessage = (message = {}) => {
    if (String(message?.type ?? "") !== "tool_result") {
      return;
    }

    const id = Number(message?.id ?? -1);
    const pending = pendingMap.get(id);
    if (!pending) {
      return;
    }

    pendingMap.delete(id);
    if (message?.ok === false) {
      pending.reject(new Error(String(message?.error ?? "tool execution failed")));
      return;
    }

    pending.resolve(message?.result ?? null);
  };

  parentPort.on("message", handleMessage);

  const callTool = async (toolName, args = {}) => {
    const normalizedToolName = String(toolName ?? "").trim();
    if (!normalizedToolName) {
      throw new Error("toolName is required");
    }

    requestId += 1;
    const id = requestId;

    return new Promise((resolve, reject) => {
      pendingMap.set(id, { resolve, reject });
      parentPort.postMessage({
        type: "tool_call",
        id,
        toolName: normalizedToolName,
        args:
          args && typeof args === "object" && !Array.isArray(args)
            ? args
            : {}
      });
    });
  };

  return {
    callTool,
    dispose() {
      parentPort.off("message", handleMessage);
      for (const pending of pendingMap.values()) {
        pending.reject(new Error("execution interrupted"));
      }
      pendingMap.clear();
    }
  };
}

async function run() {
  const code = String(workerData?.code ?? "");
  const { logger, lines } = createLogger();
  const bridge = createToolBridge();
  const require = createRequire(import.meta.url);
  const workerFileUrl = import.meta.url;
  const workerFilePath = new URL(workerFileUrl).pathname;
  const workerDirPath = workerFilePath.replace(/[\\/][^\\/]*$/, "");

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction(
      "callTool",
      "console",
      "require",
      "process",
      "Buffer",
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "fetch",
      "__filename",
      "__dirname",
      "__importMetaUrl",
      `"use strict";\n${code}`
    );

    const result = await execute(
      bridge.callTool,
      logger,
      require,
      process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      globalThis.fetch,
      workerFilePath,
      workerDirPath,
      workerFileUrl
    );
    parentPort.postMessage({
      type: "done",
      ok: true,
      result: result ?? null,
      logs: lines
    });
  } catch (error) {
    parentPort.postMessage({
      type: "done",
      ok: false,
      error: String(error?.stack ?? error?.message ?? "execute_code failed"),
      logs: lines
    });
  } finally {
    bridge.dispose();
  }
}

run().catch((error) => {
  parentPort.postMessage({
    type: "done",
    ok: false,
    error: String(error?.stack ?? error?.message ?? "execute_code failed"),
    logs: []
  });
});
