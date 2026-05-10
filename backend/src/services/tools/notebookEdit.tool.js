import fs from "node:fs/promises";
import path from "node:path";

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

  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }

  return path.resolve(cwd, candidate);
}

async function ensureDirectory(dirPath) {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error("cwd must be a directory");
  }
}

async function loadNotebook(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const notebook = JSON.parse(content);

  if (!notebook || typeof notebook !== "object" || Array.isArray(notebook)) {
    throw new Error("Notebook file must contain a JSON object.");
  }

  if (!Array.isArray(notebook.cells)) {
    throw new Error("Notebook file is missing cells array.");
  }

  return notebook;
}

function normalizeSourceText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? ""));
  }

  const text = String(value ?? "");
  return text.replace(/\r\n/g, "\n").split("\n");
}

function sourceArrayToText(source) {
  if (Array.isArray(source)) {
    return source.map((item) => String(item ?? "")).join("");
  }

  return String(source ?? "");
}

function clearCodeCellArtifacts(cell) {
  if (!cell || cell.cell_type !== "code") {
    return;
  }

  cell.outputs = [];
  cell.execution_count = null;
}

function createNotebookCell(cellType, sourceLines) {
  const normalizedType = cellType === "markdown" || cellType === "raw" ? cellType : "code";
  const cell = {
    cell_type: normalizedType,
    metadata: {},
    source: sourceLines
  };

  if (normalizedType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  }

  return cell;
}

function locateCell(notebook, operation) {
  if (Number.isInteger(operation.cellIndex)) {
    if (operation.cellIndex < 0 || operation.cellIndex >= notebook.cells.length) {
      return -1;
    }

    return operation.cellIndex;
  }

  if (typeof operation.cellId === "string" && operation.cellId.trim()) {
    const targetId = operation.cellId.trim();
    const index = notebook.cells.findIndex((cell) => String(cell?.id ?? "").trim() === targetId);
    return index;
  }

  return -1;
}

function normalizeOperation(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`operations[${index}] must be an object`);
  }

  const action = String(entry.action ?? "replace").trim().toLowerCase();
  const allowedActions = new Set([
    "replace",
    "append",
    "prepend",
    "delete",
    "insertbefore",
    "insertafter"
  ]);

  if (!allowedActions.has(action)) {
    throw new Error(`operations[${index}].action is invalid`);
  }

  const cellIndex =
    entry.cellIndex === undefined || entry.cellIndex === null
      ? null
      : Number.isInteger(entry.cellIndex)
        ? entry.cellIndex
        : null;

  return {
    action,
    cellIndex,
    cellId: typeof entry.cellId === "string" ? entry.cellId.trim() : "",
    source:
      typeof entry.source === "string"
        ? entry.source
        : Array.isArray(entry.source)
          ? entry.source.map((item) => String(item ?? "")).join("")
          : "",
    cellType: typeof entry.cellType === "string" ? entry.cellType.trim().toLowerCase() : "",
    createIfMissing: Boolean(entry.createIfMissing)
  };
}

function normalizeOperations(args = {}) {
  if (Array.isArray(args.operations) && args.operations.length > 0) {
    return args.operations;
  }

  return [
    {
      action: args.action,
      cellIndex: args.cellIndex,
      cellId: args.cellId,
      source: args.source,
      cellType: args.cellType,
      createIfMissing: args.createIfMissing
    }
  ];
}

function updateCellSource(cell, action, sourceText) {
  const current = sourceArrayToText(cell.source);

  let nextText = current;
  if (action === "append") {
    nextText = `${current}${sourceText}`;
  } else if (action === "prepend") {
    nextText = `${sourceText}${current}`;
  } else {
    nextText = sourceText;
  }

  cell.source = normalizeSourceText(nextText);
  clearCodeCellArtifacts(cell);
}

function insertNotebookCell(notebook, anchorIndex, action, cellType, sourceText, createIfMissing) {
  const newCell = createNotebookCell(cellType, normalizeSourceText(sourceText));

  if (action === "insertbefore") {
    const insertIndex = anchorIndex >= 0 ? anchorIndex : createIfMissing ? 0 : -1;
    if (insertIndex < 0) {
      throw new Error("Target cell not found.");
    }
    notebook.cells.splice(insertIndex, 0, newCell);
    return insertIndex;
  }

  const insertIndex =
    anchorIndex >= 0 ? anchorIndex + 1 : createIfMissing ? notebook.cells.length : -1;
  if (insertIndex < 0) {
    throw new Error("Target cell not found.");
  }
  notebook.cells.splice(insertIndex, 0, newCell);
  return insertIndex;
}

function applyNotebookOperation(notebook, operation, index) {
  const normalized = normalizeOperation(operation, index);
  const anchorIndex = locateCell(notebook, normalized);
  const sourceText = String(normalized.source ?? "");

  if (normalized.action === "delete") {
    if (anchorIndex < 0) {
      throw new Error(`operations[${index}] target cell not found`);
    }

    const [removed] = notebook.cells.splice(anchorIndex, 1);
    return {
      index,
      action: "delete",
      cellIndex: anchorIndex,
      cellId: removed?.id ?? null,
      changed: true
    };
  }

  if (normalized.action === "insertbefore" || normalized.action === "insertafter") {
    const insertedIndex = insertNotebookCell(
      notebook,
      anchorIndex,
      normalized.action,
      normalized.cellType,
      sourceText,
      normalized.createIfMissing
    );

    return {
      index,
      action: normalized.action,
      cellIndex: insertedIndex,
      cellId: notebook.cells[insertedIndex]?.id ?? null,
      changed: true
    };
  }

  if (anchorIndex < 0) {
    if (!normalized.createIfMissing) {
      throw new Error(`operations[${index}] target cell not found`);
    }

    const newCell = createNotebookCell(normalized.cellType, normalizeSourceText(sourceText));
    notebook.cells.push(newCell);
    return {
      index,
      action: "create",
      cellIndex: notebook.cells.length - 1,
      cellId: newCell.id ?? null,
      changed: true
    };
  }

  const cell = notebook.cells[anchorIndex];
  if (!cell || typeof cell !== "object") {
    throw new Error(`operations[${index}] target cell is invalid`);
  }

  if (normalized.action === "replace") {
    cell.source = normalizeSourceText(sourceText);
    if (normalized.cellType) {
      cell.cell_type = normalized.cellType === "markdown" || normalized.cellType === "raw"
        ? normalized.cellType
        : "code";
      if (cell.cell_type !== "code") {
        delete cell.outputs;
        delete cell.execution_count;
      } else {
        cell.outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
        cell.execution_count = null;
      }
    } else {
      clearCodeCellArtifacts(cell);
    }

    return {
      index,
      action: "replace",
      cellIndex: anchorIndex,
      cellId: cell.id ?? null,
      changed: true
    };
  }

  if (normalized.action === "append" || normalized.action === "prepend") {
    updateCellSource(cell, normalized.action, sourceText);
    return {
      index,
      action: normalized.action,
      cellIndex: anchorIndex,
      cellId: cell.id ?? null,
      changed: true
    };
  }

  throw new Error(`operations[${index}] uses unsupported action`);
}

export default {
  name: "NotebookEdit",
  description:
    "Edit Jupyter notebook cells by index or cell id. Use replace/append/prepend to modify a cell's source, and use insertBefore/insertAfter to add new cells around the target cell.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Target notebook path. Supports absolute path or relative path."
      },
      cwd: {
        type: "string",
        description:
          "Optional absolute working directory for resolving relative filePath. Defaults to current conversation workplace."
      },
      action: {
        type: "string",
        description:
          "Single-operation action. replace/append/prepend change an existing cell; insertBefore/insertAfter create a new cell around the target.",
        enum: ["replace", "append", "prepend", "delete", "insertBefore", "insertAfter"]
      },
      cellIndex: {
        type: "integer",
        description: "0-based cell index for the single-operation form."
      },
      cellId: {
        type: "string",
        description: "Cell id for the single-operation form."
      },
      source: {
        type: "string",
        description:
          "Cell source text. For append/prepend, this text is merged into the current cell source. For insertBefore/insertAfter, this text becomes the new cell source."
      },
      cellType: {
        type: "string",
        description: "Cell type for created or inserted cells.",
        enum: ["code", "markdown", "raw"]
      },
      createIfMissing: {
        type: "boolean",
        description:
          "When true, create a new cell if the target cell does not exist. Useful for append/prepend when bootstrapping a notebook."
      },
      operations: {
        type: "array",
        description: "Optional batch of notebook cell operations.",
        items: {
          type: "object"
        }
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

    await ensureDirectory(cwd);

    const notebookPath = resolveTargetPath(args.filePath, cwd);
    const notebookStats = await fs.stat(notebookPath).catch(() => null);

    if (!notebookStats) {
      throw new Error(`Notebook not found: ${notebookPath}`);
    }

    if (!notebookStats.isFile()) {
      throw new Error("filePath points to a directory");
    }

    const notebook = await loadNotebook(notebookPath);
    const operations = normalizeOperations(args);
    const results = [];

    for (let index = 0; index < operations.length; index += 1) {
      const result = applyNotebookOperation(notebook, operations[index], index);
      results.push(result);
    }

    await fs.writeFile(notebookPath, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");

    return {
      filePath: notebookPath,
      cwd,
      operationCount: results.length,
      results
    };
  }
};
