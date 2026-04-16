export function safeJsonParse(input, fallbackValue = {}) {
  if (typeof input !== "string") {
    return fallbackValue;
  }

  try {
    return JSON.parse(input);
  } catch {
    return fallbackValue;
  }
}
