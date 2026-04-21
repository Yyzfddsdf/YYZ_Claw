import { browserSnapshot } from "./browserToolShared.js";

export default {
  name: "browser_snapshot",
  description: "Get a text snapshot of current browser page content and interactive elements.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserSnapshot(args, executionContext);
  }
};

