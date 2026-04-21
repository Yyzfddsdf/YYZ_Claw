export default {
  name: "remote_parsed_files_grounding",
  description:
    "Remind the model that remote uploaded file extracts are hidden context and should be used to ground factual output.",
  priority: 110,
  evaluate(scope) {
    const currentUserMeta =
      scope?.currentUserMessage?.meta && typeof scope.currentUserMessage.meta === "object"
        ? scope.currentUserMessage.meta
        : {};
    const parsedFiles = Array.isArray(currentUserMeta.parsedFiles) ? currentUserMeta.parsedFiles : [];

    if (parsedFiles.length === 0) {
      return null;
    }

    return {
      type: "remote_parsed_files_grounding",
      source: "message",
      level: "info",
      priority: 110,
      tags: ["remote", "files", "grounding"],
      message:
        "Remote uploaded file extracts are hidden supporting context. Ground factual claims in those extracts before relying on assumptions."
    };
  }
};

