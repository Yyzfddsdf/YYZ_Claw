import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import {
  clipText,
  ensureDirectory,
  normalizePositiveInteger,
  readTextFileLines,
  resolveContextWorkingDirectory,
  resolveTargetPath,
  runShellCommand,
  toSafeRelative,
  walkTextFiles
} from "../../tools/privateToolShared.js";

const require = createRequire(import.meta.url);
const TreeSitter = require("@vscode/tree-sitter-wasm/wasm/tree-sitter.js");

const TEXT_RULES = [
  {
    id: "ts_ignore",
    severity: "high",
    regex: /@ts-ignore|@ts-expect-error/
  },
  {
    id: "lint_disable",
    severity: "medium",
    regex: /\beslint-disable|tslint:disable|nolint\b/
  },
  {
    id: "todo_fixme_hack",
    severity: "low",
    regex: /\b(TODO|FIXME|HACK)\b/
  },
  {
    id: "broad_exception_python",
    severity: "high",
    regex: /\bexcept\s+Exception\b/
  },
  {
    id: "shell_true_or_pass",
    severity: "medium",
    regex: /\b(catch\s*\([^)]*\)\s*{\s*}|except:\s*pass\b)/
  }
];

const EXTENSION_TO_LANGUAGE = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".rs": "rust",
  ".php": "php",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash"
};

const CODE_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_LANGUAGE));

const LANGUAGE_TO_WASM = {
  javascript: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  jsx: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm"),
  typescript: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"),
  tsx: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm"),
  python: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm"),
  go: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm"),
  java: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm"),
  c: () => require.resolve("@lumis-sh/wasm-c/tree-sitter-c.wasm"),
  cpp: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm"),
  csharp: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm"),
  rust: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm"),
  php: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm"),
  ruby: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm"),
  kotlin: () => require.resolve("@lumis-sh/wasm-kotlin/tree-sitter-kotlin.wasm"),
  swift: () => require.resolve("@lumis-sh/wasm-swift/tree-sitter-swift.wasm"),
  scala: () => require.resolve("@lumis-sh/wasm-scala/tree-sitter-scala.wasm"),
  bash: () => require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm")
};

const CALL_TYPE_HINTS = new Set([
  "call_expression",
  "function_call",
  "method_invocation",
  "invocation_expression",
  "macro_invocation",
  "call"
]);

const HIGH_RISK_CALL_NAMES = new Set([
  "eval",
  "shell_exec",
  "passthru",
  "proc_open"
]);

const MEDIUM_RISK_CALL_NAMES = new Set([
  "exec",
  "system",
  "popen"
]);

const MEDIUM_RISK_MEMBER_CALLS = new Set([
  "runtime.exec",
  "os.system",
  "child_process.exec",
  "subprocess.popen",
  "subprocess.run"
]);

const DEFAULT_MAX_AST_NODES = 120000;

let parserRuntimeInitPromise = null;
const languageCache = new Map();
const languageLoadFailures = new Set();

function normalizeText(value) {
  return String(value ?? "").trim();
}

function severityWeight(severity) {
  if (severity === "high") {
    return 3;
  }
  if (severity === "medium") {
    return 2;
  }
  return 1;
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isWithinTarget(filePath, targetPath, targetStats) {
  if (targetStats.isFile()) {
    return path.resolve(filePath) === path.resolve(targetPath);
  }

  const relative = path.relative(targetPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extractLine(lines, lineNumber) {
  if (!Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > lines.length) {
    return "";
  }

  return lines[lineNumber - 1].trimEnd();
}

function parseGitPorcelain(statusText = "") {
  const lines = String(statusText ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines
    .map((line) => {
      if (line.length < 4) {
        return null;
      }

      let filePath = line.slice(3).trim();
      if (!filePath) {
        return null;
      }

      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        filePath = parts[parts.length - 1].trim();
      }

      filePath = filePath.replace(/^"(.*)"$/, "$1").replace(/\\"/g, "\"");
      if (!filePath) {
        return null;
      }

      return {
        path: filePath
      };
    })
    .filter(Boolean);
}

function getLanguageFromFilePath(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  return EXTENSION_TO_LANGUAGE[extension] ?? "";
}

function extractNodeText(node, sourceText, maxChars = 260) {
  if (!node) {
    return "";
  }

  const start = Number(node.startIndex ?? -1);
  const end = Number(node.endIndex ?? -1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || end < start) {
    return "";
  }

  const text = sourceText.slice(start, end).trim();
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function toLine(node) {
  return Number(node?.startPosition?.row ?? 0) + 1;
}

function isCallNodeType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (CALL_TYPE_HINTS.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("call") &&
    !normalized.includes("declaration") &&
    !normalized.includes("type")
  );
}

function splitMemberName(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return {
      objectName: "",
      propertyName: ""
    };
  }

  for (const delimiter of ["::", "->", ".", "#"]) {
    if (!normalized.includes(delimiter)) {
      continue;
    }
    const parts = normalized.split(delimiter).map((item) => normalizeText(item)).filter(Boolean);
    if (parts.length >= 2) {
      return {
        objectName: parts[parts.length - 2],
        propertyName: parts[parts.length - 1]
      };
    }
  }

  return {
    objectName: "",
    propertyName: ""
  };
}

function extractCallCallee(node, sourceText) {
  let calleeNode = null;
  for (const fieldName of ["function", "callee", "name", "target"]) {
    const candidate = node?.childForFieldName?.(fieldName);
    if (candidate) {
      calleeNode = candidate;
      break;
    }
  }
  if (!calleeNode) {
    const firstNamedChild = Array.isArray(node?.namedChildren) ? node.namedChildren[0] : null;
    calleeNode = firstNamedChild ?? null;
  }

  const calleeDisplayName = extractNodeText(calleeNode, sourceText, 240) || "<expression>";
  const { objectName, propertyName } = splitMemberName(calleeDisplayName);
  const identifier = objectName || propertyName ? "" : normalizeText(calleeDisplayName);
  return {
    calleeDisplayName,
    calleeIdentifier: identifier,
    calleeObjectName: objectName,
    calleePropertyName: propertyName
  };
}

function findLikelyCatchBody(node) {
  const directBody =
    node?.childForFieldName?.("body") ??
    node?.childForFieldName?.("block") ??
    node?.childForFieldName?.("consequence");
  if (directBody) {
    return directBody;
  }

  const children = Array.isArray(node?.namedChildren) ? node.namedChildren : [];
  return children.find((child) => normalizeText(child?.type).toLowerCase().includes("block")) ?? null;
}

function isCatchLikeNode(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("catch")) {
    return false;
  }
  return !normalized.includes("parameter");
}

function normalizeCallCandidate(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, "");
}

async function ensureTreeSitterInitialized() {
  if (!parserRuntimeInitPromise) {
    parserRuntimeInitPromise = (async () => {
      const parserWasmPath = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm");
      await TreeSitter.Parser.init({
        locateFile: () => parserWasmPath
      });
    })();
  }
  return parserRuntimeInitPromise;
}

async function loadLanguage(language) {
  const normalizedLanguage = normalizeText(language).toLowerCase();
  if (!normalizedLanguage) {
    return null;
  }

  if (languageCache.has(normalizedLanguage)) {
    return languageCache.get(normalizedLanguage);
  }
  if (languageLoadFailures.has(normalizedLanguage)) {
    return null;
  }

  const resolver = LANGUAGE_TO_WASM[normalizedLanguage];
  if (typeof resolver !== "function") {
    languageLoadFailures.add(normalizedLanguage);
    return null;
  }

  try {
    await ensureTreeSitterInitialized();
    const languagePath = resolver();
    const loaded = await TreeSitter.Language.load(languagePath);
    languageCache.set(normalizedLanguage, loaded);
    return loaded;
  } catch {
    languageLoadFailures.add(normalizedLanguage);
    return null;
  }
}

function walkNamedNodes(rootNode, visitor, maxNodes = DEFAULT_MAX_AST_NODES) {
  const stack = [rootNode];
  let visited = 0;

  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    if (!node || !node.isNamed) {
      continue;
    }
    visited += 1;
    visitor(node);

    const children = Array.isArray(node.namedChildren) ? node.namedChildren : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return visited;
}

async function collectTreeSitterAstFindings({
  code,
  filePath,
  relativePath,
  lines,
  includeLow,
  maxAstNodes
}) {
  const languageKey = getLanguageFromFilePath(filePath);
  if (!languageKey) {
    return {
      parsed: false,
      skippedReason: "unsupported_extension",
      findings: []
    };
  }

  const language = await loadLanguage(languageKey);
  if (!language) {
    return {
      parsed: false,
      skippedReason: `missing_language_parser:${languageKey}`,
      findings: []
    };
  }

  const parser = new TreeSitter.Parser();
  try {
    parser.setLanguage(language);
  } catch {
    parser.delete?.();
    return {
      parsed: false,
      skippedReason: `language_binding_failed:${languageKey}`,
      findings: []
    };
  }

  let tree = null;
  try {
    tree = parser.parse(code);
  } catch {
    parser.delete?.();
    return {
      parsed: false,
      skippedReason: `parse_failed:${languageKey}`,
      findings: []
    };
  }

  const findings = [];
  const seen = new Set();
  const pushFinding = (ruleId, severity, lineNumber, detail) => {
    if (severity === "low" && !includeLow) {
      return;
    }

    const key = `${ruleId}|${lineNumber}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push({
      source: "ast",
      ruleId,
      severity,
      filePath: relativePath,
      lineNumber,
      detail,
      line: extractLine(lines, lineNumber)
    });
  };

  walkNamedNodes(
    tree.rootNode,
    (node) => {
      const nodeType = normalizeText(node.type).toLowerCase();
      if (!nodeType) {
        return;
      }

      const lineNumber = toLine(node);

      if (nodeType === "debugger_statement") {
        pushFinding(
          "debugger_statement",
          "medium",
          lineNumber,
          "debugger statement should not be committed"
        );
      }

      if (isCatchLikeNode(nodeType)) {
        const bodyNode = findLikelyCatchBody(node);
        if (bodyNode && Number(bodyNode.namedChildCount ?? 0) === 0) {
          pushFinding(
            "empty_catch_block",
            "high",
            lineNumber,
            "empty catch-like block may silently swallow runtime errors"
          );
        }
      }

      if (nodeType.includes("new_expression") || nodeType === "object_creation_expression") {
        const constructorNode =
          node.childForFieldName?.("constructor") ??
          node.childForFieldName?.("type") ??
          node.childForFieldName?.("name") ??
          (Array.isArray(node.namedChildren) ? node.namedChildren[0] : null);
        const constructorName = normalizeCallCandidate(extractNodeText(constructorNode, code, 120));
        if (constructorName === "function" || constructorName.endsWith(".function")) {
          pushFinding(
            "dynamic_function_constructor",
            "high",
            lineNumber,
            "dynamic Function constructor introduces code-injection risk"
          );
        }
      }

      if (!isCallNodeType(nodeType)) {
        return;
      }

      const callee = extractCallCallee(node, code);
      const identifier = normalizeCallCandidate(callee.calleeIdentifier);
      const objectName = normalizeCallCandidate(callee.calleeObjectName);
      const propertyName = normalizeCallCandidate(callee.calleePropertyName);
      const memberName = objectName && propertyName ? `${objectName}.${propertyName}` : "";

      if (identifier === "eval" || propertyName === "eval" || memberName.endsWith(".eval")) {
        pushFinding(
          "eval_usage",
          "high",
          lineNumber,
          "eval-like dynamic execution increases injection risk"
        );
      }

      if (
        HIGH_RISK_CALL_NAMES.has(identifier) ||
        HIGH_RISK_CALL_NAMES.has(propertyName) ||
        HIGH_RISK_CALL_NAMES.has(memberName)
      ) {
        pushFinding(
          "high_risk_exec_call",
          "high",
          lineNumber,
          `high-risk execution call detected: ${callee.calleeDisplayName}`
        );
      } else if (
        MEDIUM_RISK_CALL_NAMES.has(identifier) ||
        MEDIUM_RISK_CALL_NAMES.has(propertyName) ||
        MEDIUM_RISK_MEMBER_CALLS.has(memberName)
      ) {
        pushFinding(
          "exec_call",
          "medium",
          lineNumber,
          `execution-related call detected: ${callee.calleeDisplayName}`
        );
      }

      if (objectName === "console" && (propertyName === "log" || propertyName === "debug")) {
        pushFinding(
          "console_debug_output",
          "low",
          lineNumber,
          "console debug output may leak into production logs"
        );
      }
    },
    maxAstNodes
  );

  tree.delete?.();
  parser.delete?.();

  return {
    parsed: true,
    skippedReason: "",
    findings
  };
}

async function collectChangedFiles(workspaceCwd) {
  const gitCheck = await runShellCommand({
    command: "git rev-parse --is-inside-work-tree",
    cwd: workspaceCwd,
    timeoutMs: 8000,
    maxOutputChars: 1000
  });
  if (!gitCheck.ok || gitCheck.stdout.toLowerCase() !== "true") {
    return {
      isGitRepo: false,
      files: []
    };
  }

  const statusRun = await runShellCommand({
    command: "git status --porcelain",
    cwd: workspaceCwd,
    timeoutMs: 15000,
    maxOutputChars: 20000
  });
  if (!statusRun.ok) {
    return {
      isGitRepo: true,
      files: []
    };
  }

  const statusEntries = parseGitPorcelain(statusRun.stdout);
  const files = [];
  for (const entry of statusEntries) {
    const absolutePath = path.resolve(workspaceCwd, entry.path);
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isFile()) {
        files.push(absolutePath);
      }
    } catch {
      continue;
    }
  }

  return {
    isGitRepo: true,
    files: Array.from(new Set(files))
  };
}

export default {
  name: "reviewer_risk_pattern_scan",
  description:
    "Run reviewer-grade risk scan with multi-language AST checks plus cross-language textual risk rules.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional scan root path (relative to workspace or absolute).",
        default: "."
      },
      onlyChanged: {
        type: "boolean",
        description: "Scan only changed files when git is available.",
        default: true
      },
      includeLow: {
        type: "boolean",
        description: "Include low-severity findings.",
        default: true
      },
      maxFiles: {
        type: "integer",
        description: "Max files to scan.",
        default: 1000
      },
      maxFindings: {
        type: "integer",
        description: "Max findings to return.",
        default: 150
      },
      maxAstNodesPerFile: {
        type: "integer",
        description: "Max named AST nodes traversed per file.",
        default: DEFAULT_MAX_AST_NODES
      }
    },
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const workspaceCwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(workspaceCwd);
    const targetPath = resolveTargetPath(workspaceCwd, args.path);
    const targetStats = await fs.stat(targetPath);
    const onlyChanged = args.onlyChanged !== false;
    const includeLow = args.includeLow !== false;
    const maxFiles = normalizePositiveInteger(args.maxFiles, 1000, 1, 10000);
    const maxFindings = normalizePositiveInteger(args.maxFindings, 150, 1, 2000);
    const maxAstNodesPerFile = normalizePositiveInteger(
      args.maxAstNodesPerFile,
      DEFAULT_MAX_AST_NODES,
      2000,
      500000
    );

    let candidateFiles = [];
    let sourceMode = "workspace";
    let isGitRepo = false;

    if (onlyChanged) {
      const changed = await collectChangedFiles(workspaceCwd);
      isGitRepo = changed.isGitRepo;
      candidateFiles = changed.files.filter((filePath) =>
        isWithinTarget(filePath, targetPath, targetStats)
      );
      if (candidateFiles.length > 0) {
        sourceMode = "changed_files";
      }
    }

    if (candidateFiles.length === 0) {
      candidateFiles = await walkTextFiles(targetPath, { maxFiles });
      sourceMode = "workspace";
    }

    const filesToScan = candidateFiles.filter((filePath) => isCodeFile(filePath)).slice(0, maxFiles);
    const findings = [];
    const findingKeys = new Set();
    const astSkippedFiles = [];
    let astScannedFileCount = 0;
    let astParsedFileCount = 0;

    const pushFinding = (finding) => {
      if (finding.severity === "low" && !includeLow) {
        return;
      }

      const key = `${finding.ruleId}|${finding.filePath}|${finding.lineNumber}|${finding.source}`;
      if (findingKeys.has(key)) {
        return;
      }
      findingKeys.add(key);
      findings.push(finding);
    };

    for (const filePath of filesToScan) {
      if (findings.length >= maxFindings) {
        break;
      }

      let parsed;
      try {
        parsed = await readTextFileLines(filePath, { maxChars: 1000000 });
      } catch {
        continue;
      }

      const relativePath = toSafeRelative(targetPath, filePath);
      for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
        const line = parsed.lines[lineIndex];
        for (const rule of TEXT_RULES) {
          rule.regex.lastIndex = 0;
          if (!rule.regex.test(line)) {
            continue;
          }

          pushFinding({
            source: "text",
            ruleId: rule.id,
            severity: rule.severity,
            filePath: relativePath,
            lineNumber: lineIndex + 1,
            detail: `Matched rule ${rule.id}`,
            line: clipText(line.trimEnd(), 220)
          });
          if (findings.length >= maxFindings) {
            break;
          }
        }
        if (findings.length >= maxFindings) {
          break;
        }
      }

      if (findings.length >= maxFindings) {
        break;
      }

      astScannedFileCount += 1;
      const code = parsed.lines.join("\n");
      const astResult = await collectTreeSitterAstFindings({
        code,
        filePath,
        relativePath,
        lines: parsed.lines,
        includeLow,
        maxAstNodes: maxAstNodesPerFile
      });

      if (astResult.parsed) {
        astParsedFileCount += 1;
      } else if (astResult.skippedReason) {
        astSkippedFiles.push({
          filePath: relativePath,
          reason: astResult.skippedReason
        });
      }

      for (const finding of astResult.findings) {
        pushFinding(finding);
        if (findings.length >= maxFindings) {
          break;
        }
      }
    }

    findings.sort((left, right) => {
      const severityDelta = severityWeight(right.severity) - severityWeight(left.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      if (left.filePath !== right.filePath) {
        return left.filePath.localeCompare(right.filePath);
      }
      return left.lineNumber - right.lineNumber;
    });

    const summaryBySeverity = findings.reduce(
      (acc, item) => {
        acc[item.severity] = (acc[item.severity] ?? 0) + 1;
        return acc;
      },
      { high: 0, medium: 0, low: 0 }
    );
    const summaryBySource = findings.reduce(
      (acc, item) => {
        acc[item.source] = (acc[item.source] ?? 0) + 1;
        return acc;
      },
      { text: 0, ast: 0 }
    );

    return {
      targetPath,
      scanMode: sourceMode,
      isGitRepo,
      summary: {
        scannedFileCount: filesToScan.length,
        astScannedFileCount,
        astParsedFileCount,
        astSkippedFileCount: astSkippedFiles.length,
        findingCount: findings.length,
        summaryBySeverity,
        summaryBySource
      },
      skippedAstFiles: astSkippedFiles.slice(0, 200),
      findings
    };
  }
};
