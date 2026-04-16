import { getOrchestratorSupervisor } from "./orchestrationToolShared.js";

export default {
  name: "subagent_types_list",
  description:
    "List all available subagent types currently registered in the system. Call this before subagent_create when you need to know which agentType values are valid.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute(_args = {}, executionContext = {}) {
    const supervisor = getOrchestratorSupervisor(executionContext);
    const subagentTypes = supervisor.listAvailableSubagentTypes();

    return {
      subagentTypes,
      total: subagentTypes.length
    };
  }
};
