function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");

  try {
    return {
      event,
      data: JSON.parse(rawData)
    };
  } catch {
    return {
      event,
      data: rawData
    };
  }
}

export async function streamSseJson({ url, body, signal, onMessage }) {
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const headers = {
    Accept: "text/event-stream"
  };

  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers,
    body: isFormData ? body : JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `stream request failed with ${response.status}`);
  }

  if (!response.body) {
    throw new Error("ReadableStream is not available in this browser.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    while (buffer.includes("\n\n")) {
      const splitAt = buffer.indexOf("\n\n");
      const block = buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt + 2);

      if (!block) {
        continue;
      }

      const parsed = parseSseBlock(block);
      if (parsed) {
        onMessage?.(parsed);
      }
    }
  }

  const finalBlock = buffer.trim();
  if (finalBlock) {
    const parsed = parseSseBlock(finalBlock);
    if (parsed) {
      onMessage?.(parsed);
    }
  }
}
