import fs from "node:fs/promises";

import { ChatAgent } from "../agent/ChatAgent.js";
import { HookBlockBuilder } from "../hooks/HookBlockBuilder.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { RuntimeBlockRuntime } from "../runtime/RuntimeBlockRuntime.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ScopedToolRegistry } from "../tools/ScopedToolRegistry.js";

async function directoryExists(dirPath = "") {
  if (!dirPath) {
    return false;
  }

  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export class AgentRuntimeFactory {
  constructor(options = {}) {
    this.baseToolRegistry = options.baseToolRegistry ?? null;
    this.baseHookRegistry = options.baseHookRegistry ?? null;
    this.sharedSubagentToolsDir = options.sharedSubagentToolsDir ?? "";
    this.approvalRulesStore = options.approvalRulesStore ?? null;
    this.longTermMemoryRecallService = options.longTermMemoryRecallService ?? null;
    this.runtimeBlockRegistry = options.runtimeBlockRegistry ?? null;
    this.runtimeScopeBuilder = options.runtimeScopeBuilder ?? null;
    this.runtimeInjectionComposer = options.runtimeInjectionComposer ?? null;
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
    this.baseDelayMs = Number.isInteger(options.baseDelayMs) ? options.baseDelayMs : 500;
    this.maxDelayMs = Number.isInteger(options.maxDelayMs) ? options.maxDelayMs : 5000;
    this.runtimeCache = new Map();
  }

  async createRuntime(definition) {
    const cacheKey = String(definition?.agentType ?? "").trim().toLowerCase();
    if (cacheKey && this.runtimeCache.has(cacheKey)) {
      return this.runtimeCache.get(cacheKey);
    }

    const extraToolRegistry = new ToolRegistry();
    if (await directoryExists(this.sharedSubagentToolsDir)) {
      await extraToolRegistry.autoRegisterFromDir(this.sharedSubagentToolsDir);
    }
    if (await directoryExists(definition?.toolsDir)) {
      await extraToolRegistry.autoRegisterFromDir(definition.toolsDir);
    }

    const hookRegistry = new HookRegistry();
    for (const hook of this.baseHookRegistry?.listHooks?.() ?? []) {
      const hookName = String(hook?.name ?? "").trim();
      if (
        hookName &&
        Array.isArray(definition?.inheritedBaseHookNames) &&
        definition.inheritedBaseHookNames.includes(hookName)
      ) {
        hookRegistry.register(hook);
      }
    }
    if (await directoryExists(definition?.hooksDir)) {
      await hookRegistry.autoRegisterFromDir(definition.hooksDir);
    }

    const hookBlockBuilder = new HookBlockBuilder({
      hookRegistry,
      maxHooks: 3,
      maxBlockChars: 1800
    });
    const runtimeBlockRuntime = new RuntimeBlockRuntime({
      blockRegistry: this.runtimeBlockRegistry,
      scopeBuilder: this.runtimeScopeBuilder,
      services: {
        hookBlockBuilder
      },
      maxSystemBlocks: 3,
      maxSystemChars: 2400,
      maxCurrentUserBlocks: 2,
      maxCurrentUserChars: 12000
    });
    const toolRegistry = new ScopedToolRegistry({
      baseRegistry: this.baseToolRegistry,
      extraRegistry: extraToolRegistry,
      inheritedBaseToolNames: definition?.inheritedBaseToolNames ?? []
    });

    const chatAgent = new ChatAgent({
      toolRegistry,
      approvalRulesStore: this.approvalRulesStore,
      longTermMemoryRecallService: this.longTermMemoryRecallService,
      runtimeBlockRuntime,
      runtimeInjectionComposer: this.runtimeInjectionComposer,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs
    });

    const runtime = {
      definition,
      toolRegistry,
      hookRegistry,
      hookBlockBuilder,
      runtimeBlockRuntime,
      chatAgent,
      definitionSystemPrompt: String(definition?.prompt ?? "").trim()
    };

    if (cacheKey) {
      this.runtimeCache.set(cacheKey, runtime);
    }

    return runtime;
  }

  invalidate(agentType = "") {
    const cacheKey = String(agentType ?? "").trim().toLowerCase();
    if (cacheKey) {
      this.runtimeCache.delete(cacheKey);
    }
  }
}
