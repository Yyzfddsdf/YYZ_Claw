import {
  createToolResultHook,
  withToolResultHooks
} from "./toolResultHooks.js";
import { createWebProvider } from "../web/webProviderFactory.js";

export default {
  name: "web_search",
  description: "Search the web and return structured results.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query text."
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (1-10)."
      },
      searchDepth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Search depth."
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
        description: "Search topic bias."
      }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const provider = createWebProvider(executionContext);
    const result = await provider.search(args);
    return withToolResultHooks(result, [
      createToolResultHook({
        type: "runtime_hint",
        level: "info",
        message: `已完成联网搜索：${result.results.length} 条结果`
      })
    ]);
  }
};

