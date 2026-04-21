import { browserScreenshot } from "./browserToolShared.js";

export default {
  name: "browser_screenshot",
  description: "Capture a screenshot from current browser page.",
  parameters: {
    type: "object",
    properties: {
      fullPage: {
        type: "boolean",
        description: "Capture full page when true."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserScreenshot(args, executionContext);
  }
};

