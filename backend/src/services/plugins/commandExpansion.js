function normalizeText(value) {
  return String(value ?? "").trim();
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLeftCommandBoundary(character = "") {
  return !character || /[\s([{"'“‘【（<,，。；;：!?！？、]/u.test(character);
}

function isRightCommandBoundary(character = "") {
  return !character || /[\s)\]}"'”’】）>,，。；;：!?！？、]/u.test(character);
}

export function replaceCommandTrigger(text, trigger, replacement) {
  const source = String(text ?? "");
  const normalizedTrigger = normalizeText(trigger);
  const normalizedReplacement = normalizeText(replacement);
  if (!source || !normalizedTrigger || !normalizedReplacement) {
    return source;
  }

  const matcher = new RegExp(escapeRegExp(normalizedTrigger), "g");
  return source.replace(matcher, (matched, offset, fullText) => {
    const leftChar = offset > 0 ? fullText.slice(offset - 1, offset) : "";
    const rightChar = fullText.slice(offset + matched.length, offset + matched.length + 1);
    if (!isLeftCommandBoundary(leftChar) || !isRightCommandBoundary(rightChar)) {
      return matched;
    }
    return normalizedReplacement;
  });
}

export function expandCommandsInText(text, commands = []) {
  const source = String(text ?? "");
  if (!source.trim()) {
    return {
      text: source,
      replacements: []
    };
  }

  const orderedCommands = [...(Array.isArray(commands) ? commands : [])].sort(
    (left, right) => String(right?.name ?? "").length - String(left?.name ?? "").length
  );
  let nextText = source;
  const replacements = [];

  for (const command of orderedCommands) {
    const replacedText = replaceCommandTrigger(nextText, command?.name, command?.description);
    if (replacedText !== nextText) {
      replacements.push({
        pluginName: normalizeText(command?.pluginName),
        name: normalizeText(command?.name),
        description: normalizeText(command?.description)
      });
      nextText = replacedText;
    }
  }

  return {
    text: nextText,
    replacements
  };
}
