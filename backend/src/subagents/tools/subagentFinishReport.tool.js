import {
  readOptionalText,
  readStringArray
} from "../../services/tools/orchestrationToolShared.js";
import { recordSubagentFinishReport } from "../../services/orchestration/subagentCompletionShared.js";

export default {
  name: "subagent_finish_report",
  description:
    "Register the final completion handoff for the current subagent turn. Keep it concise and only include the final handoff facts needed by the primary agent.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short final handoff title."
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
        description: "Essential final detail bullets only. No filler or repeated background."
      }
    },
    required: ["title", "detailLines"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    return recordSubagentFinishReport(executionContext, {
      title: readOptionalText(args.title),
      summaryLines: readStringArray(args.summaryLines),
      detailLines: readStringArray(args.detailLines)
    });
  }
};
