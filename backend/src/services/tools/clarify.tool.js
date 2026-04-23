function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, 12);
}

export default {
  name: "clarify",
  description:
    "Ask the user a structured clarification question. This tool pauses the run and waits for user selection/extra details before continuing.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Clarification question shown to user."
      },
      options: {
        type: "array",
        description: "Optional single-choice options shown to user.",
        items: {
          type: "string"
        }
      },
      allowAdditionalText: {
        type: "boolean",
        description: "Whether user can add extra free-text details."
      },
      selectedOption: {
        type: "string",
        description: "User selected option. Filled during approval confirmation."
      },
      additionalText: {
        type: "string",
        description: "User free-text supplement. Filled during approval confirmation."
      }
    },
    required: ["question"],
    additionalProperties: false
  },
  async execute(args = {}) {
    const question = normalizeString(args.question);
    const options = normalizeOptions(args.options);
    const allowAdditionalText = Boolean(args.allowAdditionalText ?? true);
    const selectedOption = normalizeString(args.selectedOption);
    const additionalText = normalizeString(args.additionalText);

    const normalizedSelection =
      selectedOption && (options.length === 0 || options.includes(selectedOption))
        ? selectedOption
        : selectedOption;

    const answerParts = [];
    if (normalizedSelection) {
      answerParts.push(`用户选择：${normalizedSelection}`);
    }
    if (additionalText) {
      answerParts.push(`用户补充：${additionalText}`);
    }

    const answerSummary =
      answerParts.length > 0 ? answerParts.join("；") : "用户未提供额外澄清信息。";

    return {
      question,
      options,
      allowAdditionalText,
      selectedOption: normalizedSelection,
      additionalText,
      answered: Boolean(normalizedSelection || additionalText),
      answerSummary,
      userResponse: answerSummary
    };
  }
};

