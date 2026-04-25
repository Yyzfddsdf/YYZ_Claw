import { useEffect, useMemo, useState } from "react";

import { parseChatFiles } from "../../api/chatApi";
import {
  createDebate,
  deleteDebate,
  fetchDebateById,
  fetchDebates
} from "../../api/debateApi";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { formatTimestamp } from "../../shared/formatTimestamp";
import "./debate.css";

function normalizeDebate(value) {
  return value && typeof value === "object" ? value : null;
}

function sideLabel(side) {
  return String(side ?? "").trim() === "A" ? "AI A" : "AI B";
}

function isDebateLive(debate) {
  const status = String(debate?.status ?? "").trim();
  return status === "running" || status === "finalizing";
}

function debateStatusLabel(debate) {
  if (debate?.status === "running") {
    return "互博中";
  }
  if (debate?.status === "finalizing") {
    return "总结中";
  }
  if (debate?.status === "completed") {
    return debate.acceptedSide ? `${debate.acceptedSide} 被同意` : "轮次耗尽";
  }
  return debate?.status || "unknown";
}

export function DebatePanel({ disabled = false, disabledReason = "" }) {
  const [debates, setDebates] = useState([]);
  const [activeDebateId, setActiveDebateId] = useState("");
  const [activeDebate, setActiveDebate] = useState(null);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("通过互相质疑、修正和收敛，形成一个可靠的最终方案或论点。");
  const [materialText, setMaterialText] = useState("");
  const [fileMaterials, setFileMaterials] = useState([]);
  const [parsingFiles, setParsingFiles] = useState(false);
  const [maxRounds, setMaxRounds] = useState(4);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const sortedTurns = useMemo(
    () => (Array.isArray(activeDebate?.turns) ? activeDebate.turns : []),
    [activeDebate]
  );
  const hasLiveDebate = useMemo(
    () => isDebateLive(activeDebate) || debates.some((debate) => isDebateLive(debate)),
    [activeDebate, debates]
  );

  async function reloadDebates(nextActiveId = activeDebateId) {
    const response = await fetchDebates();
    const nextDebates = Array.isArray(response?.debates) ? response.debates : [];
    setDebates(nextDebates);

    const normalizedActiveId = String(nextActiveId ?? "").trim();
    const resolvedActiveId =
      normalizedActiveId ||
      String(nextDebates[0]?.id ?? "").trim();

    if (resolvedActiveId) {
      const detail = await fetchDebateById(resolvedActiveId);
      setActiveDebate(normalizeDebate(detail?.debate));
      setActiveDebateId(resolvedActiveId);
    } else {
      setActiveDebate(null);
      setActiveDebateId("");
    }
  }

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetchDebates();
        if (!mounted) {
          return;
        }
        const nextDebates = Array.isArray(response?.debates) ? response.debates : [];
        setDebates(nextDebates);
        const firstId = String(nextDebates[0]?.id ?? "").trim();
        if (firstId) {
          const detail = await fetchDebateById(firstId);
          if (!mounted) {
            return;
          }
          setActiveDebate(normalizeDebate(detail?.debate));
          setActiveDebateId(firstId);
        }
      } catch (loadError) {
        if (mounted) {
          setError(loadError?.message || "加载互博记录失败");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hasLiveDebate) {
      return undefined;
    }

    let cancelled = false;
    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetchDebates();
        if (cancelled) {
          return;
        }
        const nextDebates = Array.isArray(response?.debates) ? response.debates : [];
        setDebates(nextDebates);

        const normalizedActiveId = String(activeDebateId ?? "").trim();
        if (normalizedActiveId) {
          const detail = await fetchDebateById(normalizedActiveId);
          if (!cancelled) {
            setActiveDebate(normalizeDebate(detail?.debate));
          }
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError?.message || "刷新互博状态失败");
        }
      }
    }, 1600);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeDebateId, hasLiveDebate]);

  async function selectDebate(debateId) {
    const normalizedId = String(debateId ?? "").trim();
    if (!normalizedId || running) {
      return;
    }

    setError("");
    setActiveDebateId(normalizedId);
    const response = await fetchDebateById(normalizedId);
    setActiveDebate(normalizeDebate(response?.debate));
  }

  async function handleFileChange(event) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      setFileMaterials([]);
      return;
    }

    setParsingFiles(true);
    setError("");
    try {
      const response = await parseChatFiles(files);
      const parsedFiles = Array.isArray(response?.files) ? response.files : [];
      const materials = parsedFiles
        .map((file, index) => ({
          name: String(file?.name ?? `文件 ${index + 1}`).trim() || `文件 ${index + 1}`,
          content: String(file?.extractedText ?? "").trim(),
          parseStatus: String(file?.parseStatus ?? "unsupported").trim(),
          note: String(file?.note ?? "").trim()
        }))
        .filter((file) => file.content);
      setFileMaterials(materials);
      if (parsedFiles.length > materials.length) {
        setError("部分文件没有解析出可用文本，已自动忽略。");
      }
    } catch (fileError) {
      setFileMaterials([]);
      setError(fileError?.message || "解析文件失败");
    } finally {
      setParsingFiles(false);
    }
  }

  async function submitDebate(event) {
    event.preventDefault();
    const normalizedTopic = String(topic ?? "").trim();
    if (!normalizedTopic || running || disabled) {
      return;
    }

    setRunning(true);
    setError("");
    try {
      const materials = [
        ...(String(materialText ?? "").trim()
          ? [{ name: "文本材料", content: String(materialText ?? "").trim() }]
          : []),
        ...fileMaterials
      ];
      const response = await createDebate({
        title,
        topic: normalizedTopic,
        description,
        materials,
        maxRounds: Number(maxRounds)
      });
      const debate = normalizeDebate(response?.debate);
      if (debate?.id) {
        setTopic("");
        setTitle("");
        setMaterialText("");
        setFileMaterials([]);
        setActiveDebate(debate);
        setActiveDebateId(debate.id);
        await reloadDebates(debate.id);
      }
    } catch (submitError) {
      setError(submitError?.message || "启动 AI 互博失败");
    } finally {
      setRunning(false);
    }
  }

  async function removeDebate(debateId) {
    const normalizedId = String(debateId ?? "").trim();
    if (!normalizedId || running) {
      return;
    }

    const currentTitle =
      debates.find((item) => String(item?.id ?? "").trim() === normalizedId)?.title || "该互博";
    if (!window.confirm(`确认删除“${currentTitle}”吗？`)) {
      return;
    }

    setError("");
    await deleteDebate(normalizedId);
    await reloadDebates(activeDebateId === normalizedId ? "" : activeDebateId);
  }

  return (
    <div className="debate-panel">
      <aside className="debate-history">
        <header>
          <h3>讨论记录</h3>
          <button
            type="button"
            className="debate-create-btn"
            onClick={() => {
              setActiveDebateId("");
              setActiveDebate(null);
            }}
            disabled={running}
          >
            新建
          </button>
        </header>
        <div className="debate-history-list">
          {debates.length === 0 && !loading ? (
            <p className="debate-empty">暂无互博记录。</p>
          ) : (
            debates.map((debate) => (
              <article
                key={debate.id}
                className={`debate-history-item ${
                  activeDebateId === debate.id ? "is-active" : ""
                }`}
              >
                <button type="button" onClick={() => selectDebate(debate.id)}>
                  <strong>{debate.title || "未命名互博"}</strong>
                  <span>
                    {debateStatusLabel(debate)}
                  </span>
                  <small>{formatTimestamp(debate.updatedAt)}</small>
                </button>
                <button
                  type="button"
                  className="debate-delete"
                  onClick={() => removeDebate(debate.id)}
                  disabled={running}
                >
                  删除
                </button>
              </article>
            ))
          )}
        </div>
      </aside>

      <section className="debate-detail">
        {!activeDebate && !activeDebateId ? (
          <div className="debate-create-view">
            <header className="debate-hero">
          <span>Debate Lab</span>
          <h2>AI 互辩实验室</h2>
          <p>两个独立 AI 会话围绕同一主题互相质疑和修正，目标是形成共识，而不是为了反驳而反驳。</p>
            </header>

            <form className="debate-form" onSubmit={submitDebate}>
              <label>
                <span>标题</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="可选，默认取论题前缀"
                  disabled={running}
                />
              </label>

              <label>
                <span>论题</span>
                <textarea
                  value={topic}
                  onChange={(event) => {
                    setTopic(event.target.value);
                    event.target.style.height = "auto";
                    event.target.style.height = `${event.target.scrollHeight}px`;
                  }}
              placeholder="例如：这套调度器应该如何支持运行态插入？"
                  rows={2}
                  disabled={running}
                  required
                />
              </label>

          <label>
            <span>描述/要求</span>
            <textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                event.target.style.height = "auto";
                event.target.style.height = `${event.target.scrollHeight}px`;
              }}
              rows={2}
              disabled={running}
            />
              </label>

              <label>
                <span>文本材料</span>
                <textarea
                  value={materialText}
                  onChange={(event) => {
                    setMaterialText(event.target.value);
                    event.target.style.height = "auto";
                    event.target.style.height = `${event.target.scrollHeight}px`;
                  }}
                  placeholder="可选，粘贴背景、方案、代码片段或文章摘要"
                  rows={3}
                  disabled={running}
                />
              </label>

              <div className="debate-form-row">
                <label>
                  <span>最大轮数</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={maxRounds}
                    onChange={(event) => setMaxRounds(event.target.value)}
                    disabled={running}
                  />
                </label>
                <div className="debate-form-file-wrap">
                  <span>文件材料</span>
                  <label className={`debate-file-btn ${running || parsingFiles ? "disabled" : ""}`}>
                    <input
                      type="file"
                      multiple
                      onChange={handleFileChange}
                      disabled={running || parsingFiles}
                    />
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    选择附件文件...
                  </label>
                </div>
          </div>

          {fileMaterials.length > 0 && (
            <div className="debate-file-pills">
              {fileMaterials.map((file) => (
                <span key={file.name}>{file.name}</span>
              ))}
            </div>
          )}

          <button type="submit" disabled={disabled || running || parsingFiles || !topic.trim()}>
            {parsingFiles ? "解析文件中..." : running ? "创建中..." : "开始互博"}
          </button>

              {disabled && <p className="debate-warning">{disabledReason}</p>}
              {error && <p className="debate-warning">{error}</p>}
            </form>
          </div>
        ) : !activeDebate ? (
          <div className="debate-empty-state">
            <h3>加载中...</h3>
          </div>
        ) : (
            <>
              <header className="debate-detail-head">
                <div>
                  <span>{debateStatusLabel(activeDebate)}</span>
                  <h2>{activeDebate.title || "未命名互博"}</h2>
                  <p>{activeDebate.description || "两个独立 AI 会话围绕同一主题互相审视。"}</p>
                </div>
                <div className="debate-verdict">
                  <strong>{activeDebate.acceptedSide || activeDebate.finalSide || "未定"}</strong>
                  <span>{activeDebate.agreedBy ? `${activeDebate.agreedBy} 同意` : "未正式同意"}</span>
                </div>
              </header>

              <section className="debate-topic-card">
                <span>Topic</span>
                <h3>{activeDebate.topic}</h3>
              </section>

              {activeDebate.finalSummary && (
                <section className="debate-final">
                  <span>Final</span>
                  <h3>{sideLabel(activeDebate.finalSide)} 最终总结</h3>
                  <MarkdownMessage
                    content={activeDebate.finalSummary}
                    className="debate-markdown"
                  />
                </section>
              )}

              {isDebateLive(activeDebate) && (
                <div className="debate-live-banner">
                  <span className="debate-live-dot" />
                  后台互博中，已生成 {sortedTurns.length} 条记录
                </div>
              )}

              <div className="debate-turns">
                {sortedTurns.map((turn) => (
                  <article
                    key={turn.id}
                    className={`debate-turn debate-turn-${String(turn.side ?? "").toLowerCase()} debate-turn-${turn.type}`}
                  >
                    <header>
                      <strong>
                        {turn.type === "final" ? "最终总结" : sideLabel(turn.side)}
                      </strong>
                      <span>
                        {turn.type === "agreement"
                          ? `同意 ${turn.acceptedSide}`
                          : turn.type === "final"
                            ? "final"
                            : `Round ${turn.round}`}
                      </span>
                    </header>
                    <MarkdownMessage
                      content={turn.content}
                      className="debate-markdown"
                    />
                    {turn.agreementReason && (
                      <em>agree: {turn.agreementReason}</em>
                    )}
                  </article>
                ))}
              </div>

              {activeDebate.error && (
                <div className="debate-warning">错误：{activeDebate.error}</div>
              )}
            </>
          )}
      </section>
    </div>
  );
}
