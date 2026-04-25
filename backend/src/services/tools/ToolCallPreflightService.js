function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseArguments(rawArguments) {
  if (isPlainObject(rawArguments)) {
    return {
      ok: true,
      value: rawArguments,
      repaired: true,
      reason: "object_arguments_stringified"
    };
  }

  const text = normalizeText(rawArguments);
  if (!text) {
    return {
      ok: true,
      value: {},
      repaired: true,
      reason: "empty_arguments_replaced"
    };
  }

  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) {
      return {
        ok: true,
        value: parsed,
        repaired: false,
        reason: ""
      };
    }

    return {
      ok: true,
      value: {},
      repaired: true,
      reason: "non_object_arguments_replaced"
    };
  } catch {
    return {
      ok: true,
      value: {},
      repaired: true,
      reason: "invalid_json_arguments_replaced"
    };
  }
}

function inferJsonType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function matchesJsonSchemaType(value, schemaType) {
  if (!schemaType) {
    return true;
  }

  const allowedTypes = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actualType = inferJsonType(value);

  return allowedTypes.some((type) => {
    const normalizedType = normalizeText(type);
    if (normalizedType === "integer") {
      return Number.isInteger(value);
    }
    if (normalizedType === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    return normalizedType === actualType;
  });
}

function collectSchemaWarnings(tool, args) {
  const parameters = isPlainObject(tool?.parameters) ? tool.parameters : {};
  const properties = isPlainObject(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const warnings = [];

  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) {
      warnings.push({
        code: "missing_required_argument",
        field: name,
        message: `Missing required argument: ${name}`
      });
    }
  }

  for (const [name, value] of Object.entries(args)) {
    const propertySchema = isPlainObject(properties[name]) ? properties[name] : null;
    if (!propertySchema) {
      continue;
    }

    if (!matchesJsonSchemaType(value, propertySchema.type)) {
      warnings.push({
        code: "argument_type_mismatch",
        field: name,
        message: `Argument ${name} has type ${inferJsonType(value)}, expected ${JSON.stringify(propertySchema.type)}`
      });
    }
  }

  return warnings;
}

function normalizeToolCall(toolCall, fallbackId = "") {
  if (!isPlainObject(toolCall)) {
    return null;
  }

  const name = normalizeText(toolCall?.function?.name);
  if (!name) {
    return null;
  }

  return {
    ...toolCall,
    id: normalizeText(toolCall.id) || fallbackId || `tool_call_${Date.now()}`,
    type: normalizeText(toolCall.type) || "function",
    function: {
      name,
      arguments: toolCall?.function?.arguments ?? "{}"
    }
  };
}

export class ToolCallPreflightService {
  constructor(options = {}) {
    this.toolRegistry = options.toolRegistry ?? null;
  }

  preflightToolCalls(toolCalls = []) {
    const issues = [];
    const sanitizedToolCalls = [];
    const sourceToolCalls = Array.isArray(toolCalls) ? toolCalls : [];

    sourceToolCalls.forEach((toolCall, index) => {
      const normalizedToolCall = normalizeToolCall(toolCall, `tool_call_${Date.now()}_${index}`);
      if (!normalizedToolCall) {
        issues.push({
          level: "error",
          code: "invalid_tool_call",
          index,
          message: "Tool call is missing a function name."
        });
        return;
      }

      const tool = this.toolRegistry?.getTool?.(normalizedToolCall.function.name) ?? null;
      if (!tool) {
        issues.push({
          level: "error",
          code: "unknown_tool",
          toolCallId: normalizedToolCall.id,
          toolName: normalizedToolCall.function.name,
          message: `Tool is not registered: ${normalizedToolCall.function.name}`
        });
        sanitizedToolCalls.push(normalizedToolCall);
        return;
      }

      const parsedArguments = parseArguments(normalizedToolCall.function.arguments);
      const nextToolCall = {
        ...normalizedToolCall,
        function: {
          ...normalizedToolCall.function,
          arguments: JSON.stringify(parsedArguments.value)
        }
      };

      if (parsedArguments.repaired) {
        issues.push({
          level: "warning",
          code: parsedArguments.reason,
          toolCallId: nextToolCall.id,
          toolName: nextToolCall.function.name,
          message: "Tool arguments were repaired before execution."
        });
      }

      for (const warning of collectSchemaWarnings(tool, parsedArguments.value)) {
        issues.push({
          level: "warning",
          toolCallId: nextToolCall.id,
          toolName: nextToolCall.function.name,
          ...warning
        });
      }

      sanitizedToolCalls.push(nextToolCall);
    });

    return {
      toolCalls: sanitizedToolCalls,
      issues,
      repaired: issues.some((issue) => String(issue.level ?? "") !== "error"),
      hasErrors: issues.some((issue) => String(issue.level ?? "") === "error")
    };
  }
}
