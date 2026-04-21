import {
  isLegacyToolResultEnvelope,
  isRemoteToolResultEnvelope,
  normalizeRemoteToolResultHooks,
  withRemoteToolResultHooks
} from "./remoteToolResultHooks.js";

function convertResultEnvelope(rawResult) {
  if (isRemoteToolResultEnvelope(rawResult)) {
    return rawResult;
  }

  if (isLegacyToolResultEnvelope(rawResult)) {
    return withRemoteToolResultHooks(
      rawResult.result,
      normalizeRemoteToolResultHooks(rawResult.hooks),
      Array.isArray(rawResult.imageAttachments) ? rawResult.imageAttachments : []
    );
  }

  return rawResult;
}

export function wrapSharedToolWithRemoteHooks(sharedTool) {
  if (!sharedTool || typeof sharedTool !== "object") {
    throw new Error("sharedTool is required");
  }

  return {
    name: String(sharedTool.name ?? "").trim(),
    description: String(sharedTool.description ?? "").trim(),
    parameters:
      sharedTool.parameters && typeof sharedTool.parameters === "object" ? sharedTool.parameters : {},
    async execute(args = {}, executionContext = {}) {
      const rawResult = await sharedTool.execute(args, executionContext);
      return convertResultEnvelope(rawResult);
    }
  };
}

