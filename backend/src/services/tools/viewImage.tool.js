import fs from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;
const PREFERRED_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_STRIPPABLE_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "iCCP"]);
const WEBP_STRIPPABLE_CHUNKS = new Set(["EXIF", "XMP ", "ICCP"]);
const WEBP_VP8X_FLAG_MASK_CLEAR_METADATA = ~(0b00001101);
const EXTENSION_MIME_MAP = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"]
]);

function resolveContextWorkingDirectory(executionContext = {}) {
  const candidate =
    typeof executionContext.workingDirectory === "string"
      ? executionContext.workingDirectory.trim()
      : typeof executionContext.workplacePath === "string"
        ? executionContext.workplacePath.trim()
        : "";

  return candidate ? path.resolve(candidate) : process.cwd();
}

function resolveTargetPath(rawFilePath, cwd) {
  const candidate = typeof rawFilePath === "string" ? rawFilePath.trim() : "";
  if (!candidate) {
    throw new Error("filePath is required");
  }

  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
}

async function ensureReadableFile(targetPath) {
  const stats = await fs.stat(targetPath);
  if (!stats.isFile()) {
    throw new Error("filePath must point to a file");
  }

  if (stats.size <= 0) {
    throw new Error("file is empty");
  }

  if (stats.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `image source is too large (${stats.size} bytes). Max allowed source size is ${MAX_SOURCE_IMAGE_BYTES} bytes.`
    );
  }
}

function resolveMimeType(filePath, explicitMimeType) {
  const normalizedExplicit = String(explicitMimeType ?? "").trim().toLowerCase();
  if (normalizedExplicit) {
    if (!normalizedExplicit.startsWith("image/")) {
      throw new Error("mimeType must be an image/* type");
    }

    return normalizedExplicit;
  }

  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  const mimeType = EXTENSION_MIME_MAP.get(extension);
  if (!mimeType) {
    throw new Error("Unsupported image extension. Please provide mimeType explicitly.");
  }

  return mimeType;
}

function isPngBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function stripPngMetadata(buffer) {
  if (!isPngBuffer(buffer)) {
    return buffer;
  }

  const chunks = [buffer.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let removed = false;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkTypeStart = offset + 4;
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;
    const chunkEnd = chunkDataEnd + 4;

    if (chunkEnd > buffer.length) {
      return buffer;
    }

    const chunkType = buffer.toString("ascii", chunkTypeStart, chunkTypeStart + 4);
    if (PNG_STRIPPABLE_CHUNKS.has(chunkType)) {
      removed = true;
    } else {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (chunkType === "IEND") {
      break;
    }
  }

  return removed ? Buffer.concat(chunks) : buffer;
}

function stripJpegMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return buffer;
  }

  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return buffer;
  }

  const segments = [buffer.subarray(0, 2)];
  let offset = 2;
  let removed = false;

  while (offset < buffer.length) {
    if (offset + 1 >= buffer.length || buffer[offset] !== 0xff) {
      return buffer;
    }

    let markerOffset = offset;
    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      markerOffset += 1;
      if (markerOffset + 1 >= buffer.length) {
        return buffer;
      }
      marker = buffer[markerOffset + 1];
    }

    const markerStart = markerOffset;
    offset = markerStart + 2;

    if (marker === 0xda) {
      if (offset + 2 > buffer.length) {
        return buffer;
      }

      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        return buffer;
      }

      const segmentEnd = offset + segmentLength;
      segments.push(buffer.subarray(markerStart, segmentEnd));
      segments.push(buffer.subarray(segmentEnd));
      return Buffer.concat(segments);
    }

    if (marker === 0xd9) {
      segments.push(buffer.subarray(markerStart, offset));
      return removed ? Buffer.concat(segments) : buffer;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push(buffer.subarray(markerStart, offset));
      continue;
    }

    if (offset + 2 > buffer.length) {
      return buffer;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return buffer;
    }

    const segmentEnd = offset + segmentLength;
    const isMetadataSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;

    if (isMetadataSegment) {
      removed = true;
    } else {
      segments.push(buffer.subarray(markerStart, segmentEnd));
    }

    offset = segmentEnd;
  }

  return removed ? Buffer.concat(segments) : buffer;
}

function isWebpBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function clearWebpVp8xMetadataFlags(buffer) {
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength % 2);

    if (paddedEnd > buffer.length) {
      return;
    }

    if (chunkType === "VP8X" && chunkLength >= 10) {
      buffer[dataStart] &= WEBP_VP8X_FLAG_MASK_CLEAR_METADATA;
      return;
    }

    offset = paddedEnd;
  }
}

function stripWebpMetadata(buffer) {
  if (!isWebpBuffer(buffer)) {
    return buffer;
  }

  const chunks = [];
  let offset = 12;
  let removed = false;

  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength % 2);

    if (paddedEnd > buffer.length) {
      return buffer;
    }

    if (WEBP_STRIPPABLE_CHUNKS.has(chunkType)) {
      removed = true;
    } else {
      chunks.push(buffer.subarray(offset, paddedEnd));
    }

    offset = paddedEnd;
  }

  if (!removed) {
    return buffer;
  }

  const body = Buffer.concat(chunks);
  clearWebpVp8xMetadataFlags(body);

  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

function applyLightCompression(buffer, mimeType) {
  const normalizedMimeType = String(mimeType ?? "").trim().toLowerCase();
  let compressedBuffer = buffer;

  if (normalizedMimeType === "image/jpeg" || normalizedMimeType === "image/jpg") {
    compressedBuffer = stripJpegMetadata(buffer);
  } else if (normalizedMimeType === "image/png") {
    compressedBuffer = stripPngMetadata(buffer);
  } else if (normalizedMimeType === "image/webp") {
    compressedBuffer = stripWebpMetadata(buffer);
  }

  const originalSize = Number(buffer.length ?? 0);
  const compressedSize = Number(compressedBuffer.length ?? 0);

  return {
    buffer: compressedBuffer,
    originalSize,
    compressedSize,
    compressionApplied: compressedSize > 0 && compressedSize < originalSize,
    compressionMode: "strip_metadata"
  };
}

export default {
  name: "view_image",
  description:
    "Read a local image file, apply lightweight cross-platform compression (metadata stripping), and return base64 data URL payload for model vision input.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target image path. Supports absolute path or path relative to current workplace."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      mimeType: {
        type: "string",
        description:
          "Optional explicit image MIME type (for example image/png). Required when extension is uncommon."
      },
      disableCompression: {
        type: "boolean",
        description:
          "Optional. When true, skip the default lightweight compression step and use original bytes."
      }
    },
    required: ["filePath"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const contextCwd = resolveContextWorkingDirectory(executionContext);
    const cwd = cwdInput ? path.resolve(cwdInput) : contextCwd;

    if (!path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }

    const resolvedPath = resolveTargetPath(args.filePath, cwd);
    await ensureReadableFile(resolvedPath);

    const mimeType = resolveMimeType(resolvedPath, args.mimeType);
    const sourceBuffer = await fs.readFile(resolvedPath);
    const shouldCompress = args.disableCompression !== true;
    const compressionResult = shouldCompress
      ? applyLightCompression(sourceBuffer, mimeType)
      : {
          buffer: sourceBuffer,
          originalSize: Number(sourceBuffer.length ?? 0),
          compressedSize: Number(sourceBuffer.length ?? 0),
          compressionApplied: false,
          compressionMode: "none"
        };

    const finalBuffer = compressionResult.buffer;
    const targetHit = finalBuffer.length <= PREFERRED_MAX_IMAGE_BYTES;
    const overTargetBytes = targetHit ? 0 : finalBuffer.length - PREFERRED_MAX_IMAGE_BYTES;
    const dataUrl = `data:${mimeType};base64,${finalBuffer.toString("base64")}`;
    const fileName = path.basename(resolvedPath);

    return {
      __toolResultEnvelope: true,
      result: {
        status: "ok",
        message: targetHit
          ? "Image loaded and prepared for model vision input."
          : "Image loaded. Lightweight compression applied, but payload is still above preferred 10MB target.",
        filePath: resolvedPath,
        fileName,
        mimeType,
        size: Number(finalBuffer.length),
        originalSize: compressionResult.originalSize,
        compressedSize: compressionResult.compressedSize,
        compressionApplied: Boolean(compressionResult.compressionApplied),
        compressionMode: compressionResult.compressionMode,
        targetSizeBytes: PREFERRED_MAX_IMAGE_BYTES,
        targetHit,
        overTargetBytes
      },
      imageAttachments: [
        {
          id: `tool_image_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          type: "image",
          name: fileName,
          mimeType,
          dataUrl,
          size: Number(finalBuffer.length)
        }
      ]
    };
  }
};
