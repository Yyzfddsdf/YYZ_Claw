import { browserNavigate } from "./browserToolShared.js";

export default {
  name: "browser_navigate",
  description: "Navigate current browser session to a URL.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to navigate to."
      },
      browser: {
        type: "string",
        enum: ["auto", "edge", "chrome"],
        description: "Preferred browser type for first launch."
      }
    },
    required: ["url"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserNavigate(args, executionContext);
  }
};

