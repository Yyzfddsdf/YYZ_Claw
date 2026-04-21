import { browserScroll } from "./browserToolShared.js";

export default {
  name: "browser_scroll",
  description: "Scroll current page by x/y offset.",
  parameters: {
    type: "object",
    properties: {
      x: {
        type: "number",
        description: "Horizontal scroll offset."
      },
      y: {
        type: "number",
        description: "Vertical scroll offset."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserScroll(args, executionContext);
  }
};

