import {
  createToolResultHook,
  withToolResultHooks
} from "./toolResultHooks.js";
import { createWebProvider } from "../web/webProviderFactory.js";

export default {
  name: "web_fetch",
  description: "Fetch and extract readable content from a URL.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Target URL."
      }
    },
    required: ["url"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const provider = createWebProvider(executionContext);
    const result = await provider.fetch(args);
    return withToolResultHooks(result, [
      createToolResultHook({
        type: "runtime_hint",
        level: "info",
        message: "已抓取网页正文"
      })
    ]);
  }
};

