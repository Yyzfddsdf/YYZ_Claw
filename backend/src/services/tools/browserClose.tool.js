import { browserClose } from "./browserToolShared.js";

export default {
  name: "browser_close",
  description: "Close active browser session for current conversation.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserClose(args, executionContext);
  }
};

