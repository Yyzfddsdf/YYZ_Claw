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

function mapStopReason(reason) {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    default:
      return "stop";
  }
}

function normalizeAnthropicUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  const promptTokens =
    (Number.isFinite(inputTokens) ? inputTokens : 0) +
    (Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0) +
    (Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0);
  const completionTokens = Number.isFinite(outputTokens) ? outputTokens : 0;

  if (promptTokens <= 0 && completionTokens <= 0) {
    return null;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cacheReadTokens
    },
    completion_tokens_details: usage.output_tokens_details ?? null
  };
}

function mergeUsage(current = {}, next = {}) {
  return {
    ...current,
    ...next,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? current.cache_read_input_tokens
  };
}

function stringifyToolInput(input) {
  if (input === undefined || input === null) {
    return "{}";
  }

  if (typeof input === "string") {
    return input.trim() || "{}";
  }

  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

function extractMessageContentAndTools(message = {}) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "text") {
      textParts.push(normalizeText(block.text));
      continue;
    }

    if (block?.type === "thinking") {
      reasoningParts.push(normalizeText(block.thinking));
      continue;
    }

    if (block?.type === "tool_use") {
      toolCalls.push({
        id: normalizeText(block.id),
        type: "function",
        function: {
          name: normalizeText(block.name),
          arguments: stringifyToolInput(block.input)
        }
      });
    }
  }

  return {
    content: textParts.join(""),
    reasoningContent: reasoningParts.join(""),
    toolCalls
  };
}

export function convertAnthropicMessageToCompletion(message = {}) {
  const extracted = extractMessageContentAndTools(message);
  const choiceMessage = {
    role: "assistant",
    content: extracted.content
  };

  if (extracted.toolCalls.length > 0) {
    choiceMessage.tool_calls = extracted.toolCalls;
  }

  if (extracted.reasoningContent) {
    choiceMessage.reasoning_content = extracted.reasoningContent;
  }

  return {
    id: message.id,
    object: "chat.completion",
    model: message.model,
    choices: [
      {
        index: 0,
        message: choiceMessage,
        finish_reason: mapStopReason(message.stop_reason)
      }
    ],
    usage: normalizeAnthropicUsage(message.usage)
  };
}

export async function* convertAnthropicStreamToOpenAIChunks(stream) {
  const toolBlocks = new Map();
  let usageState = {};
  let stopReason = null;

  for await (const event of stream) {
    if (event?.type === "message_start") {
      usageState = mergeUsage(usageState, event.message?.usage ?? {});
      continue;
    }

    if (event?.type === "content_block_start") {
      const block = event.content_block;
      const index = Number.isInteger(event.index) ? event.index : 0;

      if (block?.type === "text" && block.text) {
        yield createChunk({ content: block.text });
        continue;
      }

      if (block?.type === "thinking" && block.thinking) {
        yield createChunk({ reasoning_content: block.thinking });
        continue;
      }

      if (block?.type === "tool_use") {
        toolBlocks.set(index, {
          id: normalizeText(block.id),
          name: normalizeText(block.name)
        });

        yield createChunk({
          tool_calls: [
            {
              index,
              id: normalizeText(block.id),
              type: "function",
              function: {
                name: normalizeText(block.name),
                arguments: ""
              }
            }
          ]
        });
      }
      continue;
    }

    if (event?.type === "content_block_delta") {
      const delta = event.delta;
      const index = Number.isInteger(event.index) ? event.index : 0;

      if (delta?.type === "text_delta" && delta.text) {
        yield createChunk({ content: delta.text });
        continue;
      }

      if (delta?.type === "thinking_delta" && delta.thinking) {
        yield createChunk({ reasoning_content: delta.thinking });
        continue;
      }

      if (delta?.type === "input_json_delta" && delta.partial_json) {
        const block = toolBlocks.get(index) ?? {};
        yield createChunk({
          tool_calls: [
            {
              index,
              id: block.id,
              type: "function",
              function: {
                name: "",
                arguments: delta.partial_json
              }
            }
          ]
        });
      }
      continue;
    }

    if (event?.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      usageState = mergeUsage(usageState, event.usage ?? {});
      const usage = normalizeAnthropicUsage(usageState);
      if (usage) {
        yield createChunk({}, null, usage);
      }
      continue;
    }

    if (event?.type === "message_stop") {
      yield createChunk({}, mapStopReason(stopReason), normalizeAnthropicUsage(usageState));
    }
  }
}
