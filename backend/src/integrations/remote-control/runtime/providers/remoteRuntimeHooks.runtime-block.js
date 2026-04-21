export default {
  name: "remote_runtime_hooks_block",
  description:
    "Build runtime hook block for remote-control turns from remote hook definitions.",
  priority: 190,
  resolve(scope, context = {}) {
    const remoteHookBlockBuilder = context?.services?.remoteHookBlockBuilder ?? null;
    if (!remoteHookBlockBuilder || typeof remoteHookBlockBuilder.build !== "function") {
      return null;
    }

    const result = remoteHookBlockBuilder.build(scope, context?.executionContext ?? {});
    if (!Array.isArray(result?.hooks) || result.hooks.length === 0) {
      return null;
    }

    return {
      type: "remote_runtime_hooks",
      source: "hook",
      channel: "current_user",
      priority: 190,
      level: result.level,
      wrapper: result.wrapper,
      header: result.header,
      bodyLines: result.bodyLines,
      tags: ["remote", "runtime", "hooks"],
      metadata: {
        hookCount: result.hooks.length,
        hookNames: result.hooks.map((hook) => hook.name)
      }
    };
  }
};
