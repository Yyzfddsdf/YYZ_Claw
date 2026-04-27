import { browserScreenshot } from "./browserToolShared.js";

export default {
  name: "browser_screenshot",
  description: "Capture current browser page as a PNG file saved to the workspace or a specified path.",
  parameters: {
    type: "object",
    properties: {
      fullPage: {
        type: "boolean",
        description: "Capture full page when true."
      },
      outputPath: {
        type: "string",
        description: "Optional output file or directory path. Relative paths resolve from the workspace root."
      },
      fileName: {
        type: "string",
        description: "Optional PNG file name when outputPath is omitted or points to a directory."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserScreenshot(args, executionContext);
  }
};
