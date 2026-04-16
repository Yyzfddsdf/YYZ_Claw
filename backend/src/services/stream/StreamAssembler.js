function formatToolSection(toolOutputs) {
  if (toolOutputs.length === 0) {
    return "";
  }

  const lines = toolOutputs.map((item, index) => {
    const title = `[${index + 1}] ${item.toolName}`;
    return `${title}\n${item.content}`;
  });

  return `\n\n[Tool Outputs]\n${lines.join("\n\n")}`;
}

export class StreamAssembler {
  constructor() {
    this.assistantText = "";
    this.toolOutputs = [];
  }

  appendAssistantToken(token) {
    this.assistantText += token;
  }

  appendToolResult(toolName, content) {
    this.toolOutputs.push({ toolName, content });
  }

  getMergedText() {
    return `${this.assistantText}${formatToolSection(this.toolOutputs)}`;
  }

  snapshot() {
    return {
      assistantText: this.assistantText,
      toolOutputs: [...this.toolOutputs],
      mergedText: this.getMergedText()
    };
  }
}
