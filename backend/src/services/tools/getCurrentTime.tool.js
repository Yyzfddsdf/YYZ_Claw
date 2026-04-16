export default {
  name: "get_current_time",
  description: "Get current date time with optional IANA timezone.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, for example Asia/Shanghai"
      }
    },
    additionalProperties: false
  },
  async execute(args = {}) {
    const timezone =
      typeof args.timezone === "string" && args.timezone.trim().length > 0
        ? args.timezone.trim()
        : "Asia/Shanghai";

    const now = new Date();

    try {
      return {
        timezone,
        iso: now.toISOString(),
        local: now.toLocaleString("zh-CN", { timeZone: timezone })
      };
    } catch {
      return {
        timezone: "UTC",
        iso: now.toISOString(),
        local: now.toLocaleString("zh-CN", { timeZone: "UTC" })
      };
    }
  }
};
