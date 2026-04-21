import { browserType } from "./browserToolShared.js";

export default {
  name: "browser_type",
  description: "Type text into an element by CSS selector.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of input element."
      },
      text: {
        type: "string",
        description: "Text to type."
      },
      clear: {
        type: "boolean",
        description: "Clear target input before typing."
      },
      pressEnter: {
        type: "boolean",
        description: "Press Enter after typing."
      }
    },
    required: ["selector", "text"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserType(args, executionContext);
  }
};

