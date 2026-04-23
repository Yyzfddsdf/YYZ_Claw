import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 1800000;
const DEFAULT_MAX_TOOL_CALLS = 50;
const UNLIMITED_TOOL_CALLS = -1;

function normalizeTimeoutMs(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1000) {
    return 1000;
  }

  return Math.min(normalized, MAX_TIMEOUT_MS);
}

function normalizeMaxToolCalls(value) {
  if (value === null || value === undefined) {
    return DEFAULT_MAX_TOOL_CALLS;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_TOOL_CALLS;
  }

  const normalized = Math.trunc(value);
  if (normalized === UNLIMITED_TOOL_CALLS) {
    return UNLIMITED_TOOL_CALLS;
  }

  if (normalized < 1) {
    return 1;
  }

  return normalized;
}

function resolveToolInvoker(executionContext = {}) {
  if (typeof executionContext?.invokeToolCall === "function") {
    return executionContext.invokeToolCall.bind(executionContext);
  }

  if (typeof executionContext?.toolRegistry?.executeToolCall === "function") {
    return executionContext.toolRegistry.executeToolCall.bind(executionContext.toolRegistry);
  }

  return null;
}

function normalizeCodeResult(rawResult = {}) {
  const logs = Array.isArray(rawResult?.logs)
    ? rawResult.logs
        .map((item) => String(item ?? "").trimEnd())
        .filter((item) => item.length > 0)
    : [];

  const result = rawResult?.result ?? null;
  return {
    result,
    logs
  };
}

function buildNestedToolCall(toolName, args) {
  return {
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args ?? {})
    }
  };
}

function executeInWorker({
  code,
  timeoutMs,
  maxToolCalls,
  invokeToolCall,
  executionContext
}) {
  const workerPath = new URL("./executeCode.worker.js", import.meta.url);

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        code
      }
    });

    let toolCallCount = 0;
    let completed = false;

    const finish = (handler, payload) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      handler(payload);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`execute_code timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    worker.on("message", async (message = {}) => {
      const type = String(message?.type ?? "").trim();

      if (type === "tool_call") {
        const requestId = Number(message?.id ?? -1);
        const toolName = String(message?.toolName ?? "").trim();
        const toolArgs =
          message?.args && typeof message.args === "object" && !Array.isArray(message.args)
            ? message.args
            : {};

        if (!toolName) {
          worker.postMessage({
            type: "tool_result",
            id: requestId,
            ok: false,
            error: "toolName is required"
          });
          return;
        }

        if (toolName === "execute_code") {
          worker.postMessage({
            type: "tool_result",
            id: requestId,
            ok: false,
            error: "Nested execute_code call is not allowed."
          });
          return;
        }

        if (maxToolCalls !== UNLIMITED_TOOL_CALLS) {
          toolCallCount += 1;
          if (toolCallCount > maxToolCalls) {
            worker.postMessage({
              type: "tool_result",
              id: requestId,
              ok: false,
              error: `Tool call limit exceeded (${maxToolCalls}).`
            });
            return;
          }
        }

        try {
          const toolCall = buildNestedToolCall(toolName, toolArgs);
          const toolResult = await invokeToolCall(toolCall, executionContext);
          worker.postMessage({
            type: "tool_result",
            id: requestId,
            ok: true,
            result: toolResult
          });
        } catch (error) {
          worker.postMessage({
            type: "tool_result",
            id: requestId,
            ok: false,
            error: String(error?.message ?? "nested tool execution failed")
          });
        }
        return;
      }

      if (type === "done") {
        const rawResult = {
          result: message?.result ?? null,
          logs: message?.logs ?? []
        };
        if (message?.ok === false) {
          finish(reject, new Error(String(message?.error ?? "execute_code failed")));
          return;
        }

        finish(resolve, {
          ...normalizeCodeResult(rawResult),
          toolCallCount
        });
      }
    });

    worker.on("error", (error) => {
      finish(reject, error);
    });

    worker.on("exit", (codeValue) => {
      if (completed) {
        return;
      }

      finish(
        reject,
        new Error(`execute_code worker exited unexpectedly with code ${codeValue}.`)
      );
    });
  });
}

export default {
  name: "execute_code",
  description:
    "Execute JavaScript/Node.js code in an isolated worker. Supports direct Node APIs (for example require/process) and optional tool orchestration via callTool(toolName, args). Supports custom timeout and tool call limits.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript/Node.js source code. You can run direct JS logic and optionally use await callTool('tool_name', { ...args }) to invoke registered tools."
      },
      timeoutMs: {
        type: "integer",
        description: "Execution timeout in milliseconds (1000-1800000)."
      },
      maxToolCalls: {
        type: "integer",
        description:
          "Max nested tool calls. Set -1 for unlimited. Defaults to 50."
      }
    },
    required: ["code"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) {
      throw new Error("code is required");
    }

    const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
    const maxToolCalls = normalizeMaxToolCalls(args.maxToolCalls);
    const invokeToolCall = resolveToolInvoker(executionContext);
    if (!invokeToolCall) {
      throw new Error("tool invoker is unavailable in current runtime");
    }

    const workerResult = await executeInWorker({
      code,
      timeoutMs,
      maxToolCalls,
      invokeToolCall,
      executionContext
    });

    return {
      language: "javascript",
      timeoutMs,
      maxToolCalls,
      toolCallCount: workerResult.toolCallCount,
      logs: workerResult.logs,
      result: workerResult.result
    };
  }
};
