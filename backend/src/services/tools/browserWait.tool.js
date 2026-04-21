import { browserWait } from "./browserToolShared.js";

export default {
  name: "browser_wait",
  description: "Wait for timeout or selector to appear in the browser page.",
  parameters: {
    type: "object",
    properties: {
      timeoutMs: {
        type: "integer",
        description: "Wait time in milliseconds."
      },
      selector: {
        type: "string",
        description: "Optional CSS selector to wait for."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserWait(args, executionContext);
  }
};

