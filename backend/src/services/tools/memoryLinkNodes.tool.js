import { getMemoryStore, normalizeId, normalizeName } from "./memoryToolShared.js";

export default {
  name: "memory_link_nodes",
  description:
    "Create or update one relation between two long-term memory nodes. Only memory node to memory node relations are allowed.",
  parameters: {
    type: "object",
    properties: {
      fromNodeId: {
        type: "string",
        description: "One memory node id."
      },
      toNodeId: {
        type: "string",
        description: "Another memory node id."
      },
      relationType: {
        type: "string",
        description: "Relation type. Default is related_to."
      },
      reason: {
        type: "string",
        description: "Optional short reason for this relation."
      }
    },
    required: ["fromNodeId", "toNodeId"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const memoryStore = getMemoryStore(executionContext);
    const result = memoryStore.createNodeRelation({
      fromNodeId: normalizeId(args.fromNodeId),
      toNodeId: normalizeId(args.toNodeId),
      relationType: normalizeName(args.relationType) || "related_to",
      reason: typeof args.reason === "string" ? args.reason : ""
    });

    return {
      action: result.action,
      relation: result.relation
    };
  }
};
