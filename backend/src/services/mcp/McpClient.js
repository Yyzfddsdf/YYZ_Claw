import { spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER_NAME = "mcp-session-id";

function createStatusError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  return Buffer.from(String(value ?? ""), "utf8");
}

function normalizeHeaders(headers = {}) {
  const result = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key ?? "").trim();
    const normalizedValue = String(value ?? "");

    if (normalizedKey) {
      result[normalizedKey] = normalizedValue;
    }
  }

  return result;
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSseMessages(rawText) {
  const messages = [];
  const blocks = String(rawText ?? "").split(/\r?\n\r?\n/g);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/g);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .filter((line) => line.length > 0);

    if (dataLines.length === 0) {
      continue;
    }

    const rawData = dataLines.join("\n");
    const parsed = parseJsonSafe(rawData);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return messages;
}

function hasHeader(response, headerName) {
  return Boolean(response?.headers?.get(headerName) || response?.headers?.get(headerName.toLowerCase()));
}

async function readStreamMessages(response, targetId) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return parseSseMessages(text);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const messages = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const parsedMessages = parseSseMessages(block);
        for (const message of parsedMessages) {
          messages.push(message);
          if (targetId && String(message?.id ?? "") === String(targetId)) {
            await reader.cancel().catch(() => {});
            return messages;
          }
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    if (buffer.trim().length > 0) {
      messages.push(...parseSseMessages(buffer));
    }
  }

  return messages;
}

export class McpClient {
  constructor(options) {
    this.name = String(options?.name ?? "").trim();
    this.transport = String(options?.transport ?? "stdio").trim() === "http" ? "http" : "stdio";
    this.command = String(options?.command ?? "").trim();
    this.args = Array.isArray(options?.args) ? options.args.map((item) => String(item ?? "")) : [];
    this.cwd = String(options?.cwd ?? "").trim();
    this.env = options?.env && typeof options.env === "object" ? options.env : {};
    this.url = String(options?.url ?? "").trim();
    this.httpHeaders =
      options?.httpHeaders && typeof options.httpHeaders === "object" ? normalizeHeaders(options.httpHeaders) : {};
    this.startupTimeoutMs = Number.isInteger(options?.startupTimeoutMs)
      ? options.startupTimeoutMs
      : 10000;
    this.requestTimeoutMs = Number.isInteger(options?.requestTimeoutMs)
      ? options.requestTimeoutMs
      : 30000;

    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.started = false;
    this.startPromise = null;
    this.closed = false;
    this.sessionId = "";
  }

  buildHeaderBuffer(payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
      body
    ]);
  }

  buildHttpHeaders() {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...this.httpHeaders
    };

    if (this.sessionId) {
      headers[SESSION_HEADER_NAME] = this.sessionId;
    }

    headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    return headers;
  }

  clearPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timerId);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  async start() {
    if (this.started) {
      return this;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.initialize();

    try {
      await this.startPromise;
      this.started = true;
      return this;
    } finally {
      this.startPromise = null;
    }
  }

  initialize() {
    if (this.transport === "http") {
      return this.initializeHttp();
    }

    if (!this.command) {
      throw createStatusError("MCP command is required", 400);
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      const child = spawn(this.command, this.args, {
        cwd: this.cwd || undefined,
        env: {
          ...process.env,
          ...this.env
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      this.child = child;
      this.buffer = Buffer.alloc(0);

      const finish = (error) => {
        if (resolved) {
          return;
        }

        resolved = true;

        if (error) {
          reject(error);
          return;
        }

        resolve(this);
      };

      const startupTimer = setTimeout(() => {
        const error = createStatusError(
          `MCP server ${this.name || this.command} startup timed out`,
          504
        );
        this.close().finally(() => finish(error));
      }, this.startupTimeoutMs);

      child.stdout.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, toBuffer(chunk)]);
        this.processBuffer();
      });

      child.stderr.on("data", (chunk) => {
        const text = String(chunk ?? "").trim();
        if (text.length > 0) {
          child._mcpLastStderr = `${child._mcpLastStderr ?? ""}${text}\n`;
        }
      });

      child.on("error", (error) => {
        clearTimeout(startupTimer);
        this.clearPendingRequests(error);
        finish(error);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        const exitError = createStatusError(
          `MCP server ${this.name || this.command} exited with code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`,
          502
        );
        this.clearPendingRequests(exitError);
        this.started = false;
        this.child = null;

        if (!resolved) {
          finish(exitError);
        }
      });

      this.sendRequest("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        clientInfo: {
          name: "yyz-agent-console",
          version: "0.1.0"
        }
      })
        .then(() => {
          clearTimeout(startupTimer);
          this.notify("notifications/initialized", {}).catch(() => {
            // Some servers don't need the notification.
          });
          finish();
        })
        .catch((error) => {
          clearTimeout(startupTimer);
          this.close().finally(() => finish(error));
        });
    });
  }

  async initializeHttp() {
    const result = await this.sendHttpRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        clientInfo: {
          name: "yyz-agent-console",
          version: "0.1.0"
        }
      },
      {
        expectResponse: true,
        allowRetry: false,
        timeoutMs: this.startupTimeoutMs
      }
    );

    if (result?.sessionId) {
      this.sessionId = result.sessionId;
    }

    await this.notify("notifications/initialized", {}).catch(() => {
      // Some servers do not require this notification.
    });

    return this;
  }

  parseMessage(rawMessage) {
    try {
      return JSON.parse(rawMessage);
    } catch {
      return null;
    }
  }

  processBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n", "utf8"));
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);

      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      const totalLength = headerEnd + 4 + contentLength;

      if (this.buffer.length < totalLength) {
        return;
      }

      const body = this.buffer.slice(headerEnd + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.slice(totalLength);
      const message = this.parseMessage(body);

      if (message) {
        this.dispatchMessage(message);
      }
    }
  }

  dispatchMessage(message) {
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return;
    }

    const pending = this.pendingRequests.get(String(message.id));
    if (!pending) {
      return;
    }

    clearTimeout(pending.timerId);
    this.pendingRequests.delete(String(message.id));

    if (message.error) {
      const error = createStatusError(
        String(message.error?.message ?? "MCP request failed"),
        Number(message.error?.code ?? 500)
      );
      error.data = message.error?.data;
      pending.reject(error);
      return;
    }

    pending.resolve(message.result);
  }

  async sendHttpRequest(method, params = undefined, options = {}) {
    if (!this.url) {
      throw createStatusError("MCP url is required for http transport", 400);
    }

    const payload = {
      jsonrpc: "2.0"
    };

    if (method) {
      payload.method = method;
    }

    if (typeof params !== "undefined") {
      payload.params = params;
    }

    if (method !== "notifications/initialized" && method !== "notifications/cancelled") {
      payload.id = String(this.nextId++);
    }

    const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : this.requestTimeoutMs;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.buildHttpHeaders(),
        body: JSON.stringify(payload),
        signal: abortController.signal
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const error = createStatusError(
          `MCP HTTP request failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText.slice(0, 240)}` : ""}`,
          response.status >= 500 ? 502 : response.status
        );
        throw error;
      }

      const responseSessionId =
        response.headers.get(SESSION_HEADER_NAME) ||
        response.headers.get(SESSION_HEADER_NAME.toUpperCase()) ||
        "";

      if (options.expectResponse === false) {
        return {
          ok: true,
          sessionId: responseSessionId
        };
      }

      const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
      let messages = [];

      if (contentType.includes("text/event-stream")) {
        messages = await readStreamMessages(response, payload.id);
      } else if (contentType.includes("application/json") || contentType.includes("text/json")) {
        const json = await response.json();
        messages = Array.isArray(json) ? json : [json];
      } else {
        const text = await response.text();
        const parsed = parseJsonSafe(text) ?? { result: text };
        messages = Array.isArray(parsed) ? parsed : [parsed];
      }

      if (payload.id === undefined) {
        return {
          ok: true,
          sessionId: responseSessionId
        };
      }

      const requestId = String(payload.id);
      const matched = messages.find((message) => String(message?.id ?? "") === requestId);
      if (!matched) {
        return {
          ok: true,
          result: null,
          sessionId: responseSessionId
        };
      }

      if (matched.error) {
        const error = createStatusError(
          String(matched.error?.message ?? "MCP request failed"),
          Number(matched.error?.code ?? 500)
        );
        error.data = matched.error?.data;
        throw error;
      }

      return {
        ok: true,
        result: matched.result ?? null,
        sessionId: responseSessionId
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  sendRequest(method, params = undefined, timeoutMs = this.requestTimeoutMs) {
    if (this.transport === "http") {
      return this.sendHttpRequest(method, params, { timeoutMs }).then((response) => response.result);
    }

    if (!this.child || !this.child.stdin || this.closed) {
      return Promise.reject(createStatusError("MCP client is not started", 500));
    }

    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(createStatusError(`MCP request timed out: ${method}`, 504));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timerId
      });

      const payload = {
        jsonrpc: "2.0",
        id,
        method
      };

      if (typeof params !== "undefined") {
        payload.params = params;
      }

      this.child.stdin.write(this.buildHeaderBuffer(payload));
    });
  }

  async notify(method, params = undefined) {
    if (this.transport === "http") {
      await this.sendHttpRequest(method, params, {
        timeoutMs: this.requestTimeoutMs,
        expectResponse: false
      }).catch(() => {});
      return;
    }

    if (!this.child || !this.child.stdin || this.closed) {
      throw createStatusError("MCP client is not started", 500);
    }

    const payload = {
      jsonrpc: "2.0",
      method
    };

    if (typeof params !== "undefined") {
      payload.params = params;
    }

    this.child.stdin.write(this.buildHeaderBuffer(payload));
  }

  async listTools() {
    await this.start();
    const result = await this.sendRequest("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(toolName, args = {}) {
    await this.start();
    return this.sendRequest("tools/call", {
      name: toolName,
      arguments: args
    });
  }

  isHealthy() {
    if (this.transport === "http") {
      return this.started && !this.closed;
    }

    return Boolean(this.started && !this.closed && this.child);
  }

  async close() {
    this.closed = true;

    if (this.transport === "http") {
      this.sessionId = "";
      this.started = false;
      this.clearPendingRequests(createStatusError("MCP client closed", 499));
      return;
    }

    if (this.child) {
      const child = this.child;
      this.child = null;

      try {
        child.stdin?.end();
      } catch {
        // Ignore shutdown errors.
      }

      try {
        child.kill();
      } catch {
        // Ignore shutdown errors.
      }
    }

    this.clearPendingRequests(createStatusError("MCP client closed", 499));
  }
}
