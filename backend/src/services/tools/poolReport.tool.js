import {
  getAgentId,
  getConversationId,
  getCurrentAtomicStepId,
  getOrchestratorSupervisor,
  readOptionalText,
  readStringArray
} from "./orchestrationToolShared.js";

export default {
  name: "pool_report",
  description:
    "Publish a concise report into the shared pool. Keep titles and lines short, factual, and free of boilerplate.",
  parameters: {
    type: "object",
    properties: {
      subtype: {
        type: "string",
        description: "Optional report subtype."
      },
      title: {
        type: "string",
        description: "Short report title. Avoid filler words."
      },
      summaryLines: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Optional concise bullets. One fact per line."
      },
      detailLines: {
        type: "array",
        items: {
          type: "string"
        },
        description: "Essential detail bullets only. No prose paragraph."
      }
    },
    required: ["title", "detailLines"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const conversationId = getConversationId(executionContext);
    const sourceAgentId = getAgentId(executionContext);
    const atomicStepId = getCurrentAtomicStepId(executionContext);

    return supervisor.reportToPool({
      conversationId,
      sourceAgentId,
      atomicStepId,
      subtype: readOptionalText(args.subtype) || "agent_report",
      title: readOptionalText(args.title),
      summaryLines: readStringArray(args.summaryLines),
      detailLines: readStringArray(args.detailLines)
    });
  }
};
