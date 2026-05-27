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

function normalizeQuestionItem(question, index = 0) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    return null;
  }

  const id = normalizeString(question.id) || `question_${index + 1}`;
  const prompt = normalizeString(question.question);
  if (!prompt) {
    return null;
  }

  return {
    id,
    question: prompt,
    options: normalizeOptions(question.options),
    allowAdditionalText: Boolean(question.allowAdditionalText ?? true),
    selectedOption: normalizeString(question.selectedOption),
    additionalText: normalizeString(question.additionalText)
  };
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions
    .map((item, index) => normalizeQuestionItem(item, index))
    .filter(Boolean)
    .slice(0, 8);
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
      questions: {
        type: "array",
        description: "Optional multi-question clarification form.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string"
            },
            question: {
              type: "string"
            },
            options: {
              type: "array",
              items: {
                type: "string"
              }
            },
            allowAdditionalText: {
              type: "boolean"
            },
            selectedOption: {
              type: "string"
            },
            additionalText: {
              type: "string"
            }
          },
          required: ["question"],
          additionalProperties: false
        }
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
      },
      answers: {
        type: "array",
        description: "Structured answers for multi-question clarify.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string"
            },
            selectedOption: {
              type: "string"
            },
            additionalText: {
              type: "string"
            }
          },
          additionalProperties: false
        }
      }
    },
    anyOf: [
      { required: ["question"] },
      { required: ["questions"] }
    ],
    additionalProperties: false
  },
  async execute(args = {}) {
    const question = normalizeString(args.question);
    const questions = normalizeQuestions(args.questions);
    const options = normalizeOptions(args.options);
    const allowAdditionalText = Boolean(args.allowAdditionalText ?? true);
    const selectedOption = normalizeString(args.selectedOption);
    const additionalText = normalizeString(args.additionalText);
    const answerMap = new Map(
      Array.isArray(args.answers)
        ? args.answers
            .map((item) => ({
              id: normalizeString(item?.id),
              selectedOption: normalizeString(item?.selectedOption),
              additionalText: normalizeString(item?.additionalText)
            }))
            .filter((item) => item.id)
            .map((item) => [item.id, item])
        : []
    );

    if (questions.length > 0) {
      const normalizedQuestions = questions.map((item) => {
        const answer = answerMap.get(item.id) ?? {};
        const mergedSelection = normalizeString(answer.selectedOption || item.selectedOption);
        const mergedAdditionalText = normalizeString(answer.additionalText || item.additionalText);

        return {
          ...item,
          selectedOption: mergedSelection,
          additionalText: mergedAdditionalText,
          answered: Boolean(mergedSelection || mergedAdditionalText)
        };
      });

      const answers = normalizedQuestions.map((item) => ({
        id: item.id,
        selectedOption: item.selectedOption,
        additionalText: item.additionalText
      }));
      const answerSummaryParts = normalizedQuestions
        .filter((item) => item.answered)
        .map((item) => {
          const pieces = [];
          if (item.selectedOption) {
            pieces.push(`选择：${item.selectedOption}`);
          }
          if (item.additionalText) {
            pieces.push(`补充：${item.additionalText}`);
          }
          return `${item.question}（${pieces.join("；")}）`;
        });
      const answerSummary =
        answerSummaryParts.length > 0
          ? answerSummaryParts.join("；")
          : "用户未提供额外澄清信息。";

      return {
        questions: normalizedQuestions,
        answers,
        answered: normalizedQuestions.every((item) => item.answered),
        answerSummary,
        userResponse: answerSummary
      };
    }

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

