import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import {
  ensureDirectory,
  normalizePositiveInteger,
  resolveContextWorkingDirectory,
  resolveTargetPath,
  toSafeRelative,
  walkTextFiles
} from "../../tools/privateToolShared.js";

const require = createRequire(import.meta.url);
const TreeSitter = require("@vscode/tree-sitter-wasm/wasm/tree-sitter.js");

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

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_LANGUAGE));
const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "namespace_identifier",
  "module_identifier",
  "package_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern"
]);

const STRING_TYPE_HINTS = ["string", "path", "heredoc", "literal"];
const FIELD_NAME_CANDIDATES = [
  "name",
  "identifier",
  "declarator",
  "left",
  "alias",
  "source",
  "path",
  "function",
  "callee",
  "target",
  "module"
];

const DECLARATION_ALLOW_HINTS = [
  "function",
  "method",
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "trait",
  "protocol",
  "object",
  "module",
  "variable",
  "const",
  "let",
  "var",
  "field",
  "property",
  "impl",
  "fun",
  "func"
];

const DECLARATION_BLOCK_HINTS = [
  "import",
  "package",
  "using",
  "namespace",
  "parameter",
  "argument",
  "call",
  "comment",
  "statement"
];

const PACKAGE_TYPE_HINTS = new Set([
  "package_clause",
  "package_declaration",
  "namespace_declaration",
  "module_declaration"
]);

const CALL_TYPE_HINTS = new Set([
  "call_expression",
  "function_call",
  "method_invocation",
  "invocation_expression",
  "macro_invocation",
  "call"
]);

const IMPORT_TYPE_HINTS = new Set([
  "import_declaration",
  "import_statement",
  "import_spec",
  "using_directive",
  "using_declaration",
  "require_clause",
  "include_directive",
  "preproc_include"
]);

const PYTHON_SELF_NAMES = new Set(["self", "cls", "this", "super"]);
const DEFAULT_MAX_AST_NODES = 120000;

let parserRuntimeInitPromise = null;
const languageCache = new Map();
const languageLoadFailures = new Set();

function normalizeText(value) {
  return String(value ?? "").trim();
}

function appendWithLimit(current, next, maxChars) {
  const merged = `${current}${next}`;
  if (merged.length <= maxChars) {
    return merged;
  }
  return merged.slice(merged.length - maxChars);
}

function isSupportedFilePath(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension);
}

function getLanguageFromFilePath(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  return EXTENSION_TO_LANGUAGE[extension] ?? "";
}

function normalizeDirection(value, fallback = "both") {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "incoming" || normalized === "outgoing" || normalized === "both") {
    return normalized;
  }
  return fallback;
}

function isLikelyIdentifier(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 180) {
    return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_:$<>.\-]*$/.test(normalized);
}

function extractNodeText(node, sourceText, maxChars = 320) {
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

function toLineColumn(node) {
  const row = Number(node?.startPosition?.row ?? 0);
  const column = Number(node?.startPosition?.column ?? 0);
  return {
    line: row + 1,
    column: column + 1
  };
}

function isIdentifierType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (IDENTIFIER_TYPES.has(normalized)) {
    return true;
  }
  return normalized.includes("identifier") || normalized.endsWith("_name");
}

function isDefinitionNodeType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (DECLARATION_BLOCK_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }

  if (
    normalized.includes("declaration") ||
    normalized.includes("definition") ||
    normalized === "function_item" ||
    normalized === "impl_item" ||
    normalized === "fun_declaration" ||
    normalized === "func_declaration" ||
    normalized === "method" ||
    normalized === "struct_item" ||
    normalized === "enum_item"
  ) {
    return DECLARATION_ALLOW_HINTS.some((hint) => normalized.includes(hint));
  }

  return false;
}

function inferDefinitionKind(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (normalized.includes("function") || normalized === "func_declaration" || normalized === "fun_declaration") {
    return "function";
  }
  if (normalized.includes("method")) {
    return "method";
  }
  if (normalized.includes("class")) {
    return "class";
  }
  if (normalized.includes("interface")) {
    return "interface";
  }
  if (normalized.includes("struct")) {
    return "struct";
  }
  if (normalized.includes("enum")) {
    return "enum";
  }
  if (normalized.includes("type")) {
    return "type";
  }
  if (
    normalized.includes("variable") ||
    normalized.includes("const") ||
    normalized.includes("let") ||
    normalized.includes("var")
  ) {
    return "variable";
  }
  if (normalized.includes("field") || normalized.includes("property")) {
    return "field";
  }
  return "declaration";
}

function isCallNodeType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (CALL_TYPE_HINTS.has(normalized)) {
    return true;
  }
  if (normalized.includes("call") && !normalized.includes("declaration") && !normalized.includes("type")) {
    return true;
  }
  if (normalized.includes("invocation") && !normalized.includes("declaration")) {
    return true;
  }
  return false;
}

function isImportNodeType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (IMPORT_TYPE_HINTS.has(normalized)) {
    return true;
  }
  if (normalized.includes("import") && !normalized.includes("identifier")) {
    return true;
  }
  if (normalized.startsWith("using_")) {
    return true;
  }
  if (normalized.includes("include")) {
    return true;
  }
  return false;
}

function isPackageNodeType(type) {
  const normalized = normalizeText(type).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (PACKAGE_TYPE_HINTS.has(normalized)) {
    return true;
  }
  return normalized.startsWith("package_") || normalized.startsWith("namespace_");
}

function stripQuoted(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`")) ||
    (text.startsWith("<") && text.endsWith(">"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function collectIdentifiersFromNode(node, sourceText, maxCount = 8, maxNodes = 300) {
  if (!node) {
    return [];
  }

  const stack = [node];
  const names = [];
  const seen = new Set();
  let visited = 0;

  while (stack.length > 0 && visited < maxNodes && names.length < maxCount) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    visited += 1;

    if (current.isNamed && isIdentifierType(current.type)) {
      const text = extractNodeText(current, sourceText, 150);
      if (isLikelyIdentifier(text) && !seen.has(text)) {
        seen.add(text);
        names.push(text);
      }
    }

    const children = Array.isArray(current.namedChildren) ? current.namedChildren : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return names;
}

function firstIdentifierByFields(node, sourceText) {
  for (const fieldName of FIELD_NAME_CANDIDATES) {
    const fieldNode = node?.childForFieldName?.(fieldName);
    if (!fieldNode) {
      continue;
    }
    const names = collectIdentifiersFromNode(fieldNode, sourceText, 1, 120);
    if (names.length > 0) {
      return names[0];
    }
    const raw = extractNodeText(fieldNode, sourceText, 150);
    if (isLikelyIdentifier(raw)) {
      return raw;
    }
  }

  return "";
}

function extractDefinitionNames(node, sourceText) {
  const nodeType = normalizeText(node?.type).toLowerCase();
  const firstName = firstIdentifierByFields(node, sourceText);
  if (firstName) {
    if (
      nodeType.includes("variable") ||
      nodeType.includes("const") ||
      nodeType.includes("let") ||
      nodeType.includes("var")
    ) {
      const names = [firstName];
      for (const candidate of collectIdentifiersFromNode(node, sourceText, 10, 420)) {
        if (!names.includes(candidate)) {
          names.push(candidate);
        }
      }
      return names.slice(0, 8);
    }
    return [firstName];
  }

  const fallbacks = collectIdentifiersFromNode(node, sourceText, 8, 420);
  if (fallbacks.length === 0) {
    return [];
  }
  if (
    nodeType.includes("function") ||
    nodeType.includes("method") ||
    nodeType.includes("class")
  ) {
    return [fallbacks[0]];
  }
  return fallbacks;
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
  if (objectName && propertyName) {
    return {
      calleeType: "member",
      calleeDisplayName,
      calleeIdentifier: "",
      calleeObjectName: objectName,
      calleePropertyName: propertyName
    };
  }

  const directName = collectIdentifiersFromNode(calleeNode, sourceText, 1, 120)[0] ?? "";
  const identifier = isLikelyIdentifier(directName)
    ? directName
    : isLikelyIdentifier(calleeDisplayName)
      ? calleeDisplayName
      : "";
  return {
    calleeType: identifier ? "identifier" : "unknown",
    calleeDisplayName,
    calleeIdentifier: identifier,
    calleeObjectName: "",
    calleePropertyName: ""
  };
}

function extractImportSource(node, sourceText) {
  for (const fieldName of ["source", "path", "module", "library", "name"]) {
    const fieldNode = node?.childForFieldName?.(fieldName);
    if (!fieldNode) {
      continue;
    }
    const text = stripQuoted(extractNodeText(fieldNode, sourceText, 220));
    if (text) {
      return text;
    }
  }

  const stack = [node];
  let visited = 0;
  while (stack.length > 0 && visited < 200) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    visited += 1;
    const currentType = normalizeText(current.type).toLowerCase();
    if (STRING_TYPE_HINTS.some((hint) => currentType.includes(hint))) {
      const text = stripQuoted(extractNodeText(current, sourceText, 220));
      if (text) {
        return text;
      }
    }

    const children = Array.isArray(current.namedChildren) ? current.namedChildren : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return "";
}

function inferAliasFromSource(source) {
  const normalized = normalizeText(source).replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }
  if (normalized.includes(".") && !normalized.includes("/")) {
    const parts = normalized.split(".");
    return normalizeText(parts[parts.length - 1]);
  }
  const parts = normalized.split("/");
  return normalizeText(parts[parts.length - 1]);
}

function extractImportAlias(node, sourceText, source) {
  for (const fieldName of ["alias", "name", "local", "identifier"]) {
    const fieldNode = node?.childForFieldName?.(fieldName);
    if (!fieldNode) {
      continue;
    }
    const names = collectIdentifiersFromNode(fieldNode, sourceText, 1, 120);
    if (names.length > 0) {
      return names[0];
    }
    const raw = extractNodeText(fieldNode, sourceText, 120);
    if (isLikelyIdentifier(raw)) {
      return raw;
    }
  }

  const candidates = collectIdentifiersFromNode(node, sourceText, 3, 220);
  if (candidates.length > 0) {
    return candidates[0];
  }
  return inferAliasFromSource(source);
}

function extractPackageName(rootNode, sourceText) {
  const stack = [rootNode];
  let visited = 0;
  while (stack.length > 0 && visited < 360) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    visited += 1;
    if (isPackageNodeType(node.type)) {
      const names = collectIdentifiersFromNode(node, sourceText, 6, 180);
      if (names.length > 0) {
        return names.join(".");
      }
      const raw = extractNodeText(node, sourceText, 120)
        .replace(/\bpackage\b/gi, "")
        .replace(/\bnamespace\b/gi, "")
        .trim();
      if (raw) {
        return stripQuoted(raw);
      }
    }
    const children = Array.isArray(node.namedChildren) ? node.namedChildren : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return "";
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
    const loadedLanguage = await TreeSitter.Language.load(languagePath);
    languageCache.set(normalizedLanguage, loadedLanguage);
    return loadedLanguage;
  } catch {
    languageLoadFailures.add(normalizedLanguage);
    return null;
  }
}

async function collectSourceFiles(targetPath, maxFiles) {
  const targetStats = await fs.stat(targetPath);
  if (targetStats.isFile()) {
    return isSupportedFilePath(targetPath) ? [path.resolve(targetPath)] : [];
  }

  if (!targetStats.isDirectory()) {
    return [];
  }

  const walkedFiles = await walkTextFiles(targetPath, {
    maxFiles: Math.max(maxFiles * 8, maxFiles)
  });

  const filtered = walkedFiles
    .filter((item) => isSupportedFilePath(item))
    .slice(0, maxFiles)
    .map((item) => path.resolve(item));

  return Array.from(new Set(filtered));
}

async function parseSourceFile({
  filePath,
  workspaceCwd,
  maxFileChars,
  maxAstNodes
}) {
  const language = getLanguageFromFilePath(filePath);
  if (!language) {
    return {
      filePath,
      relativePath: toSafeRelative(workspaceCwd, filePath),
      language: "",
      packageName: "",
      definitions: [],
      references: [],
      imports: [],
      calls: [],
      parseError: "",
      skippedReason: "unsupported_extension"
    };
  }

  const parserLanguage = await loadLanguage(language);
  if (!parserLanguage) {
    return {
      filePath,
      relativePath: toSafeRelative(workspaceCwd, filePath),
      language,
      packageName: "",
      definitions: [],
      references: [],
      imports: [],
      calls: [],
      parseError: "",
      skippedReason: `missing_language_parser:${language}`
    };
  }

  let sourceText = "";
  try {
    sourceText = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return {
      filePath,
      relativePath: toSafeRelative(workspaceCwd, filePath),
      language,
      packageName: "",
      definitions: [],
      references: [],
      imports: [],
      calls: [],
      parseError: normalizeText(error?.message) || "read_failed",
      skippedReason: ""
    };
  }

  if (sourceText.length > maxFileChars) {
    return {
      filePath,
      relativePath: toSafeRelative(workspaceCwd, filePath),
      language,
      packageName: "",
      definitions: [],
      references: [],
      imports: [],
      calls: [],
      parseError: "",
      skippedReason: "file_too_large"
    };
  }

  const parser = new TreeSitter.Parser();
  parser.setLanguage(parserLanguage);

  let tree = null;
  try {
    tree = parser.parse(sourceText);
  } catch (error) {
    parser.delete?.();
    return {
      filePath,
      relativePath: toSafeRelative(workspaceCwd, filePath),
      language,
      packageName: "",
      definitions: [],
      references: [],
      imports: [],
      calls: [],
      parseError: normalizeText(error?.message) || "parse_failed",
      skippedReason: ""
    };
  }

  const definitions = [];
  const references = [];
  const imports = [];
  const calls = [];
  const seenDefinitions = new Set();
  const seenReferences = new Set();
  const seenImports = new Set();
  const seenCalls = new Set();
  const rootNode = tree.rootNode;
  const packageName = extractPackageName(rootNode, sourceText);

  const stack = [rootNode];
  let visited = 0;
  while (stack.length > 0 && visited < maxAstNodes) {
    const node = stack.pop();
    if (!node || !node.isNamed) {
      continue;
    }
    visited += 1;
    const nodeType = normalizeText(node.type);
    const { line, column } = toLineColumn(node);

    if (isDefinitionNodeType(nodeType)) {
      const definitionNames = extractDefinitionNames(node, sourceText);
      const definitionKind = inferDefinitionKind(nodeType);
      for (const name of definitionNames) {
        const key = `${name}|${definitionKind}|${line}|${column}`;
        if (seenDefinitions.has(key)) {
          continue;
        }
        seenDefinitions.add(key);
        definitions.push({
          name,
          kind: definitionKind,
          line,
          column,
          exported: Boolean(name && /^[A-Z]/.test(name)),
          isDefaultExport: name === "default"
        });
      }
    }

    if (isImportNodeType(nodeType)) {
      const source = extractImportSource(node, sourceText);
      if (source) {
        const alias = extractImportAlias(node, sourceText, source);
        const importedName = alias && alias !== inferAliasFromSource(source) ? alias : "*";
        const key = `${source}|${alias}|${line}|${column}`;
        if (!seenImports.has(key)) {
          seenImports.add(key);
          imports.push({
            source,
            alias,
            importedName,
            line,
            column
          });
        }
      }
    }

    if (isCallNodeType(nodeType)) {
      const callee = extractCallCallee(node, sourceText);
      let callerName = "";
      let parentNode = node.parent;
      while (parentNode) {
        if (isDefinitionNodeType(parentNode.type)) {
          const callerNames = extractDefinitionNames(parentNode, sourceText);
          callerName = callerNames[0] ?? "";
          break;
        }
        parentNode = parentNode.parent;
      }

      const key = `${callee.calleeDisplayName}|${callee.calleeIdentifier}|${line}|${column}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        calls.push({
          line,
          column,
          callerName,
          calleeType: callee.calleeType,
          calleeDisplayName: callee.calleeDisplayName,
          calleeIdentifier: callee.calleeIdentifier,
          calleeObjectName: callee.calleeObjectName,
          calleePropertyName: callee.calleePropertyName
        });
      }
    }

    if (isIdentifierType(nodeType)) {
      const identifierName = extractNodeText(node, sourceText, 130);
      if (isLikelyIdentifier(identifierName)) {
        const parentType = normalizeText(node.parent?.type);
        if (
          !isDefinitionNodeType(parentType) &&
          !isImportNodeType(parentType) &&
          !isPackageNodeType(parentType)
        ) {
          const key = `${identifierName}|${line}|${column}`;
          if (!seenReferences.has(key)) {
            seenReferences.add(key);
            references.push({
              name: identifierName,
              line,
              column,
              contextType: parentType || "unknown"
            });
          }
        }
      }
    }

    const namedChildren = Array.isArray(node.namedChildren) ? node.namedChildren : [];
    for (let childIndex = namedChildren.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push(namedChildren[childIndex]);
    }
  }

  tree.delete?.();
  parser.delete?.();

  return {
    filePath,
    relativePath: toSafeRelative(workspaceCwd, filePath),
    language,
    packageName,
    definitions,
    references,
    imports,
    calls,
    parseError: "",
    skippedReason: visited >= maxAstNodes ? "ast_node_limit_reached" : ""
  };
}

function ensureArrayMapValue(map, key) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  return map.get(key);
}

function mergeUniqueById(items = []) {
  const seen = new Set();
  const merged = [];
  for (const item of items) {
    const itemId = normalizeText(item?.id);
    if (!itemId || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    merged.push(item);
  }
  return merged;
}

function sortByLocation(left, right) {
  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function isRelativeImport(source) {
  return source.startsWith("./") || source.startsWith("../");
}

async function resolveExistingPath(candidatePath) {
  try {
    const stats = await fs.stat(candidatePath);
    return {
      exists: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      path: path.resolve(candidatePath)
    };
  } catch {
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      path: path.resolve(candidatePath)
    };
  }
}

async function readGoModulePath(workspaceCwd) {
  const goModPath = path.resolve(workspaceCwd, "go.mod");
  try {
    const content = await fs.readFile(goModPath, "utf8");
    const match = content.match(/^\s*module\s+([^\s]+)\s*$/m);
    return normalizeText(match?.[1]);
  } catch {
    return "";
  }
}

function buildCandidateFilesForSource(source) {
  const candidates = new Set();
  const normalized = normalizeText(source);
  if (!normalized) {
    return [];
  }
  candidates.add(normalized);
  if (!path.extname(normalized)) {
    for (const extension of Object.keys(EXTENSION_TO_LANGUAGE)) {
      candidates.add(`${normalized}${extension}`);
      candidates.add(path.join(normalized, `index${extension}`));
      candidates.add(path.join(normalized, `__init__${extension}`));
    }
  }
  return Array.from(candidates);
}

async function resolveImportToPath({
  workspaceCwd,
  importerState,
  source,
  goModulePath
}) {
  const normalizedSource = normalizeText(source);
  if (!normalizedSource) {
    return {
      external: false,
      resolvedPath: ""
    };
  }

  const importerAbsolutePath = importerState.absolutePath;
  const importerLanguage = normalizeText(importerState.language).toLowerCase();

  const tryCandidates = async (baseDir, rawSource) => {
    const resolvedCandidates = [];
    for (const candidate of buildCandidateFilesForSource(rawSource)) {
      const absoluteCandidate = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(baseDir, candidate);
      resolvedCandidates.push(absoluteCandidate);
    }

    for (const absoluteCandidate of resolvedCandidates) {
      const existing = await resolveExistingPath(absoluteCandidate);
      if (existing.exists) {
        return existing.path;
      }
    }

    return "";
  };

  if (path.isAbsolute(normalizedSource) || isRelativeImport(normalizedSource)) {
    const resolved = await tryCandidates(path.dirname(importerAbsolutePath), normalizedSource);
    return {
      external: false,
      resolvedPath: resolved || path.resolve(path.dirname(importerAbsolutePath), normalizedSource)
    };
  }

  if (importerLanguage === "go") {
    if (goModulePath && (normalizedSource === goModulePath || normalizedSource.startsWith(`${goModulePath}/`))) {
      const suffix = normalizedSource === goModulePath ? "" : normalizedSource.slice(goModulePath.length + 1);
      const candidate = suffix ? path.resolve(workspaceCwd, suffix) : workspaceCwd;
      const existing = await resolveExistingPath(candidate);
      return {
        external: !existing.exists,
        resolvedPath: existing.path
      };
    }
    return {
      external: true,
      resolvedPath: ""
    };
  }

  if (importerLanguage === "python") {
    const dottedPath = normalizedSource.replace(/\./g, "/");
    const candidate = await tryCandidates(workspaceCwd, dottedPath);
    return {
      external: !candidate,
      resolvedPath: candidate
    };
  }

  if (["java", "kotlin", "scala", "csharp"].includes(importerLanguage)) {
    const dottedPath = normalizedSource.replace(/\./g, "/");
    const candidate = await tryCandidates(workspaceCwd, dottedPath);
    return {
      external: !candidate,
      resolvedPath: candidate
    };
  }

  if (["php", "ruby", "bash"].includes(importerLanguage)) {
    const candidate = await tryCandidates(path.dirname(importerAbsolutePath), normalizedSource);
    return {
      external: !candidate,
      resolvedPath: candidate
    };
  }

  return {
    external: true,
    resolvedPath: ""
  };
}

function resolveIndexedTargetFiles(resolvedPath, fileStateMap) {
  const normalizedPath = normalizeText(resolvedPath);
  if (!normalizedPath) {
    return [];
  }
  const absoluteResolved = path.resolve(normalizedPath);
  if (fileStateMap.has(absoluteResolved)) {
    return [absoluteResolved];
  }

  const results = [];
  const prefix = `${absoluteResolved}${path.sep}`;
  for (const filePath of fileStateMap.keys()) {
    if (filePath === absoluteResolved || filePath.startsWith(prefix)) {
      results.push(filePath);
    }
  }
  return results;
}

function pickLimited(items, maxResults) {
  return Array.isArray(items) ? items.slice(0, maxResults) : [];
}

async function buildAstIndex({
  workspaceCwd,
  targetPath,
  maxFiles,
  maxFileChars,
  maxAstNodes
}) {
  const sourceFiles = await collectSourceFiles(targetPath, maxFiles);
  const records = [];

  for (const filePath of sourceFiles) {
    const parsed = await parseSourceFile({
      filePath,
      workspaceCwd,
      maxFileChars,
      maxAstNodes
    });
    records.push(parsed);
  }

  const fileStateMap = new Map();
  const definitionsById = new Map();
  const definitionsByName = new Map();
  const definitionsByFileAndName = new Map();
  const definitionsByPackageAndName = new Map();
  const importsByFile = new Map();
  const outgoingEdgesByFile = new Map();
  const incomingEdgesByFile = new Map();
  const parseErrors = [];
  const skippedFiles = [];
  const unsupportedFiles = [];
  const languagesSeen = new Set();

  for (const record of records) {
    if (record.language) {
      languagesSeen.add(record.language);
    }
    if (record.parseError) {
      parseErrors.push({
        filePath: record.relativePath,
        message: record.parseError
      });
    }
    if (record.skippedReason) {
      skippedFiles.push({
        filePath: record.relativePath,
        reason: record.skippedReason
      });
      if (record.skippedReason.startsWith("missing_language_parser") || record.skippedReason === "unsupported_extension") {
        unsupportedFiles.push({
          filePath: record.relativePath,
          reason: record.skippedReason
        });
      }
    }

    if (record.parseError || record.skippedReason) {
      continue;
    }

    const packageName = normalizeText(record.packageName);
    const packageFallback = path.dirname(record.relativePath).replace(/\\/g, "/");
    const packageKey = `${record.language}:${packageName || packageFallback || "<root>"}`;
    const moduleDefinitionId = `module:${record.relativePath}`;
    const definitions = [
      {
        id: moduleDefinitionId,
        name: "<module>",
        kind: "module",
        filePath: record.relativePath,
        absolutePath: record.filePath,
        line: 1,
        column: 1,
        language: record.language,
        packageKey,
        exported: false,
        isDefaultExport: false
      }
    ];

    for (const [index, definition] of (record.definitions ?? []).entries()) {
      const definitionName = normalizeText(definition?.name);
      if (!definitionName) {
        continue;
      }
      const line = Number(definition?.line ?? 1);
      const column = Number(definition?.column ?? 1);
      const definitionKind = normalizeText(definition?.kind) || "declaration";
      const definitionId = `${record.relativePath}|${definitionKind}|${definitionName}|${line}|${column}|${index + 1}`;
      definitions.push({
        id: definitionId,
        name: definitionName,
        kind: definitionKind,
        filePath: record.relativePath,
        absolutePath: record.filePath,
        line,
        column,
        language: record.language,
        packageKey,
        exported: definition?.exported === true,
        isDefaultExport: definition?.isDefaultExport === true
      });
    }

    const state = {
      absolutePath: record.filePath,
      relativePath: record.relativePath,
      language: record.language,
      packageName,
      packageKey,
      moduleDefinitionId,
      definitions,
      references: Array.isArray(record.references) ? record.references : [],
      imports: Array.isArray(record.imports) ? record.imports.map((item) => ({ ...item })) : [],
      callsRaw: Array.isArray(record.calls) ? record.calls.map((item) => ({ ...item })) : [],
      importAliasMap: new Map()
    };
    fileStateMap.set(record.filePath, state);

    const fileNameMap = new Map();
    for (const definition of state.definitions) {
      definitionsById.set(definition.id, definition);
      ensureArrayMapValue(definitionsByName, definition.name).push(definition);
      ensureArrayMapValue(fileNameMap, definition.name).push(definition);
      const packageNameMap = definitionsByPackageAndName.get(definition.packageKey) ?? new Map();
      ensureArrayMapValue(packageNameMap, definition.name).push(definition);
      definitionsByPackageAndName.set(definition.packageKey, packageNameMap);
    }
    definitionsByFileAndName.set(state.absolutePath, fileNameMap);
  }

  const goModulePath = await readGoModulePath(workspaceCwd);
  for (const fileState of fileStateMap.values()) {
    for (const importRecord of fileState.imports) {
      const source = normalizeText(importRecord.source);
      if (!source) {
        continue;
      }
      const resolved = await resolveImportToPath({
        workspaceCwd,
        importerState: fileState,
        source,
        goModulePath
      });
      importRecord.external = resolved.external === true;
      importRecord.resolvedPath = normalizeText(resolved.resolvedPath);
      importRecord.targetFiles = importRecord.external
        ? []
        : resolveIndexedTargetFiles(importRecord.resolvedPath, fileStateMap);

      const alias = normalizeText(importRecord.alias) || inferAliasFromSource(source);
      if (alias) {
        fileState.importAliasMap.set(alias, importRecord);
      }

      for (const targetFile of importRecord.targetFiles) {
        const edge = {
          from: fileState.relativePath,
          to: toSafeRelative(workspaceCwd, targetFile),
          source,
          line: Number(importRecord.line ?? 1),
          column: Number(importRecord.column ?? 1)
        };
        ensureArrayMapValue(outgoingEdgesByFile, fileState.absolutePath).push(edge);
        ensureArrayMapValue(incomingEdgesByFile, targetFile).push(edge);
      }
    }
    importsByFile.set(fileState.absolutePath, fileState.imports);
  }

  const resolvedCalls = [];
  const callsByCaller = new Map();
  const callsByTarget = new Map();
  const unresolvedCalls = [];

  for (const fileState of fileStateMap.values()) {
    for (const rawCall of fileState.callsRaw) {
      const callerName = normalizeText(rawCall.callerName);
      const callerDefinitionsInFile = callerName
        ? definitionsByFileAndName.get(fileState.absolutePath)?.get(callerName) ?? []
        : [];
      const callerDefinition =
        callerDefinitionsInFile[0] ??
        definitionsByPackageAndName.get(fileState.packageKey)?.get(callerName)?.[0] ??
        definitionsById.get(fileState.moduleDefinitionId);
      const callerDefinitionId = callerDefinition?.id ?? fileState.moduleDefinitionId;

      const call = {
        callerDefinitionId,
        callerName: callerDefinition?.name ?? "<module>",
        filePath: fileState.relativePath,
        absoluteFilePath: fileState.absolutePath,
        line: Number(rawCall.line ?? 1),
        column: Number(rawCall.column ?? 1),
        calleeType: normalizeText(rawCall.calleeType) || "unknown",
        calleeDisplayName: normalizeText(rawCall.calleeDisplayName) || "<expression>",
        calleeIdentifier: normalizeText(rawCall.calleeIdentifier),
        calleeObjectName: normalizeText(rawCall.calleeObjectName),
        calleePropertyName: normalizeText(rawCall.calleePropertyName),
        targets: [],
        unresolved: []
      };

      const targetDefinitions = [];
      if (call.calleeType === "identifier" && call.calleeIdentifier) {
        targetDefinitions.push(
          ...(definitionsByFileAndName.get(fileState.absolutePath)?.get(call.calleeIdentifier) ?? [])
        );
        targetDefinitions.push(
          ...(definitionsByPackageAndName.get(fileState.packageKey)?.get(call.calleeIdentifier) ?? [])
        );
        targetDefinitions.push(...(definitionsByName.get(call.calleeIdentifier) ?? []));
      } else if (call.calleeType === "member" && call.calleePropertyName) {
        const objectName = normalizeText(call.calleeObjectName);
        const aliasImport = objectName ? fileState.importAliasMap.get(objectName) : null;
        if (aliasImport && Array.isArray(aliasImport.targetFiles) && aliasImport.targetFiles.length > 0) {
          for (const targetFile of aliasImport.targetFiles) {
            targetDefinitions.push(
              ...(definitionsByFileAndName.get(targetFile)?.get(call.calleePropertyName) ?? [])
            );
          }
        } else if (objectName && PYTHON_SELF_NAMES.has(objectName.toLowerCase())) {
          targetDefinitions.push(
            ...(definitionsByFileAndName.get(fileState.absolutePath)?.get(call.calleePropertyName) ?? [])
          );
        } else {
          targetDefinitions.push(...(definitionsByName.get(call.calleePropertyName) ?? []));
        }
      }

      const mergedTargets = mergeUniqueById(targetDefinitions.filter((item) => item?.kind !== "module"));
      call.targets = mergedTargets.map((item) => item.id);
      if (call.targets.length === 0) {
        const reason =
          call.calleeType === "unknown"
            ? "unknown_callee"
            : call.calleeType === "member"
              ? "unresolved_member"
              : "unresolved_identifier";
        call.unresolved.push({
          reason,
          symbol: call.calleeDisplayName
        });
        unresolvedCalls.push({
          callerDefinitionId: call.callerDefinitionId,
          callerName: call.callerName,
          filePath: call.filePath,
          line: call.line,
          column: call.column,
          symbol: call.calleeDisplayName,
          reason
        });
      }

      resolvedCalls.push(call);
      ensureArrayMapValue(callsByCaller, call.callerDefinitionId).push(call);
      for (const targetDefinitionId of call.targets) {
        ensureArrayMapValue(callsByTarget, targetDefinitionId).push(call);
      }
    }
  }

  const definitionCount = Array.from(fileStateMap.values()).reduce(
    (acc, state) => acc + state.definitions.length,
    0
  );
  const referenceCount = Array.from(fileStateMap.values()).reduce(
    (acc, state) => acc + state.references.length,
    0
  );
  const callCount = resolvedCalls.length;
  const importCount = Array.from(fileStateMap.values()).reduce(
    (acc, state) => acc + state.imports.length,
    0
  );

  return {
    workspaceCwd,
    targetPath,
    sourceFiles,
    fileStateMap,
    definitionsById,
    definitionsByName,
    definitionsByFileAndName,
    definitionsByPackageAndName,
    importsByFile,
    outgoingEdgesByFile,
    incomingEdgesByFile,
    resolvedCalls,
    callsByCaller,
    callsByTarget,
    unresolvedCalls,
    parseErrors,
    skippedFiles,
    unsupportedFiles,
    languagesSeen: Array.from(languagesSeen).sort((a, b) => a.localeCompare(b)),
    summary: {
      scannedSourceFiles: sourceFiles.length,
      parsedSourceFiles: fileStateMap.size,
      parseErrorCount: parseErrors.length,
      skippedFileCount: skippedFiles.length,
      unsupportedFileCount: unsupportedFiles.length,
      missingLanguageParserCount: languageLoadFailures.size,
      definitionCount,
      referenceCount,
      callCount,
      importCount
    }
  };
}

function findSymbolAction(indexData, symbol, maxResults) {
  const normalizedSymbol = normalizeText(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required for action=find_symbol");
  }

  const definitions = [...(indexData.definitionsByName.get(normalizedSymbol) ?? [])]
    .filter((item) => item.kind !== "module")
    .sort(sortByLocation);

  const references = [];
  for (const fileState of indexData.fileStateMap.values()) {
    for (const reference of fileState.references) {
      if (normalizeText(reference.name) !== normalizedSymbol) {
        continue;
      }
      references.push({
        filePath: fileState.relativePath,
        line: Number(reference.line ?? 1),
        column: Number(reference.column ?? 1),
        contextType: normalizeText(reference.contextType) || "unknown"
      });
    }
  }
  references.sort(sortByLocation);

  const callSites = indexData.resolvedCalls
    .filter(
      (item) =>
        item.calleeIdentifier === normalizedSymbol ||
        item.calleePropertyName === normalizedSymbol
    )
    .map((item) => ({
      filePath: item.filePath,
      line: item.line,
      column: item.column,
      callerName: item.callerName,
      callee: item.calleeDisplayName
    }))
    .sort(sortByLocation);

  return {
    action: "find_symbol",
    symbol: normalizedSymbol,
    summary: {
      definitionCount: definitions.length,
      referenceCount: references.length,
      callSiteCount: callSites.length
    },
    definitions: pickLimited(definitions, maxResults),
    references: pickLimited(references, maxResults),
    callSites: pickLimited(callSites, maxResults)
  };
}

async function resolveEntryAbsolutePath(workspaceCwd, targetPath, entryFile) {
  const normalizedEntryFile = normalizeText(entryFile);
  if (!normalizedEntryFile) {
    throw new Error("entryFile is required for action=dependency_graph");
  }

  const firstCandidate = path.isAbsolute(normalizedEntryFile)
    ? path.resolve(normalizedEntryFile)
    : path.resolve(workspaceCwd, normalizedEntryFile);
  try {
    const firstStats = await fs.stat(firstCandidate);
    if (firstStats.isFile()) {
      return firstCandidate;
    }
  } catch {
    // fallthrough
  }

  const secondCandidate = path.resolve(targetPath, normalizedEntryFile);
  try {
    const secondStats = await fs.stat(secondCandidate);
    if (secondStats.isFile()) {
      return secondCandidate;
    }
  } catch {
    // fallthrough
  }

  throw new Error(`entryFile does not exist: ${normalizedEntryFile}`);
}

function dependencyGraphAction(indexData, entryAbsolutePath, direction, maxDepth, maxResults) {
  const normalizedDirection = normalizeDirection(direction, "both");
  if (!indexData.fileStateMap.has(entryAbsolutePath)) {
    throw new Error("entryFile is outside indexed source set");
  }

  const visitedDepth = new Map([[entryAbsolutePath, 0]]);
  const layers = new Map([[0, new Set([entryAbsolutePath])]]);
  const queue = [{ filePath: entryAbsolutePath, depth: 0 }];
  const edges = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const nextDepth = current.depth + 1;

    if (normalizedDirection === "outgoing" || normalizedDirection === "both") {
      for (const edge of indexData.outgoingEdgesByFile.get(current.filePath) ?? []) {
        edges.push({
          from: edge.from,
          to: edge.to,
          direction: "outgoing",
          source: edge.source,
          line: edge.line,
          column: edge.column
        });

        const targetAbsolutePath = path.resolve(indexData.workspaceCwd, edge.to);
        const knownDepth = visitedDepth.get(targetAbsolutePath);
        if (knownDepth === undefined || nextDepth < knownDepth) {
          visitedDepth.set(targetAbsolutePath, nextDepth);
          if (!layers.has(nextDepth)) {
            layers.set(nextDepth, new Set());
          }
          layers.get(nextDepth).add(targetAbsolutePath);
          queue.push({
            filePath: targetAbsolutePath,
            depth: nextDepth
          });
        }
      }
    }

    if (normalizedDirection === "incoming" || normalizedDirection === "both") {
      for (const edge of indexData.incomingEdgesByFile.get(current.filePath) ?? []) {
        edges.push({
          from: edge.from,
          to: edge.to,
          direction: "incoming",
          source: edge.source,
          line: edge.line,
          column: edge.column
        });

        const sourceAbsolutePath = path.resolve(indexData.workspaceCwd, edge.from);
        const knownDepth = visitedDepth.get(sourceAbsolutePath);
        if (knownDepth === undefined || nextDepth < knownDepth) {
          visitedDepth.set(sourceAbsolutePath, nextDepth);
          if (!layers.has(nextDepth)) {
            layers.set(nextDepth, new Set());
          }
          layers.get(nextDepth).add(sourceAbsolutePath);
          queue.push({
            filePath: sourceAbsolutePath,
            depth: nextDepth
          });
        }
      }
    }
  }

  const outputLayers = Array.from(layers.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([depth, fileSet]) => ({
      depth,
      files: Array.from(fileSet)
        .map((item) => toSafeRelative(indexData.workspaceCwd, item))
        .sort((a, b) => a.localeCompare(b))
    }));

  return {
    action: "dependency_graph",
    entryFile: toSafeRelative(indexData.workspaceCwd, entryAbsolutePath),
    direction: normalizedDirection,
    maxDepth,
    summary: {
      reachableFileCount: visitedDepth.size,
      edgeCount: edges.length
    },
    layers: pickLimited(outputLayers, maxResults),
    edges: pickLimited(edges, maxResults)
  };
}

function callGraphAction(indexData, symbol, direction, maxDepth, maxResults) {
  const normalizedSymbol = normalizeText(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required for action=call_graph");
  }

  const normalizedDirection = normalizeDirection(direction, "outgoing");
  const startDefinitions = mergeUniqueById(
    (indexData.definitionsByName.get(normalizedSymbol) ?? []).filter((item) => item.kind !== "module")
  );

  const queue = startDefinitions.map((item) => ({
    definitionId: item.id,
    depth: 0
  }));
  const visitedDepth = new Map(startDefinitions.map((item) => [item.id, 0]));
  const nodes = new Map(startDefinitions.map((item) => [item.id, item]));
  const edges = [];
  const unresolved = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }
    const nextDepth = current.depth + 1;

    if (normalizedDirection === "outgoing" || normalizedDirection === "both") {
      for (const call of indexData.callsByCaller.get(current.definitionId) ?? []) {
        if (call.targets.length === 0) {
          unresolved.push({
            callerDefinitionId: call.callerDefinitionId,
            callerName: call.callerName,
            filePath: call.filePath,
            line: call.line,
            column: call.column,
            symbol: call.calleeDisplayName
          });
          continue;
        }

        for (const targetId of call.targets) {
          const targetDefinition = indexData.definitionsById.get(targetId);
          if (!targetDefinition) {
            continue;
          }
          nodes.set(targetDefinition.id, targetDefinition);
          edges.push({
            fromDefinitionId: call.callerDefinitionId,
            toDefinitionId: targetDefinition.id,
            fromName: call.callerName,
            toName: targetDefinition.name,
            callee: call.calleeDisplayName,
            filePath: call.filePath,
            line: call.line,
            column: call.column,
            direction: "outgoing"
          });

          const knownDepth = visitedDepth.get(targetDefinition.id);
          if (knownDepth === undefined || nextDepth < knownDepth) {
            visitedDepth.set(targetDefinition.id, nextDepth);
            queue.push({
              definitionId: targetDefinition.id,
              depth: nextDepth
            });
          }
        }
      }
    }

    if (normalizedDirection === "incoming" || normalizedDirection === "both") {
      for (const call of indexData.callsByTarget.get(current.definitionId) ?? []) {
        const callerDefinition = indexData.definitionsById.get(call.callerDefinitionId);
        if (!callerDefinition) {
          continue;
        }

        nodes.set(callerDefinition.id, callerDefinition);
        edges.push({
          fromDefinitionId: callerDefinition.id,
          toDefinitionId: current.definitionId,
          fromName: callerDefinition.name,
          toName: indexData.definitionsById.get(current.definitionId)?.name ?? "",
          callee: call.calleeDisplayName,
          filePath: call.filePath,
          line: call.line,
          column: call.column,
          direction: "incoming"
        });

        const knownDepth = visitedDepth.get(callerDefinition.id);
        if (knownDepth === undefined || nextDepth < knownDepth) {
          visitedDepth.set(callerDefinition.id, nextDepth);
          queue.push({
            definitionId: callerDefinition.id,
            depth: nextDepth
          });
        }
      }
    }
  }

  const outputNodes = Array.from(nodes.values()).sort(sortByLocation);
  const outputEdges = edges.sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.column - right.column;
  });
  const outputUnresolved = unresolved.sort(sortByLocation);

  return {
    action: "call_graph",
    symbol: normalizedSymbol,
    direction: normalizedDirection,
    maxDepth,
    summary: {
      startDefinitionCount: startDefinitions.length,
      visitedNodeCount: outputNodes.length,
      edgeCount: outputEdges.length,
      unresolvedCallCount: outputUnresolved.length
    },
    startDefinitions: pickLimited(startDefinitions, maxResults),
    nodes: pickLimited(outputNodes, maxResults),
    edges: pickLimited(outputEdges, maxResults),
    unresolvedCalls: pickLimited(outputUnresolved, maxResults)
  };
}

function normalizeAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["find_symbol", "dependency_graph", "call_graph"].includes(normalized)) {
    return normalized;
  }
  return "";
}

export default {
  name: "reviewer_ast_navigator",
  description:
    "Reviewer-only multi-language AST navigator for symbol lookup, dependency graph tracing, and call graph tracing.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["find_symbol", "dependency_graph", "call_graph"],
        description:
          "find_symbol=定位符号定义/引用; dependency_graph=逐层追踪文件依赖; call_graph=逐层追踪调用链"
      },
      symbol: {
        type: "string",
        description: "Symbol name used by find_symbol and call_graph."
      },
      entryFile: {
        type: "string",
        description: "Entry file path used by dependency_graph."
      },
      path: {
        type: "string",
        description: "Scope path (workspace-relative or absolute).",
        default: "."
      },
      direction: {
        type: "string",
        enum: ["outgoing", "incoming", "both"],
        description: "Traversal direction for graph actions.",
        default: "both"
      },
      maxDepth: {
        type: "integer",
        description: "Max graph traversal depth.",
        default: 3
      },
      maxFiles: {
        type: "integer",
        description: "Max files indexed for AST analysis.",
        default: 1000
      },
      maxFileChars: {
        type: "integer",
        description: "Skip files larger than this size to avoid parser overload.",
        default: 1000000
      },
      maxAstNodes: {
        type: "integer",
        description: "Max AST named nodes traversed per file.",
        default: 120000
      },
      maxResults: {
        type: "integer",
        description: "Max returned items per collection.",
        default: 200
      }
    },
    required: ["action"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const action = normalizeAction(args.action);
    if (!action) {
      throw new Error("action must be one of: find_symbol, dependency_graph, call_graph");
    }

    const workspaceCwd = resolveContextWorkingDirectory(executionContext, args.cwd);
    await ensureDirectory(workspaceCwd);
    const targetPath = resolveTargetPath(workspaceCwd, args.path);
    const maxFiles = normalizePositiveInteger(args.maxFiles, 1000, 1, 12000);
    const maxFileChars = normalizePositiveInteger(args.maxFileChars, 1000000, 10000, 8000000);
    const maxAstNodes = normalizePositiveInteger(args.maxAstNodes, DEFAULT_MAX_AST_NODES, 2000, 500000);
    const maxDepth = normalizePositiveInteger(args.maxDepth, 3, 1, 16);
    const maxResults = normalizePositiveInteger(args.maxResults, 200, 20, 5000);

    const indexData = await buildAstIndex({
      workspaceCwd,
      targetPath,
      maxFiles,
      maxFileChars,
      maxAstNodes
    });

    let result;
    if (action === "find_symbol") {
      result = findSymbolAction(indexData, args.symbol, maxResults);
    } else if (action === "dependency_graph") {
      const entryAbsolutePath = await resolveEntryAbsolutePath(workspaceCwd, targetPath, args.entryFile);
      result = dependencyGraphAction(indexData, entryAbsolutePath, args.direction, maxDepth, maxResults);
    } else {
      result = callGraphAction(indexData, args.symbol, args.direction, maxDepth, maxResults);
    }

    return {
      tool: "reviewer_ast_navigator",
      workspaceCwd,
      targetPath: path.resolve(targetPath),
      indexSummary: indexData.summary,
      parseErrors: pickLimited(indexData.parseErrors, maxResults),
      skippedFiles: pickLimited(indexData.skippedFiles, maxResults),
      unsupportedFiles: pickLimited(indexData.unsupportedFiles, maxResults),
      result
    };
  }
};
