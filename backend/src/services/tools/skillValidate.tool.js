export default {
  name: "skill_validate",
  description:
    "Validate a skill directory against the local skills protocol and return errors or warnings.",
    parameters: {
    type: "object",
    properties: {
      workspacePath: {
        type: "string",
        description: "Optional workspace path used to resolve project-level skills."
      },
      skillName: {
        type: "string",
        description: "Skill name, skillKey, relative path, or directory basename."
      }
    },
    required: ["skillName"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const skillValidator = executionContext.skillValidator;

    if (!skillValidator || typeof skillValidator.validate !== "function") {
      throw new Error("skill validator is not available");
    }

    const workspacePath =
      args.workspacePath ??
      executionContext.workspacePath ??
      executionContext.workplacePath ??
      executionContext.workingDirectory;

    return skillValidator.validate(args.skillName, {
      workspacePath
    });
  }
};
