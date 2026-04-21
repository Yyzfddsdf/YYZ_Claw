import { browserClick } from "./browserToolShared.js";

export default {
  name: "browser_click",
  description: "Click a DOM element by CSS selector.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of target element."
      },
      text: {
        type: "string",
        description: "Visible text to locate link/button."
      },
      hrefContains: {
        type: "string",
        description: "Substring that should appear in link href."
      },
      x: {
        type: "number",
        description: "Fallback click X coordinate in current viewport."
      },
      y: {
        type: "number",
        description: "Fallback click Y coordinate in current viewport."
      },
      timeoutMs: {
        type: "integer",
        description: "Wait timeout for element in milliseconds."
      }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserClick(args, executionContext);
  }
};
