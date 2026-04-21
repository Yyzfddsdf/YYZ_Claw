import { browserVision } from "./browserToolShared.js";

export default {
  name: "browser_vision",
  description: "Capture screenshot with compact visual reasoning context for next model step.",
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
    return browserVision(args, executionContext);
  }
};

