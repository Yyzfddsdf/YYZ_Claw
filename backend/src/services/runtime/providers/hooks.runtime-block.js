export default {
  name: "runtime_hooks_block",
  description:
    "Build runtime hook block from registered runtime hooks and inject it into the current turn.",
  priority: 180,
  resolve(scope, context = {}) {
    const hookBlockBuilder = context?.services?.hookBlockBuilder ?? null;
    if (!hookBlockBuilder || typeof hookBlockBuilder.build !== "function") {
      return null;
    }

    const result = hookBlockBuilder.build(scope, context?.executionContext ?? {});
    if (!Array.isArray(result?.hooks) || result.hooks.length === 0) {
      return null;
    }

    return {
      type: "runtime_hooks",
      source: "hook",
      channel: "current_user",
      priority: 180,
      level: result.level,
      wrapper: result.wrapper,
      header: result.header,
      bodyLines: result.bodyLines,
      tags: ["runtime", "hooks"],
      metadata: {
        hookCount: result.hooks.length,
        hookNames: result.hooks.map((hook) => hook.name)
      }
    };
  }
};
