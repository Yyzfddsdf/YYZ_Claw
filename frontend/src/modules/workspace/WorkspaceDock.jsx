import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import {
  fetchWorkspaceInfo,
  fetchWorkspaceTree,
  getWorkspaceAssetUrl,
  readWorkspaceFile,
  writeWorkspaceFile
} from "../../api/workspaceApi";
import { notify } from "../../shared/feedback";
import "./workspace-dock.css";

const EDITOR_THEME = "yyz-claw-workbench";

const LANGUAGE_BY_EXT = new Map([
  ["css", "css"],
  ["go", "go"],
  ["htm", "html"],
  ["html", "html"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["json", "json"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["ps1", "powershell"],
  ["py", "python"],
  ["sh", "shell"],
  ["sql", "sql"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"]
]);

const IMAGE_EXTENSIONS = new Set(["apng", "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav", "webm"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

function getExtension(filePath) {
  return String(filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
}

function getPreviewKind(filePath) {
  const extension = getExtension(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "text";
}

function getLanguageForPath(filePath) {
  const extension = getExtension(filePath);
  return LANGUAGE_BY_EXT.get(extension) ?? "plaintext";
}

function getFileIcon(entry) {
  if (entry.type === "directory") {
    return "▸";
  }
  const extension = String(entry.name ?? "").split(".").pop()?.toLowerCase();
  if (extension === "md") return "M";
  if (["js", "jsx", "mjs"].includes(extension)) return "JS";
  if (extension === "css") return "#";
  if (extension === "json") return "{}";
  if (AUDIO_EXTENSIONS.has(extension)) return "♪";
  if (VIDEO_EXTENSIONS.has(extension)) return "▶";
  return "•";
}

function getFileIconTone(entry) {
  if (entry.type === "directory") {
    return "folder";
  }
  const extension = String(entry.name ?? "").split(".").pop()?.toLowerCase();
  if (["js", "jsx", "mjs"].includes(extension)) return "js";
  if (["ts", "tsx"].includes(extension)) return "ts";
  if (extension === "json") return "json";
  if (extension === "css") return "css";
  if (["html", "htm", "xml"].includes(extension)) return "markup";
  if (extension === "md") return "md";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (["ps1", "sh", "bat", "cmd"].includes(extension)) return "shell";
  if (["go", "py", "sql", "yaml", "yml"].includes(extension)) return extension;
  return "plain";
}

function WorkspaceFileTreeNode({
  entry,
  depth,
  activePath,
  expandedPaths,
  childrenByPath,
  loadingPath,
  onToggleDirectory,
  onOpenFile
}) {
  const isDirectory = entry.type === "directory";
  const isExpanded = expandedPaths.has(entry.path);
  const children = childrenByPath.get(entry.path) ?? [];

  return (
    <div className="workspace-tree-node">
      <button
        type="button"
        className={`workspace-tree-row ${activePath === entry.path ? "is-active" : ""}`}
        style={{ "--tree-depth": depth }}
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(entry.path);
            return;
          }
          onOpenFile(entry.path);
        }}
      >
        <span
          className={`workspace-tree-icon tone-${getFileIconTone(entry)} ${
            isDirectory && isExpanded ? "is-open" : ""
          }`}
        >
          {isDirectory ? "▸" : getFileIcon(entry)}
        </span>
        <span className="workspace-tree-name" title={entry.path}>
          {entry.name}
        </span>
        {loadingPath === entry.path && <span className="workspace-tree-loading">...</span>}
      </button>

      {isDirectory && isExpanded && (
        <div className="workspace-tree-children">
          {children.map((child) => (
            <WorkspaceFileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activePath={activePath}
              expandedPaths={expandedPaths}
              childrenByPath={childrenByPath}
              loadingPath={loadingPath}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceTerminal({ enabled, active, workspaceRoot = "", onTitleChange }) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);

  function sendTerminalSize() {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (!terminal || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows
      })
    );
  }

  useEffect(() => {
    if (!enabled || !hostRef.current || terminalRef.current) {
      return undefined;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#0d1117",
        foreground: "#d6deeb",
        cursor: "#f8fafc",
        selectionBackground: "#334155"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    fitAddon.fit();
    terminal.writeln("YYZ_CLAW workspace terminal");
    terminal.writeln("Starting in project root...");

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const rootQuery = String(workspaceRoot ?? "").trim()
      ? `?root=${encodeURIComponent(String(workspaceRoot).trim())}`
      : "";
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/workspace/terminal${rootQuery}`);
    socketRef.current = socket;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "meta" && message.cwd) {
          terminal.writeln(`cwd: ${message.cwd}`);
          if (message.title) {
            onTitleChange?.(message.title);
          }
          return;
        }
        if (message.type === "title" && message.title) {
          onTitleChange?.(message.title);
          return;
        }
        if (message.type === "output") {
          terminal.write(message.data ?? "");
          return;
        }
        if (message.type === "exit") {
          terminal.writeln(`\r\n[terminal exited: ${message.code ?? ""}]`);
        }
      } catch {
        terminal.write(String(event.data ?? ""));
      }
    });

    socket.addEventListener("close", () => {
      terminal.writeln("\r\n[terminal disconnected]");
    });

    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "input",
            data
          })
        );
      }
    });
    const resizeDisposable = terminal.onResize((size) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: size.cols,
            rows: size.rows
          })
        );
      }
    });

    socket.addEventListener("open", () => {
      sendTerminalSize();
    });

    const handleResize = () => {
      window.requestAnimationFrame(() => {
        fitAddon.fit();
        sendTerminalSize();
      });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      socketRef.current = null;
    };
  }, [enabled, workspaceRoot]);

  useEffect(() => {
    if (enabled && active && fitAddonRef.current) {
      window.requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        sendTerminalSize();
      });
    }
  }, [active, enabled]);

  return <div ref={hostRef} className="workspace-terminal-host" />;
}

function openWorkspaceWindow(workspaceRoot = "") {
  const normalizedRoot = String(workspaceRoot ?? "").trim();
  const query = normalizedRoot ? `?root=${encodeURIComponent(normalizedRoot)}` : "";
  if (window.yyzClaw?.openWorkspaceWindow) {
    window.yyzClaw.openWorkspaceWindow(normalizedRoot);
    return;
  }

  const features = [
    "popup=yes",
    "width=1280",
    "height=840",
    "left=120",
    "top=80",
    "resizable=yes",
    "scrollbars=no",
    "noopener=no"
  ].join(",");
  const openedWindow = window.open(`/workspace-window${query}`, "yyz-claw-workspace", features);
  openedWindow?.focus();
}

export function WorkspaceDock({
  standalone = false,
  embedded = false,
  modeSwitch = null,
  rightPane = null,
  workspaceRoot: requestedWorkspaceRoot = ""
} = {}) {
  const editorHostRef = useRef(null);
  const editorRef = useRef(null);
  const shellRef = useRef(null);
  const activeFilePathRef = useRef("");
  const fileStatesRef = useRef(new Map());
  const saveActiveFileRef = useRef(null);
  const terminalIdSeedRef = useRef(0);
  const [isOpen, setIsOpen] = useState(Boolean(standalone || embedded));
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [rootEntries, setRootEntries] = useState([]);
  const [childrenByPath, setChildrenByPath] = useState(() => new Map());
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [loadingPath, setLoadingPath] = useState("");
  const [treeWidth, setTreeWidth] = useState(270);
  const [rightPaneWidth, setRightPaneWidth] = useState(420);
  const [openTabs, setOpenTabs] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState("");
  const [, setEditorRevision] = useState(0);
  const [activeTab, setActiveTab] = useState("editor");
  const [terminalTabs, setTerminalTabs] = useState([]);
  const [activeTerminalId, setActiveTerminalId] = useState("");
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const terminalResizeRef = useRef({ resizing: false, startY: 0, startHeight: 260 });
  const [error, setError] = useState("");
  const activeFileState = activeFilePath ? fileStatesRef.current.get(activeFilePath) : null;
  const activeFile = activeFileState?.file ?? null;

  const drawerTitle = useMemo(() => {
    if (activeFilePath) {
      return activeFilePath;
    }
    return workspaceRoot || "工作区";
  }, [activeFilePath, workspaceRoot]);

  useEffect(() => {
    if (standalone || embedded) {
      setIsOpen(true);
    }
  }, [embedded, standalone]);

  useEffect(() => {
    setWorkspaceRoot("");
    setRootEntries([]);
    setChildrenByPath(new Map());
    setExpandedPaths(new Set());
  }, [requestedWorkspaceRoot]);

  useEffect(() => {
    monaco.editor.defineTheme(EDITOR_THEME, {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#00000000",
        "editor.foreground": "#0f172a",
        "editorLineNumber.foreground": "#64748b",
        "editorCursor.foreground": "#1d4ed8",
        "editor.selectionBackground": "#93c5fd66",
        "editor.lineHighlightBackground": "#ffffff28",
        "minimap.background": "#00000000",
        "minimap.selectionHighlight": "#93c5fd55",
        "minimap.findMatchHighlight": "#60a5fa66",
        "minimap.errorHighlight": "#f8717166",
        "minimap.warningHighlight": "#fbbf2466",
        "editorOverviewRuler.background": "#00000000",
        "editorOverviewRuler.border": "#00000000",
        "scrollbarSlider.background": "#cbd5e166",
        "scrollbarSlider.hoverBackground": "#94a3b899",
        "scrollbarSlider.activeBackground": "#64748bcc"
      }
    });
  }, []);

  useEffect(() => {
    if (!isOpen || rootEntries.length > 0) {
      return undefined;
    }

    let mounted = true;

    async function loadInitialTree() {
      setError("");
      setLoadingPath("__root__");
      try {
        const [info, tree] = await Promise.all([
          fetchWorkspaceInfo(requestedWorkspaceRoot),
          fetchWorkspaceTree("", requestedWorkspaceRoot)
        ]);
        if (!mounted) return;
        setWorkspaceRoot(info.root ?? "");
        setRootEntries(tree.entries ?? []);
      } catch (loadError) {
        if (!mounted) return;
        setError(loadError.message || "加载工作区失败");
      } finally {
        if (mounted) setLoadingPath("");
      }
    }

    loadInitialTree();

    return () => {
      mounted = false;
    };
  }, [isOpen, rootEntries.length, requestedWorkspaceRoot]);

  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) {
      return undefined;
    }

    const editor = monaco.editor.create(editorHostRef.current, {
      value: "",
      language: "plaintext",
      theme: EDITOR_THEME,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      minimap: { enabled: true },
      wordWrap: "on",
      wrappingStrategy: "advanced",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2
    });
    const contentDisposable = editor.onDidChangeModelContent(() => {
      const filePath = activeFilePathRef.current;
      const state = filePath ? fileStatesRef.current.get(filePath) : null;
      if (!state) {
        return;
      }
      state.currentContent = editor.getValue();
      setEditorRevision((revision) => revision + 1);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveActiveFileRef.current?.();
    });
    editorRef.current = editor;
    const activeState = activeFilePathRef.current
      ? fileStatesRef.current.get(activeFilePathRef.current)
      : null;
    if (activeState?.model) {
      editor.setModel(activeState.model);
    }

    return () => {
      contentDisposable.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      editorRef.current?.layout();
    });
  }, [activeFilePath, treeWidth, rightPaneWidth, terminalVisible, terminalHeight, embedded]);

  async function handleToggleDirectory(path) {
    const nextExpanded = new Set(expandedPaths);
    if (nextExpanded.has(path)) {
      nextExpanded.delete(path);
      setExpandedPaths(nextExpanded);
      return;
    }

    nextExpanded.add(path);
    setExpandedPaths(nextExpanded);

    if (childrenByPath.has(path)) {
      return;
    }

    setLoadingPath(path);
    setError("");
    try {
      const response = await fetchWorkspaceTree(path, requestedWorkspaceRoot);
      setChildrenByPath((current) => {
        const next = new Map(current);
        next.set(path, response.entries ?? []);
        return next;
      });
    } catch (loadError) {
      setError(loadError.message || "加载目录失败");
    } finally {
      setLoadingPath("");
    }
  }

  function activateOpenFile(path) {
    const state = fileStatesRef.current.get(path);
    if (!state) {
      return;
    }
    activeFilePathRef.current = path;
    setActiveFilePath(path);
    if (editorRef.current) {
      editorRef.current.setModel(state.kind === "text" ? state.model : null);
      if (state.kind === "text") {
        editorRef.current.focus();
      }
    }
  }

  async function handleOpenFile(path) {
    if (fileStatesRef.current.has(path)) {
      activateOpenFile(path);
      return;
    }

    setError("");
    try {
      const previewKind = getPreviewKind(path);
      if (previewKind !== "text") {
        const name = path.split("/").pop() ?? path;
        fileStatesRef.current.set(path, {
          kind: previewKind,
          file: {
            path,
            name,
            assetUrl: getWorkspaceAssetUrl(path, requestedWorkspaceRoot)
          },
          model: null,
          savedContent: "",
          currentContent: ""
        });
        setOpenTabs((tabs) => {
          if (tabs.some((tab) => tab.path === path)) {
            return tabs;
          }
          return [...tabs, { path, name }];
        });
        activateOpenFile(path);
        return;
      }

      const file = await readWorkspaceFile(path, requestedWorkspaceRoot);
      const content = file.content ?? "";
      const model = monaco.editor.createModel(content, getLanguageForPath(path));
      fileStatesRef.current.set(path, {
        kind: "text",
        file,
        model,
        savedContent: content,
        currentContent: content
      });
      setOpenTabs((tabs) => {
        if (tabs.some((tab) => tab.path === path)) {
          return tabs;
        }
        return [...tabs, { path, name: file.name ?? path.split("/").pop() ?? path }];
      });
      activateOpenFile(path);
    } catch (openError) {
      setError(openError.message || "打开文件失败");
    }
  }

  async function handleSave() {
    const filePath = activeFilePathRef.current;
    const state = filePath ? fileStatesRef.current.get(filePath) : null;
    if (!filePath || !state) {
      return;
    }
    if (state.kind !== "text" || !state.model) {
      return;
    }

    setError("");
    const content = state.model.getValue();
    try {
      const response = await writeWorkspaceFile(filePath, content, requestedWorkspaceRoot);
      state.savedContent = content;
      state.currentContent = content;
      state.file = {
        ...state.file,
        modifiedAt: response.modifiedAt,
        size: response.size
      };
      setEditorRevision((revision) => revision + 1);
    } catch (saveError) {
      setError(saveError.message || "保存失败");
    }
  }

  function createTerminalTab() {
    const nextIndex = terminalIdSeedRef.current + 1;
    terminalIdSeedRef.current = nextIndex;
    const nextTerminal = {
      id: `terminal_${Date.now()}_${nextIndex}`,
      name: "PowerShell"
    };
    setTerminalTabs((tabs) => [...tabs, nextTerminal]);
    setActiveTerminalId(nextTerminal.id);
    setTerminalVisible(true);
    return nextTerminal.id;
  }

  function openTerminalPanel() {
    setTerminalVisible(true);
    if (terminalTabs.length === 0) {
      createTerminalTab();
    }
  }

  function closeTerminalTab(terminalId) {
    setTerminalTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== terminalId);
      if (activeTerminalId === terminalId) {
        const closedIndex = tabs.findIndex((tab) => tab.id === terminalId);
        const nextActive =
          nextTabs[Math.min(Math.max(closedIndex, 0), nextTabs.length - 1)]?.id ?? "";
        setActiveTerminalId(nextActive);
      }
      return nextTabs;
    });
  }

  function updateTerminalTitle(terminalId, title) {
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) {
      return;
    }
    setTerminalTabs((tabs) =>
      tabs.map((tab) => (tab.id === terminalId ? { ...tab, name: cleanTitle } : tab))
    );
  }

  useEffect(() => {
    const handleMouseMove = (event) => {
      const state = terminalResizeRef.current;
      if (!state.resizing) {
        return;
      }
      const nextHeight = Math.max(140, Math.min(560, state.startHeight - (event.clientY - state.startY)));
      setTerminalHeight(nextHeight);
    };
    const handleMouseUp = () => {
      terminalResizeRef.current.resizing = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  function handleCloseTab(path) {
    const state = fileStatesRef.current.get(path);
    if (state && state.currentContent !== state.savedContent) {
      notify({
        tone: "warning",
        message: "这个文件还没保存，先按 Ctrl+S 再关闭。"
      });
      return;
    }

    setOpenTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.path !== path);
      const closingActiveTab = activeFilePathRef.current === path;
      fileStatesRef.current.get(path)?.model?.dispose?.();
      fileStatesRef.current.delete(path);

      if (closingActiveTab) {
        const nextActive = nextTabs[nextTabs.length - 1]?.path ?? "";
        activeFilePathRef.current = nextActive;
        setActiveFilePath(nextActive);
        if (nextActive) {
          const nextState = fileStatesRef.current.get(nextActive);
          editorRef.current?.setModel(nextState?.kind === "text" ? nextState.model : null);
        } else {
          editorRef.current?.setModel(null);
        }
      }

      return nextTabs;
    });
  }

  useEffect(() => {
    saveActiveFileRef.current = handleSave;
  });

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActiveFileRef.current?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function startTreeResize() {
    const shellRect = shellRef.current?.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    const minTreeWidth = 180;
    const reservedRightPaneWidth = rightPane ? rightPaneWidth + 10 : 0;
    const maxTreeWidth = Math.max(
      minTreeWidth,
      Math.min(420, shellRect.width - reservedRightPaneWidth - 420 - 10)
    );

    function handlePointerMove(event) {
      const nextWidth = Math.min(
        maxTreeWidth,
        Math.max(minTreeWidth, event.clientX - shellRect.left)
      );
      setTreeWidth(nextWidth);
    }

    function handlePointerUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function startRightPaneResize() {
    const shellRect = shellRef.current?.getBoundingClientRect();
    if (!shellRect || !rightPane) {
      return;
    }

    const minRightPaneWidth = 320;
    const minEditorWidth = 420;
    const maxRightPaneWidth = Math.max(minRightPaneWidth, shellRect.width - treeWidth - minEditorWidth - 20);

    function handlePointerMove(event) {
      const nextWidth = Math.min(
        maxRightPaneWidth,
        Math.max(minRightPaneWidth, shellRect.right - event.clientX)
      );
      setRightPaneWidth(nextWidth);
    }

    function handlePointerUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const minTreeWidth = 180;

    function clampWorkspaceWidths() {
      const shellRect = shellRef.current?.getBoundingClientRect();
      if (!shellRect) {
        return;
      }

      const minEditorWidth = 420;
      const minRightPaneWidth = rightPane ? 320 : 0;
      const maxTreeWidth = Math.max(
        minTreeWidth,
        Math.min(420, shellRect.width - minEditorWidth - minRightPaneWidth - (rightPane ? 20 : 10))
      );
      setTreeWidth((current) => Math.min(maxTreeWidth, Math.max(minTreeWidth, current)));
      setRightPaneWidth((current) => {
        if (!rightPane) {
          return current;
        }
        return Math.min(
          Math.max(minRightPaneWidth, shellRect.width - minTreeWidth - minEditorWidth - 20),
          Math.max(minRightPaneWidth, current)
        );
      });
    }

    clampWorkspaceWidths();
    window.addEventListener("resize", clampWorkspaceWidths);
    return () => {
      window.removeEventListener("resize", clampWorkspaceWidths);
    };
  }, [isOpen, rightPane, rightPaneWidth, treeWidth]);

  useEffect(() => {
    if (!isOpen || !rightPane) {
      return undefined;
    }

    const minRightPaneWidth = 320;

    function clampRightPaneWidth() {
      const shellRect = shellRef.current?.getBoundingClientRect();
      if (!shellRect) {
        return;
      }

      const maxRightPaneWidth = Math.max(
        minRightPaneWidth,
        shellRect.width - treeWidth - 420 - 20
      );
      setRightPaneWidth((current) =>
        Math.min(maxRightPaneWidth, Math.max(minRightPaneWidth, current))
      );
    }

    clampRightPaneWidth();
    window.addEventListener("resize", clampRightPaneWidth);
    return () => {
      window.removeEventListener("resize", clampRightPaneWidth);
    };
  }, [isOpen, rightPane, rightPaneWidth, treeWidth]);

  return (
    <>
      {!standalone && !embedded && (
        <button
          type="button"
          className="workspace-dock-launcher"
          onClick={() => openWorkspaceWindow(requestedWorkspaceRoot)}
          title="打开独立工作区窗口"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16v14H4z" />
            <path d="M8 9l-3 3l3 3" />
            <path d="M16 9l3 3l-3 3" />
            <path d="M13 8l-2 8" />
          </svg>
          工作区
        </button>
      )}

      {(standalone || embedded) && (
        <div
          ref={shellRef}
          className={`workspace-dock-shell ${standalone ? "is-standalone" : ""} ${
            embedded ? "is-embedded" : ""
          } ${isOpen ? "is-open" : ""}`}
          role="dialog"
          aria-label="workspace editor"
          aria-hidden={!isOpen}
        >
          <header className={`workspace-dock-head ${embedded ? "is-embedded" : ""}`}>
            <div className="workspace-dock-title-block">
              <p>{embedded ? "CODE MODE" : "WORKBENCH"}</p>
              <div className="workspace-dock-title-row">
                <h2>{drawerTitle}</h2>
                {embedded && (
                  <div className="workspace-dock-inline-actions">
                    {modeSwitch}
                    <button
                      type="button"
                      onClick={() => openWorkspaceWindow(requestedWorkspaceRoot)}
                    >
                      独立窗口
                    </button>
                    <button
                      type="button"
                      onClick={openTerminalPanel}
                    >
                      终端
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="workspace-dock-head-actions">
              {!embedded && (
                <button
                  type="button"
                  className="workspace-dock-close"
                  onClick={() => {
                    if (standalone) {
                      window.close();
                      return;
                    }
                    setIsOpen(false);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </header>

          {error && <div className="workspace-dock-error">{error}</div>}

          <div
            className={`workspace-dock-body ${terminalVisible ? "has-terminal" : ""}`}
            style={{
              "--workspace-terminal-height": `${terminalHeight}px`,
              "--workspace-tree-width": `${treeWidth}px`,
              "--workspace-right-pane-width": `${rightPaneWidth}px`
            }}
          >
            <aside className="workspace-tree">
              <div className="workspace-tree-head">
                <span>Explorer</span>
                {loadingPath === "__root__" && <small>加载中...</small>}
              </div>
              <div className="workspace-tree-scroll">
                {rootEntries.map((entry) => (
                  <WorkspaceFileTreeNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    activePath={activeFile?.path ?? ""}
                    expandedPaths={expandedPaths}
                    childrenByPath={childrenByPath}
                    loadingPath={loadingPath}
                    onToggleDirectory={handleToggleDirectory}
                    onOpenFile={handleOpenFile}
                  />
                ))}
              </div>
            </aside>
            <div
              className="workspace-tree-resizer"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startTreeResize}
            />

            <section className="workspace-main-surface">
              <div className="workspace-editor-tabs" role="tablist" aria-label="打开的文件">
                {openTabs.length === 0 ? (
                  <div className="workspace-editor-tab-empty">没有打开的文件</div>
                ) : (
                  openTabs.map((tab) => {
                    const state = fileStatesRef.current.get(tab.path);
                    const tabDirty =
                      Boolean(state) && state.kind === "text" && state.currentContent !== state.savedContent;
                    const active = activeFilePath === tab.path;

                    return (
                      <div
                        key={tab.path}
                        role="tab"
                        tabIndex={0}
                        aria-selected={active}
                        className={`workspace-editor-tab ${active ? "is-active" : ""}`}
                        title={tab.path}
                        onClick={() => activateOpenFile(tab.path)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            activateOpenFile(tab.path);
                          }
                        }}
                      >
                        <span className={`workspace-tab-icon tone-${getFileIconTone({ name: tab.name })}`}>
                          {getFileIcon({ name: tab.name })}
                        </span>
                        <span className="workspace-tab-name">{tab.name}</span>
                        {tabDirty ? (
                          <span className="workspace-tab-dirty" aria-label="未保存" />
                        ) : (
                          <button
                            type="button"
                            className="workspace-tab-close"
                            aria-label={`关闭 ${tab.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCloseTab(tab.path);
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
                <div className="workspace-editor-shortcut">
                  <span>Ctrl+S 保存</span>
                </div>
              </div>

              <div className="workspace-editor-panel is-active">
                {!activeFile && (
                  <div className="workspace-empty-editor">从左侧文件树选择一个文件开始编辑。</div>
                )}
                {activeFileState?.kind === "image" && (
                  <div className="workspace-media-preview workspace-media-preview-image">
                    <img src={activeFile.assetUrl} alt={activeFile.name ?? activeFilePath} />
                  </div>
                )}
                {activeFileState?.kind === "audio" && (
                  <div className="workspace-media-preview workspace-media-preview-audio">
                    <div className="workspace-media-card">
                      <span className="workspace-media-icon">♪</span>
                      <strong>{activeFile.name ?? activeFilePath}</strong>
                      <audio controls src={activeFile.assetUrl}>
                        当前浏览器不支持音频播放。
                      </audio>
                    </div>
                  </div>
                )}
                {activeFileState?.kind === "video" && (
                  <div className="workspace-media-preview workspace-media-preview-video">
                    <video controls src={activeFile.assetUrl}>
                      当前浏览器不支持视频播放。
                    </video>
                  </div>
                )}
                <div
                  ref={editorHostRef}
                  className={`workspace-editor-host ${
                    activeFileState && activeFileState.kind !== "text" ? "is-hidden" : ""
                  }`}
                />
              </div>

              <section
                className={`workspace-bottom-panel ${terminalVisible ? "" : "is-hidden"}`}
                aria-label="terminal panel"
                aria-hidden={!terminalVisible}
              >
                <div
                  className="workspace-terminal-resizer"
                  role="separator"
                  aria-orientation="horizontal"
                  onMouseDown={(event) => {
                    terminalResizeRef.current = {
                      resizing: true,
                      startY: event.clientY,
                      startHeight: terminalHeight
                    };
                    document.body.style.cursor = "ns-resize";
                    document.body.style.userSelect = "none";
                  }}
                />
                <div className="workspace-bottom-tabs" role="tablist" aria-label="终端">
                  <div className="workspace-bottom-title">
                    <span>TERMINAL</span>
                  </div>
                  {terminalTabs.map((tab) => {
                    const active = activeTerminalId === tab.id;
                    return (
                      <div
                        key={tab.id}
                        role="tab"
                        tabIndex={0}
                        aria-selected={active}
                        className={`workspace-editor-tab workspace-terminal-tab ${
                          active ? "is-active" : ""
                        }`}
                        title={tab.name}
                        onClick={() => setActiveTerminalId(tab.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setActiveTerminalId(tab.id);
                          }
                        }}
                      >
                        <span className="workspace-tab-icon tone-shell">PS</span>
                        <span className="workspace-tab-name">{tab.name}</span>
                        <button
                          type="button"
                          className="workspace-tab-close"
                          aria-label={`关闭 ${tab.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeTerminalTab(tab.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="workspace-terminal-new"
                    onClick={createTerminalTab}
                    title="新建终端"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="workspace-terminal-hide"
                    onClick={() => setTerminalVisible(false)}
                    title="隐藏终端"
                  >
                    ×
                  </button>
                </div>
                <div className="workspace-terminal-panel is-active">
                {terminalTabs.length === 0 ? (
                  <div className="workspace-empty-editor">点击上方 + 新建终端。</div>
                ) : (
                  terminalTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`workspace-terminal-instance ${
                        activeTerminalId === tab.id ? "is-active" : ""
                      }`}
                    >
                      <WorkspaceTerminal
                        enabled={isOpen}
                        active={terminalVisible && activeTerminalId === tab.id}
                        workspaceRoot={requestedWorkspaceRoot}
                        onTitleChange={(title) => updateTerminalTitle(tab.id, title)}
                      />
                    </div>
                  ))
                )}
                </div>
              </section>
            </section>
            {rightPane && (
              <>
                <div
                  className="workspace-right-pane-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={startRightPaneResize}
                />
                <aside className="workspace-right-pane">
                  {rightPane}
                </aside>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
