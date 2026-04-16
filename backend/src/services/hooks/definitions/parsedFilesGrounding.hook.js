export default {
  name: "parsed_files_grounding",
  description:
    "Remind the model that uploaded file extracts are hidden supporting context that should ground factual answers when relevant.",
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
      type: "parsed_files_grounding",
      source: "message",
      level: "info",
      priority: 110,
      tags: ["files", "grounding"],
      message:
        "Uploaded file extracts are hidden supporting context. When the files are relevant, ground factual claims in them before relying on assumptions or recalled memory."
    };
  }
};
