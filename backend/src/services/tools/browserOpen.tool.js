import { browserOpen } from "./browserToolShared.js";

export default {
  name: "browser_open",
  description: "Launch a visible Edge/Chrome browser session and optionally open a URL.",
  parameters: {
    type: "object",
    properties: {
      browser: {
        type: "string",
        enum: ["auto", "edge", "chrome"],
        description: "Preferred browser type."
      },
      url: {
        type: "string",
        description: "Optional URL to open."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserOpen(args, executionContext);
  }
};

