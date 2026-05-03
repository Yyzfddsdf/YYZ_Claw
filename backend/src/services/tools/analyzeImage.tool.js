import fs from "node:fs/promises";
import path from "node:path";

import { runModelProviderCompletion } from "../modelProviders/runtime.js";

const EXTENSION_MIME_MAP = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"]
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    normalizeText(executionContext.workingDirectory) ||
    normalizeText(executionContext.workplacePath);

  return candidate ? path.resolve(candidate) : process.cwd();
}

function resolveMimeType(filePath, explicitMimeType) {
  const normalizedExplicit = normalizeText(explicitMimeType).toLowerCase();
  if (normalizedExplicit) {
    if (!normalizedExplicit.startsWith("image/")) {
      throw new Error("mimeType must be an image/* type");
    }

    return normalizedExplicit;
  }

  const extension = path.extname(filePath).toLowerCase();
  const mimeType = EXTENSION_MIME_MAP.get(extension);
  if (!mimeType) {
    throw new Error("Unsupported image extension. Please provide mimeType explicitly.");
  }

  return mimeType;
}

async function resolveImageUrl(args = {}, executionContext = {}) {
  const explicitUrl = normalizeText(args.imageUrl);
  if (explicitUrl) {
    if (/^data:image\//i.test(explicitUrl) || /^https?:\/\//i.test(explicitUrl)) {
      return explicitUrl;
    }
    throw new Error("imageUrl must be a data:image/* URL or http(s) URL");
  }

  const filePath = normalizeText(args.filePath);
  if (!filePath) {
    throw new Error("Provide either imageUrl or filePath");
  }

  const cwd = normalizeText(args.cwd)
    ? path.resolve(args.cwd)
    : resolveContextWorkingDirectory(executionContext);
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd, filePath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("filePath must point to a readable image file");
  }

  const mimeType = resolveMimeType(resolvedPath, args.mimeType);
  const buffer = await fs.readFile(resolvedPath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function extractMessageContent(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : String(part?.text ?? part?.content ?? "")
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

export default {
  name: "analyze_image",
  description:
    "Use the configured vision-capable model profile to inspect an image and return a text analysis. Use this when the current chat model may not support image recognition.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "What to inspect or answer about the image. Defaults to a concise comprehensive visual analysis."
      },
      filePath: {
        type: "string",
        description:
          "Optional local image path. Supports absolute path or path relative to the current workplace."
      },
      imageUrl: {
        type: "string",
        description:
          "Optional data:image/* URL or http(s) image URL. Use this instead of filePath when the image is already available as a URL."
      },
      cwd: {
        type: "string",
        description: "Optional absolute working directory for resolving relative filePath."
      },
      mimeType: {
        type: "string",
        description: "Optional image MIME type, for example image/png."
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const visionRuntimeConfig = executionContext?.visionRuntimeConfig;
    if (!visionRuntimeConfig || visionRuntimeConfig.supportsVision === false) {
      throw new Error("Vision model profile is not configured or does not support image recognition.");
    }

    const imageUrl = await resolveImageUrl(args, executionContext);
    const prompt =
      normalizeText(args.prompt) ||
      "请简洁但完整地描述这张图片，并指出其中可能影响任务判断的细节。";
    const completion = await runModelProviderCompletion(visionRuntimeConfig, {
      temperature: 0.2,
      max_tokens: 1600,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    });

    const analysis = extractMessageContent(completion);
    return {
      status: "ok",
      modelProfileId: visionRuntimeConfig.modelProfileId,
      model: visionRuntimeConfig.model,
      analysis
    };
  }
};
