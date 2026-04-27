import { browserCommand } from "./browserToolShared.js";

export default {
  name: "browser_command",
  description:
    [
      "Run a safe sequence of page operation actions in the active visible browser session.",
      "Use browser_open/browser_close for lifecycle, browser_snapshot for observation, browser_screenshot for saved screenshots, and browser_vision for visual model input.",
      "Action args reference:",
      "- navigate: open a URL in the current browser page. required: url. optional: browser ('auto'|'edge'|'chrome'). Example args: { url: 'http://localhost:3000' }",
      "- click: click a visible element. required: at least one of selector, text, hrefContains, or both x and y. optional: timeoutMs. Prefer text for visible buttons/links, selector for precise DOM targets, x/y only as fallback.",
      "- type: fill text into an input/textarea/contenteditable target. required: selector, text. optional: clear (default true), pressEnter (default false). Example args: { selector: 'input[name=email]', text: 'a@b.com', pressEnter: true }",
      "- scroll: scroll the current page by a pixel offset. required: none. optional: x (default 0), y (default 600).",
      "- wait: wait for time or for a selector to appear. required: none. optional: timeoutMs (default 1500), selector. With selector waits for it; without selector waits by time.",
      "- console: inspect recent browser console logs and uncaught page errors. required: none. optional: limit (default 80), clear (default false).",
      "- network: inspect recent failed requests and HTTP 4xx/5xx responses. required: none. optional: limit (default 80), clear (default false).",
      "- storage: inspect current page cookies, localStorage, and sessionStorage. required: none. optional: cookies (default true), localStorage (default true), sessionStorage (default true).",
      "- storage_clear: clear current page/session browser storage. required: none. optional: cookies (default false), localStorage (default true), sessionStorage (default true).",
      "Example: { steps: [{ action: 'navigate', args: { url: 'http://localhost:3000' } }, { action: 'click', args: { text: 'Login' } }, { action: 'console', args: { limit: 20 } }] }"
    ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "navigate",
                "click",
                "type",
                "scroll",
                "wait",
                "console",
                "network",
                "storage",
                "storage_clear"
              ],
              description: "Safe browser action to run."
            },
            args: {
              type: "object",
              description: "Arguments for the selected browser action."
            }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    },
    required: ["steps"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return browserCommand(args, executionContext);
  }
};
