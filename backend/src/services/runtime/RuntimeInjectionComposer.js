function cloneValueForApi(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function injectTextIntoMessageContent(content, injectedText) {
  const normalizedInjection = String(injectedText ?? "").trim();
  if (!normalizedInjection) {
    return content;
  }

  if (Array.isArray(content)) {
    const nextContent = cloneValueForApi(content);
    const textPart = {
      type: "text",
      text: normalizedInjection
    };
    const firstNonTextIndex = nextContent.findIndex(
      (part) => String(part?.type ?? "").trim() && String(part?.type ?? "").trim() !== "text"
    );

    if (firstNonTextIndex < 0) {
      nextContent.push(textPart);
    } else {
      nextContent.splice(firstNonTextIndex, 0, textPart);
    }

    return nextContent;
  }

  const baseContent = typeof content === "string" ? content : "";
  return baseContent ? `${baseContent}\n\n${normalizedInjection}` : normalizedInjection;
}

function injectSystemBlocks(conversation = [], systemBlocks = []) {
  if (!Array.isArray(systemBlocks) || systemBlocks.length === 0) {
    return conversation;
  }

  const injectedMessages = systemBlocks
    .map((block) => String(block?.content ?? "").trim())
    .filter((content) => content.length > 0)
    .map((content) => ({
      role: "system",
      content
    }));

  if (injectedMessages.length === 0) {
    return conversation;
  }

  const insertIndex = conversation.findIndex(
    (message) => String(message?.role ?? "").trim() !== "system"
  );

  if (insertIndex < 0) {
    return [...conversation, ...injectedMessages];
  }

  return [
    ...conversation.slice(0, insertIndex),
    ...injectedMessages,
    ...conversation.slice(insertIndex)
  ];
}

export class RuntimeInjectionComposer {
  compose(conversation = [], options = {}) {
    const currentTurnUserIndex = Number.isInteger(options.currentTurnUserIndex)
      ? options.currentTurnUserIndex
      : -1;
    const runtimeBlocks = options.runtimeBlocks ?? {};
    const systemBlocks = Array.isArray(runtimeBlocks?.system) ? runtimeBlocks.system : [];
    const currentUserBlocks = Array.isArray(runtimeBlocks?.current_user)
      ? runtimeBlocks.current_user
      : [];

    let apiConversation = conversation.map((message, index) => {
      if (
        currentUserBlocks.length === 0 ||
        index !== currentTurnUserIndex ||
        String(message?.role ?? "").trim() !== "user"
      ) {
        return message;
      }

      const apiMessage = cloneValueForApi(message);
      const injectedText = currentUserBlocks
        .map((block) => String(block?.content ?? "").trim())
        .filter((content) => content.length > 0)
        .join("\n\n");
      apiMessage.content = injectTextIntoMessageContent(apiMessage.content, injectedText);
      return apiMessage;
    });

    apiConversation = injectSystemBlocks(apiConversation, systemBlocks);
    return apiConversation;
  }
}
