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

function isRuntimeHookUserMessageBlock(block) {
  const type = String(block?.type ?? "").trim().toLowerCase();
  return type === "runtime_hooks" || type === "remote_runtime_hooks";
}

function buildRuntimeHookUserMessages(blocks = []) {
  return blocks
    .map((block) => {
      const content = String(block?.content ?? "").trim();
      if (!content) {
        return null;
      }

      return {
        role: "user",
        content
      };
    })
    .filter(Boolean);
}

function injectUserMessagesAfterTurn(conversation = [], currentTurnUserIndex = -1, userMessages = []) {
  if (!Array.isArray(userMessages) || userMessages.length === 0) {
    return conversation;
  }

  if (!Number.isInteger(currentTurnUserIndex) || currentTurnUserIndex < 0) {
    return [...conversation, ...userMessages];
  }

  const insertIndex = Math.min(conversation.length, currentTurnUserIndex + 1);
  return [
    ...conversation.slice(0, insertIndex),
    ...userMessages,
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
    const currentUserMessageBlocks = currentUserBlocks.filter(isRuntimeHookUserMessageBlock);
    const currentUserInlineBlocks = currentUserBlocks.filter(
      (block) => !isRuntimeHookUserMessageBlock(block)
    );

    let apiConversation = conversation.map((message, index) => {
      if (
        currentUserInlineBlocks.length === 0 ||
        index !== currentTurnUserIndex ||
        String(message?.role ?? "").trim() !== "user"
      ) {
        return message;
      }

      const apiMessage = cloneValueForApi(message);
      const injectedText = currentUserInlineBlocks
        .map((block) => String(block?.content ?? "").trim())
        .filter((content) => content.length > 0)
        .join("\n\n");
      apiMessage.content = injectTextIntoMessageContent(apiMessage.content, injectedText);
      return apiMessage;
    });

    const injectedUserMessages = buildRuntimeHookUserMessages(currentUserMessageBlocks);
    apiConversation = injectUserMessagesAfterTurn(
      apiConversation,
      currentTurnUserIndex,
      injectedUserMessages
    );
    apiConversation = injectSystemBlocks(apiConversation, systemBlocks);
    return apiConversation;
  }
}
