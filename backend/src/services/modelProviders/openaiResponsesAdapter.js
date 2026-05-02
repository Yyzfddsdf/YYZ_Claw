function normalizeText(value) {
  return String(value ?? "");
}

function createChunk(delta = {}, finishReason = null, usage = null) {
  const chunk = {
    choices: [
      {
        index: 0,
        delta
      }
    ]
  };

  if (finishReason) {
    chunk.choices[0].finish_reason = finishReason;
  }

  if (usage) {
    chunk.usage = usage;
  }

  return chunk;
}

function normalizeResponsesUsage(usage = {}) {
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: totalTokens,
    prompt_tokens_details: usage.input_tokens_details
      ? {
          cached_tokens: Number(usage.input_tokens_details.cached_tokens ?? 0)
        }
      : null,
    completion_tokens_details: usage.output_tokens_details
      ? {
          reasoning_tokens: Number(usage.output_tokens_details.reasoning_tokens ?? 0)
        }
      : null
  };
}

function extractOutputText(item = {}) {
  if (item?.type !== "message") {
    return "";
  }

  return (Array.isArray(item.content) ? item.content : [])
    .map((part) => {
      if (part?.type === "output_text") {
        return normalizeText(part.text);
      }

      if (part?.type === "refusal") {
        return normalizeText(part.refusal);
      }

      return "";
    })
    .join("");
}

function extractReasoningText(item = {}) {
  if (item?.type !== "reasoning") {
    return "";
  }

  return (Array.isArray(item.summary) ? item.summary : [])
    .map((summary) => normalizeText(summary?.text))
    .join("");
}

function convertResponseToolCall(item = {}) {
  const id = normalizeText(item.call_id || item.id);
  const name = normalizeText(item.name);

  if (!id || !name) {
    return null;
  }

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: normalizeText(item.arguments || "{}")
    }
  };
}

function extractResponseParts(response = {}) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === "message") {
      textParts.push(extractOutputText(item));
      continue;
    }

    if (item?.type === "reasoning") {
      reasoningParts.push(extractReasoningText(item));
      continue;
    }

    if (item?.type === "function_call") {
      const toolCall = convertResponseToolCall(item);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }
  }

  return {
    content: textParts.join(""),
    reasoningContent: reasoningParts.join(""),
    toolCalls
  };
}

function mapIncompleteReason(reason) {
  if (reason === "max_output_tokens") {
    return "length";
  }

  if (reason === "content_filter") {
    return "content_filter";
  }

  return "stop";
}

function mapResponseFinishReason(response = {}, hasToolCalls = false) {
  if (hasToolCalls) {
    return "tool_calls";
  }

  if (response.status === "incomplete") {
    return mapIncompleteReason(response.incomplete_details?.reason);
  }

  if (response.status === "failed") {
    return "stop";
  }

  return "stop";
}

export function convertOpenAIResponseToCompletion(response = {}) {
  const parts = extractResponseParts(response);
  const message = {
    role: "assistant",
    content: parts.content
  };

  if (parts.toolCalls.length > 0) {
    message.tool_calls = parts.toolCalls;
  }

  if (parts.reasoningContent) {
    message.reasoning_content = parts.reasoningContent;
  }

  return {
    id: response.id,
    object: "chat.completion",
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapResponseFinishReason(response, parts.toolCalls.length > 0)
      }
    ],
    usage: normalizeResponsesUsage(response.usage)
  };
}

function getToolState(toolStates, outputIndex) {
  const index = Number.isInteger(outputIndex) ? outputIndex : 0;
  const current =
    toolStates.get(index) ?? {
      emittedStart: false,
      emittedArguments: "",
      emittedName: "",
      item: null
    };
  toolStates.set(index, current);
  return current;
}

function createToolStartChunk(index, item = {}) {
  return createChunk({
    tool_calls: [
      {
        index,
        id: normalizeText(item.call_id || item.id),
        type: "function",
        function: {
          name: normalizeText(item.name),
          arguments: ""
        }
      }
    ]
  });
}

function createToolArgumentsChunk(index, delta = "") {
  return createChunk({
    tool_calls: [
      {
        index,
        type: "function",
        function: {
          name: "",
          arguments: normalizeText(delta)
        }
      }
    ]
  });
}

function createStreamError(event = {}) {
  const responseError = event.response?.error;
  const message =
    event.message ||
    responseError?.message ||
    event.response?.incomplete_details?.reason ||
    "OpenAI Responses stream failed";
  return new Error(message);
}

export async function* convertOpenAIResponsesStreamToOpenAIChunks(stream) {
  const toolStates = new Map();
  let finalResponse = null;
  let hasToolCalls = false;

  for await (const event of stream) {
    if (event?.type === "response.output_text.delta" && event.delta) {
      yield createChunk({ content: event.delta });
      continue;
    }

    if (event?.type === "response.reasoning_summary_text.delta" && event.delta) {
      yield createChunk({ reasoning_content: event.delta });
      continue;
    }

    if (event?.type === "response.output_item.added" && event.item?.type === "function_call") {
      const index = Number.isInteger(event.output_index) ? event.output_index : 0;
      const state = getToolState(toolStates, index);
      state.item = event.item;
      state.emittedStart = true;
      state.emittedName = normalizeText(event.item.name);
      hasToolCalls = true;
      yield createToolStartChunk(index, event.item);
      continue;
    }

    if (event?.type === "response.function_call_arguments.delta") {
      const index = Number.isInteger(event.output_index) ? event.output_index : 0;
      const state = getToolState(toolStates, index);
      state.emittedArguments += normalizeText(event.delta);
      hasToolCalls = true;
      yield createToolArgumentsChunk(index, event.delta);
      continue;
    }

    if (event?.type === "response.function_call_arguments.done") {
      const index = Number.isInteger(event.output_index) ? event.output_index : 0;
      const state = getToolState(toolStates, index);
      const finalArguments = normalizeText(event.arguments);

      if (!state.emittedArguments && finalArguments) {
        state.emittedArguments = finalArguments;
        hasToolCalls = true;
        yield createToolArgumentsChunk(index, finalArguments);
      }
      continue;
    }

    if (event?.type === "response.output_item.done" && event.item?.type === "function_call") {
      const index = Number.isInteger(event.output_index) ? event.output_index : 0;
      const state = getToolState(toolStates, index);
      state.item = event.item;
      hasToolCalls = true;

      if (!state.emittedStart) {
        state.emittedStart = true;
        state.emittedName = normalizeText(event.item.name);
        yield createToolStartChunk(index, event.item);
      }

      if (!state.emittedName && event.item.name) {
        state.emittedName = normalizeText(event.item.name);
        yield createToolStartChunk(index, event.item);
      }

      if (!state.emittedArguments && event.item.arguments) {
        state.emittedArguments = normalizeText(event.item.arguments);
        yield createToolArgumentsChunk(index, event.item.arguments);
      }
      continue;
    }

    if (event?.type === "response.completed") {
      finalResponse = event.response;
      yield createChunk(
        {},
        mapResponseFinishReason(event.response, hasToolCalls),
        normalizeResponsesUsage(event.response?.usage)
      );
      continue;
    }

    if (event?.type === "response.incomplete") {
      finalResponse = event.response;
      yield createChunk(
        {},
        mapResponseFinishReason(event.response, hasToolCalls),
        normalizeResponsesUsage(event.response?.usage)
      );
      continue;
    }

    if (event?.type === "response.failed" || event?.type === "error") {
      throw createStreamError(event);
    }
  }

  if (finalResponse?.usage) {
    return;
  }
}
