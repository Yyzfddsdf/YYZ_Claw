import path from "node:path";

import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import XLSX from "xlsx";

const DEFAULT_MAX_FILE_COUNT = 8;
const DEFAULT_MAX_CHARS_PER_FILE = 500_000;
const DEFAULT_MAX_TOTAL_CHARS = 2_000_000;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".ini",
  ".conf",
  ".log",
  ".rtf",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".go",
  ".rs",
  ".sql",
  ".sh",
  ".bat",
  ".ps1"
]);

const EXCEL_EXTENSIONS = new Set([".xls", ".xlsx", ".xlsm", ".xltx", ".xltm", ".ods"]);
const PDF_PARSE_NOISE_PATTERNS = [
  /^Warning:\s*TT:\s*undefined function:/i
];

function scoreFilenameReadability(input) {
  const text = String(input ?? "");
  if (!text) {
    return 0;
  }

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinWordCount = (text.match(/[A-Za-z0-9._()\-\s]/g) ?? []).length;
  const latin1NoiseCount = (text.match(/[\u00C0-\u00FF]/g) ?? []).length;
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;

  return cjkCount * 4 + latinWordCount - latin1NoiseCount * 2 - replacementCount * 4;
}

function decodeMultipartFilename(input) {
  const original = String(input ?? "").trim();
  if (!original || !/[\u00C0-\u00FF]/.test(original)) {
    return original;
  }

  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8").trim();
    if (!decoded) {
      return original;
    }

    return scoreFilenameReadability(decoded) > scoreFilenameReadability(original)
      ? decoded
      : original;
  } catch {
    return original;
  }
}

function clipText(text, maxChars) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const clipped = normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd();
  return `${clipped}\n...[truncated]`;
}

function applyExtremeLengthGuard(text, maxChars) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return {
      text: "",
      truncated: false
    };
  }

  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return {
      text: normalized,
      truncated: false
    };
  }

  return {
    text: clipText(normalized, maxChars),
    truncated: true
  };
}

async function withSuppressedPdfWarnings(task) {
  const originalConsoleLog = console.log;

  console.log = (...args) => {
    const message = args.map((item) => String(item ?? "")).join(" ").trim();
    if (PDF_PARSE_NOISE_PATTERNS.some((pattern) => pattern.test(message))) {
      return;
    }

    originalConsoleLog(...args);
  };

  try {
    return await task();
  } finally {
    console.log = originalConsoleLog;
  }
}

function formatBytes(size) {
  const numericSize = Number(size ?? 0);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return "0 B";
  }

  if (numericSize < 1024) {
    return `${numericSize} B`;
  }

  const kb = numericSize / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }

  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function sanitizeText(text) {
  return String(text ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function isLikelyBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  const sampleLength = Math.min(buffer.length, 4096);
  let controlCount = 0;
  let nullCount = 0;

  for (let index = 0; index < sampleLength; index += 1) {
    const value = buffer[index];
    if (value === 0) {
      nullCount += 1;
      continue;
    }

    if (value < 7 || (value > 13 && value < 32)) {
      controlCount += 1;
    }
  }

  return nullCount > 0 || controlCount / sampleLength > 0.18;
}

function normalizeUploadedFile(file, index) {
  const originalName = decodeMultipartFilename(
    String(file?.originalname ?? file?.name ?? `upload_${index + 1}`).trim()
  );
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = String(file?.mimetype ?? "").trim().toLowerCase();
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);

  return {
    id: `file_${Date.now()}_${index}`,
    name: originalName || `upload_${index + 1}`,
    extension,
    mimeType,
    size: Number(file?.size ?? buffer.length ?? 0),
    buffer
  };
}

function isPdfFile(file) {
  return file.extension === ".pdf" || file.mimeType.includes("pdf");
}

function isDocxFile(file) {
  return (
    file.extension === ".docx" ||
    file.mimeType.includes("officedocument.wordprocessingml.document")
  );
}

function isExcelFile(file) {
  return (
    EXCEL_EXTENSIONS.has(file.extension) ||
    file.mimeType.includes("spreadsheet") ||
    file.mimeType.includes("excel")
  );
}

function isTextFile(file) {
  return (
    TEXT_EXTENSIONS.has(file.extension) ||
    file.mimeType.startsWith("text/") ||
    file.mimeType.includes("json") ||
    file.mimeType.includes("xml") ||
    file.mimeType.includes("yaml")
  );
}

export class AttachmentParserService {
  constructor(options = {}) {
    this.maxFileCount = Number(options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT);
    this.maxCharsPerFile = Number(options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE);
    this.maxTotalChars = Number(options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
  }

  async parseFiles(uploadedFiles = []) {
    const normalizedFiles = Array.isArray(uploadedFiles)
      ? uploadedFiles.map((file, index) => normalizeUploadedFile(file, index))
      : [];

    const limitedFiles = normalizedFiles.slice(0, this.maxFileCount);
    const truncatedFileCount = Math.max(0, normalizedFiles.length - limitedFiles.length);
    const parsedFiles = [];
    let remainingChars = this.maxTotalChars;

    for (const file of limitedFiles) {
      const parsedFile = await this.parseSingleFile(file);

      if (parsedFile.extractedText) {
        const usableChars = Math.max(0, remainingChars);
        if (usableChars <= 0) {
          parsedFile.extractedText = "";
          parsedFile.parseStatus = "truncated";
          parsedFile.note = "极端总长度保护触发，后续文件内容被截断。";
        } else {
          const guarded = applyExtremeLengthGuard(parsedFile.extractedText, usableChars);
          parsedFile.extractedText = guarded.text;
          remainingChars -= parsedFile.extractedText.length;

          if (guarded.truncated) {
            parsedFile.parseStatus = "truncated";
            parsedFile.note = "极端长度保护触发，文件内容已截断。";
          }
        }
      }

      parsedFiles.push(parsedFile);
    }

    return {
      files: parsedFiles,
      truncatedFileCount
    };
  }

  async parseSingleFile(file) {
    const baseResult = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      extension: file.extension,
      size: file.size,
      parser: "metadata",
      parseStatus: "unsupported",
      note: "该文件类型暂不支持文本提取。",
      extractedText: ""
    };

    if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      return {
        ...baseResult,
        parseStatus: "empty",
        note: "文件为空或读取失败。"
      };
    }

    try {
      if (isPdfFile(file)) {
        const parsed = await withSuppressedPdfWarnings(() => pdfParse(file.buffer));
        const guarded = applyExtremeLengthGuard(sanitizeText(parsed?.text ?? ""), this.maxCharsPerFile);
        const text = guarded.text;

        if (!text) {
          return {
            ...baseResult,
            parser: "pdf-parse",
            parseStatus: "empty",
            note: "PDF 未解析出可用文本，可能为扫描件或图片型 PDF。"
          };
        }

        return {
          ...baseResult,
          parser: "pdf-parse",
          parseStatus: guarded.truncated ? "truncated" : "parsed",
          note: guarded.truncated ? "极端长度保护触发，PDF 内容已截断。" : "",
          extractedText: text
        };
      }

      if (isDocxFile(file)) {
        const parsed = await mammoth.extractRawText({ buffer: file.buffer });
        const guarded = applyExtremeLengthGuard(sanitizeText(parsed?.value ?? ""), this.maxCharsPerFile);
        const text = guarded.text;

        if (!text) {
          return {
            ...baseResult,
            parser: "mammoth",
            parseStatus: "empty",
            note: "DOCX 未解析出可用文本。"
          };
        }

        return {
          ...baseResult,
          parser: "mammoth",
          parseStatus: guarded.truncated ? "truncated" : "parsed",
          note: guarded.truncated ? "极端长度保护触发，DOCX 内容已截断。" : "",
          extractedText: text
        };
      }

      if (isExcelFile(file)) {
        const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false, raw: false });
        const lines = [];

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) {
            continue;
          }

          lines.push(`[Sheet] ${sheetName}`);
          const rows = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            raw: false,
            defval: ""
          });

          for (const row of rows) {
            if (!Array.isArray(row)) {
              continue;
            }

            const line = row.map((cell) => String(cell ?? "").trim()).join("\t").trim();
            if (line) {
              lines.push(line);
            }
          }

          if (rows.length === 0) {
            lines.push("(空表)");
          }
        }

        const guarded = applyExtremeLengthGuard(sanitizeText(lines.join("\n")), this.maxCharsPerFile);
        const text = guarded.text;

        if (!text) {
          return {
            ...baseResult,
            parser: "xlsx",
            parseStatus: "empty",
            note: "Excel 未解析出可用内容。"
          };
        }

        return {
          ...baseResult,
          parser: "xlsx",
          parseStatus: guarded.truncated ? "truncated" : "parsed",
          note: guarded.truncated ? "极端长度保护触发，表格内容已截断。" : "",
          extractedText: text
        };
      }

      if (isTextFile(file) && !isLikelyBinaryBuffer(file.buffer)) {
        const guarded = applyExtremeLengthGuard(
          sanitizeText(file.buffer.toString("utf8")),
          this.maxCharsPerFile
        );
        const text = guarded.text;

        if (!text) {
          return {
            ...baseResult,
            parser: "utf8",
            parseStatus: "empty",
            note: "文本文件为空。"
          };
        }

        return {
          ...baseResult,
          parser: "utf8",
          parseStatus: guarded.truncated ? "truncated" : "parsed",
          note: guarded.truncated ? "极端长度保护触发，文本内容已截断。" : "",
          extractedText: text
        };
      }

      return {
        ...baseResult,
        parser: "metadata",
        parseStatus: "unsupported",
        note: "检测到非文本或暂不支持的格式，已附带文件元信息。"
      };
    } catch (error) {
      return {
        ...baseResult,
        parser: "error",
        parseStatus: "failed",
        note: String(error?.message ?? "文件解析失败")
      };
    }
  }
}
