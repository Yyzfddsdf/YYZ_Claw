function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolName(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeBackendView(view) {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    return null;
  }

  const files = Array.isArray(view.files)
    ? view.files
        .map((file, fileIndex) => {
          if (!file || typeof file !== "object" || Array.isArray(file)) {
            return null;
          }

          const path = normalizeText(file.path);
          if (!path) {
            return null;
          }

          return {
            id: String(file.id ?? `${normalizeText(view.kind) || "tool"}:${fileIndex + 1}`).trim(),
            path,
            action: normalizeText(file.action) || "update",
            actionLabel: normalizeText(file.actionLabel) || "修改文件",
            moveTo: normalizeText(file.moveTo),
            note: normalizeText(file.note),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            hunks: Array.isArray(file.hunks)
              ? file.hunks.map((hunk) => ({
                  header: normalizeText(hunk?.header),
                  oldStart: Number.isFinite(Number(hunk?.oldStart)) ? Number(hunk.oldStart) : null,
                  oldCount: Number.isFinite(Number(hunk?.oldCount)) ? Number(hunk.oldCount) : 0,
                  newStart: Number.isFinite(Number(hunk?.newStart)) ? Number(hunk.newStart) : null,
                  newCount: Number.isFinite(Number(hunk?.newCount)) ? Number(hunk.newCount) : 0
                }))
              : []
          };
        })
        .filter(Boolean)
    : [];

  if (files.length === 0) {
    return null;
  }

  return {
    kind: normalizeText(view.kind) || "tool",
    summaryText: normalizeText(view.summaryText) || (files.length === 1 ? files[0].path : `${files.length} 个文件改动`),
    files
  };
}

function mergeViewMetadata(baseView, backendView) {
  if (!baseView) {
    return backendView;
  }
  if (!backendView) {
    return baseView;
  }

  return {
    ...baseView,
    kind: backendView.kind || baseView.kind,
    summaryText: backendView.summaryText || baseView.summaryText,
    files: (Array.isArray(baseView.files) ? baseView.files : []).map((file, fileIndex) => {
      const backendFile = Array.isArray(backendView.files) ? backendView.files[fileIndex] : null;
      if (!backendFile) {
        return file;
      }

      return {
        ...file,
        action: backendFile.action || file.action,
        actionLabel: backendFile.actionLabel || file.actionLabel,
        moveTo: backendFile.moveTo || file.moveTo,
        note: backendFile.note || file.note,
        additions: Number.isFinite(Number(backendFile.additions)) ? Number(backendFile.additions) : file.additions,
        deletions: Number.isFinite(Number(backendFile.deletions)) ? Number(backendFile.deletions) : file.deletions,
        hunks: (Array.isArray(file.hunks) ? file.hunks : []).map((hunk, hunkIndex) => {
          const backendHunk = Array.isArray(backendFile.hunks) ? backendFile.hunks[hunkIndex] : null;
          if (!backendHunk) {
            return hunk;
          }
          return annotateHunkWithExplicitStarts({
            ...hunk,
            header: backendHunk.header || hunk.header,
            oldStart: backendHunk.oldStart ?? hunk.oldStart,
            oldCount: backendHunk.oldCount ?? hunk.oldCount,
            newStart: backendHunk.newStart ?? hunk.newStart,
            newCount: backendHunk.newCount ?? hunk.newCount
          }, backendFile.action || file.action, backendHunk.oldStart ?? hunk.oldStart, backendHunk.newStart ?? hunk.newStart);
        })
      };
    })
  };
}

function toLines(content) {
  const source = typeof content === "string" ? content.replace(/\r\n/g, "\n") : "";
  if (source.length === 0) {
    return [];
  }
  return source.split("\n");
}

function createHunk(header = "", lines = []) {
  return {
    header: normalizeText(header),
    lines: Array.isArray(lines) ? lines : []
  };
}

function createLine(kind, text) {
  return {
    kind,
    text: typeof text === "string" ? text : "",
    oldLineNumber: null,
    newLineNumber: null
  };
}

function parseHunkLineNumbers(header = "") {
  const match = String(header)
    .trim()
    .match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);

  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2])
  };
}

function annotateHunkLineNumbers(hunk, action = "") {
  if (!hunk || !Array.isArray(hunk.lines)) {
    return hunk;
  }

  const normalizedAction = normalizeText(action).toLowerCase();
  const parsed = parseHunkLineNumbers(hunk.header);
  let oldLine =
    normalizedAction === "delete"
      ? 1
      : parsed && Number.isFinite(parsed.oldStart)
        ? parsed.oldStart
        : null;
  let newLine =
    normalizedAction === "add" || normalizedAction === "append" || normalizedAction === "create" || normalizedAction === "overwrite"
      ? 1
      : parsed && Number.isFinite(parsed.newStart)
        ? parsed.newStart
        : null;

  return {
    ...hunk,
    lines: hunk.lines.map((line) => {
      const nextLine = { ...line, oldLineNumber: null, newLineNumber: null };

      if (line.kind === "add") {
        if (newLine !== null) {
          nextLine.newLineNumber = newLine;
          newLine += 1;
        }
        return nextLine;
      }

      if (line.kind === "remove") {
        if (oldLine !== null) {
          nextLine.oldLineNumber = oldLine;
          oldLine += 1;
        }
        return nextLine;
      }

      if (oldLine !== null) {
        nextLine.oldLineNumber = oldLine;
        oldLine += 1;
      }
      if (newLine !== null) {
        nextLine.newLineNumber = newLine;
        newLine += 1;
      }
      return nextLine;
    })
  };
}

function annotateHunkWithExplicitStarts(hunk, action = "", oldStart = null, newStart = null) {
  if (!hunk || !Array.isArray(hunk.lines)) {
    return hunk;
  }

  const normalizedAction = normalizeText(action).toLowerCase();
  let oldLine =
    Number.isFinite(Number(oldStart))
      ? Number(oldStart)
      : normalizedAction === "delete"
        ? 1
        : null;
  let newLine =
    Number.isFinite(Number(newStart))
      ? Number(newStart)
      : normalizedAction === "add" || normalizedAction === "append" || normalizedAction === "create" || normalizedAction === "overwrite"
        ? 1
        : null;

  return {
    ...hunk,
    lines: hunk.lines.map((line) => {
      const nextLine = { ...line, oldLineNumber: null, newLineNumber: null };

      if (line.kind === "add") {
        if (newLine !== null) {
          nextLine.newLineNumber = newLine;
          newLine += 1;
        }
        return nextLine;
      }

      if (line.kind === "remove") {
        if (oldLine !== null) {
          nextLine.oldLineNumber = oldLine;
          oldLine += 1;
        }
        return nextLine;
      }

      if (oldLine !== null) {
        nextLine.oldLineNumber = oldLine;
        oldLine += 1;
      }
      if (newLine !== null) {
        nextLine.newLineNumber = newLine;
        newLine += 1;
      }
      return nextLine;
    })
  };
}

function countKinds(hunks = []) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (line.kind === "add") {
        additions += 1;
      } else if (line.kind === "remove") {
        deletions += 1;
      }
    }
  }

  return {
    additions,
    deletions
  };
}

function createWriteFileView(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const filePath = normalizeText(entry.filePath);
  if (!filePath) {
    return null;
  }

  const content = typeof entry.content === "string" ? entry.content : "";
  const append = Boolean(entry.append);
  const overwrite = Boolean(entry.overwrite);
  const action = append ? "append" : overwrite ? "overwrite" : "create";
  const actionLabel =
    action === "append"
      ? "追加写入"
      : action === "overwrite"
        ? "覆盖写入"
        : "新建写入";
  const lines = toLines(content).map((line) => createLine("add", line));
  const hunks = [createHunk(actionLabel, lines)];
  const annotatedHunks = hunks.map((hunk) => annotateHunkLineNumbers(hunk, action));
  const stats = countKinds(annotatedHunks);

  return {
    id: `write:${index}:${filePath}`,
    path: filePath,
    action,
    actionLabel,
    note: overwrite ? "未提供旧内容，以下为将写入的新内容。" : "",
    hunks: annotatedHunks,
    ...stats
  };
}

function buildWriteToolPreview(argumentsObject) {
  const args =
    argumentsObject && typeof argumentsObject === "object" && !Array.isArray(argumentsObject)
      ? argumentsObject
      : {};
  const operations =
    Array.isArray(args.operations) && args.operations.length > 0
      ? args.operations
      : normalizeText(args.filePath)
        ? [args]
        : [];

  const files = operations
    .map((entry, index) => createWriteFileView(entry, index))
    .filter(Boolean);

  if (files.length === 0) {
    return null;
  }

  return {
    kind: "write",
    summaryText:
      files.length === 1
        ? files[0].path
        : `${files.length} 个文件写入`,
    files
  };
}

function isStructuredPatch(patch) {
  const trimmed = String(patch ?? "").trimStart();
  return (
    trimmed.startsWith("*** Begin Patch") ||
    trimmed.startsWith("*** Update File:") ||
    trimmed.startsWith("*** Add File:") ||
    trimmed.startsWith("*** Delete File:")
  );
}

function finalizePatchFile(files, currentFile) {
  if (!currentFile || !currentFile.path) {
    return;
  }
  const stats = countKinds(currentFile.hunks);
  files.push({
    ...currentFile,
    hunks: currentFile.hunks.map((hunk) => annotateHunkLineNumbers(hunk, currentFile.action)),
    ...stats
  });
}

function parseStructuredPatch(patch) {
  const lines = String(patch ?? "").replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  const pushCurrentHunk = () => {
    if (!currentFile || !currentHunk) {
      return;
    }
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  for (const line of lines) {
    if (
      line === "*** Begin Patch" ||
      line === "*** End Patch" ||
      line === "*** End of File" ||
      line === "*** Begin Patch ***" ||
      line === "*** End Patch ***"
    ) {
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      pushCurrentHunk();
      finalizePatchFile(files, currentFile);
      currentFile = {
        id: `edit:update:${files.length + 1}`,
        path: line.slice("*** Update File: ".length).trim(),
        action: "update",
        actionLabel: "修改文件",
        moveTo: "",
        hunks: []
      };
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      pushCurrentHunk();
      finalizePatchFile(files, currentFile);
      currentFile = {
        id: `edit:add:${files.length + 1}`,
        path: line.slice("*** Add File: ".length).trim(),
        action: "add",
        actionLabel: "新增文件",
        moveTo: "",
        hunks: []
      };
      currentHunk = createHunk("新增文件", []);
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      pushCurrentHunk();
      finalizePatchFile(files, currentFile);
      currentFile = {
        id: `edit:delete:${files.length + 1}`,
        path: line.slice("*** Delete File: ".length).trim(),
        action: "delete",
        actionLabel: "删除文件",
        moveTo: "",
        hunks: []
      };
      continue;
    }

    if (line.startsWith("*** Move to: ")) {
      if (currentFile) {
        currentFile.moveTo = line.slice("*** Move to: ".length).trim();
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("@@")) {
      pushCurrentHunk();
      currentHunk = createHunk(line, []);
      continue;
    }

    if (currentFile.action === "add") {
      if (line.startsWith("+")) {
        currentHunk.lines.push(createLine("add", line.slice(1)));
      }
      continue;
    }

    if (!currentHunk) {
      currentHunk = createHunk("", []);
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push(createLine("add", line.slice(1)));
    } else if (line.startsWith("-")) {
      currentHunk.lines.push(createLine("remove", line.slice(1)));
    } else {
      currentHunk.lines.push(createLine("context", line.startsWith(" ") ? line.slice(1) : line));
    }
  }

  pushCurrentHunk();
  finalizePatchFile(files, currentFile);
  return files;
}

function parseUnifiedDiff(patch) {
  const lines = String(patch ?? "").replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  const pushCurrentHunk = () => {
    if (!currentFile || !currentHunk) {
      return;
    }
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const startFile = (oldPath, newPath) => {
    pushCurrentHunk();
    finalizePatchFile(files, currentFile);
    const normalizedOld = normalizeText(oldPath).replace(/^a\//, "");
    const normalizedNew = normalizeText(newPath).replace(/^b\//, "");
    const isAdd = normalizedOld === "/dev/null";
    const isDelete = normalizedNew === "/dev/null";
    const path = isAdd ? normalizedNew : normalizedOld;
    currentFile = {
      id: `edit:unified:${files.length + 1}`,
      path,
      action: isAdd ? "add" : isDelete ? "delete" : "update",
      actionLabel: isAdd ? "新增文件" : isDelete ? "删除文件" : "修改文件",
      moveTo:
        !isAdd && !isDelete && normalizedOld && normalizedNew && normalizedOld !== normalizedNew
          ? normalizedNew
          : "",
      hunks: []
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim();
      const nextLine = lines[index + 1] ?? "";
      if (nextLine.startsWith("+++ ")) {
        const newPath = nextLine.slice(4).trim();
        startFile(oldPath, newPath);
        index += 1;
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("@@")) {
      pushCurrentHunk();
      currentHunk = createHunk(line, []);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push(createLine("add", line.slice(1)));
    } else if (line.startsWith("-")) {
      currentHunk.lines.push(createLine("remove", line.slice(1)));
    } else if (!line.startsWith("\\")) {
      currentHunk.lines.push(createLine("context", line.startsWith(" ") ? line.slice(1) : line));
    }
  }

  pushCurrentHunk();
  finalizePatchFile(files, currentFile);
  return files;
}

function buildEditToolPreview(argumentsObject) {
  const args =
    argumentsObject && typeof argumentsObject === "object" && !Array.isArray(argumentsObject)
      ? argumentsObject
      : {};
  const patch = typeof args.patch === "string" ? args.patch : "";
  if (!patch.trim()) {
    return null;
  }

  const files = isStructuredPatch(patch) ? parseStructuredPatch(patch) : parseUnifiedDiff(patch);
  if (files.length === 0) {
    return null;
  }

  return {
    kind: "edit",
    summaryText:
      files.length === 1
        ? files[0].path
        : `${files.length} 个文件补丁`,
    files
  };
}

export function buildToolDiffViewModel(toolPayload) {
  if (!toolPayload || typeof toolPayload !== "object") {
    return null;
  }

  const backendView = normalizeBackendView(toolPayload?.metadata?.view);
  const toolName = normalizeToolName(toolPayload.toolName);
  const argumentsObject =
    toolPayload.arguments && typeof toolPayload.arguments === "object" && !Array.isArray(toolPayload.arguments)
      ? toolPayload.arguments
      : {};

  if (toolName === "write") {
    return mergeViewMetadata(buildWriteToolPreview(argumentsObject), backendView);
  }

  if (toolName === "edit") {
    return mergeViewMetadata(buildEditToolPreview(argumentsObject), backendView);
  }

  return backendView;
}
