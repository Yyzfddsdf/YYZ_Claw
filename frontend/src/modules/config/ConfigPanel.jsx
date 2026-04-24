import { useEffect, useMemo, useState } from "react";
import "./config.css";

function normalizeConfig(config) {
  return {
    model: config?.model ?? "",
    baseURL: config?.baseURL ?? "",
    apiKey: config?.apiKey ?? "",
    tavilyApiKey: config?.tavilyApiKey ?? "",
    subagentModel: config?.subagentModel ?? "",
    subagentBaseURL: config?.subagentBaseURL ?? "",
    subagentApiKey: config?.subagentApiKey ?? "",
    compressionModel: config?.compressionModel ?? "",
    compressionBaseURL: config?.compressionBaseURL ?? "",
    compressionApiKey: config?.compressionApiKey ?? "",
    sttProvider: config?.sttProvider ?? "local",
    sttCloudflareApiToken: config?.sttCloudflareApiToken ?? "",
    sttCloudflareAccountId: config?.sttCloudflareAccountId ?? "",
    sttCloudflareModel: config?.sttCloudflareModel ?? "@cf/openai/whisper-large-v3-turbo",
    maxContextWindow:
      config?.maxContextWindow === undefined || config?.maxContextWindow === null
        ? ""
        : String(config.maxContextWindow)
  };
}

function normalizeMcpConfig(config) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  return servers.map(s => ({
    name: s.name ?? "",
    transport: s.transport ?? "stdio",
    command: s.command ?? "",
    args: Array.isArray(s.args) ? s.args : [],
    url: s.url ?? "",
    env: s.env && typeof s.env === 'object' ? Object.entries(s.env).map(([k, v]) => ({ key: k, value: String(v) })) : [],
    headers: s.httpHeaders && typeof s.httpHeaders === 'object' ? Object.entries(s.httpHeaders).map(([k, v]) => ({ key: k, value: String(v) })) : [],
    enabled: s.enabled !== false,
    startupTimeoutMs: s.startupTimeoutMs ?? "",
    requestTimeoutMs: s.requestTimeoutMs ?? ""
  }));
}

function formatStatusText(status) {
  if (!status) return "尚未加载 MCP 配置";
  const toolCount = Number(status.toolCount ?? 0);
  const errorCount = Number(status.errorCount ?? 0);
  return `已加载 ${toolCount} 个工具${errorCount > 0 ? `，${errorCount} 个失败` : ""}`;
}

export function ConfigPanel({
  initialConfig,
  initialMcpConfig,
  mcpStatus,
  loading,
  saving,
  mcpLoading,
  mcpSaving,
  error,
  mcpError,
  onSave,
  onSaveMcpConfig
}) {
  const [form, setForm] = useState(() => normalizeConfig(initialConfig));
  const [localError, setLocalError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [mcpServers, setMcpServers] = useState(() => normalizeMcpConfig(initialMcpConfig));
  const [mcpLocalError, setMcpLocalError] = useState("");
  const [mcpSaveMessage, setMcpSaveMessage] = useState("");
  const [expandedServers, setExpandedServers] = useState({});
  const [openTransportMenuIndex, setOpenTransportMenuIndex] = useState(-1);
  const [sttProviderMenuOpen, setSttProviderMenuOpen] = useState(false);

  useEffect(() => {
    setForm(normalizeConfig(initialConfig));
  }, [initialConfig]);

  useEffect(() => {
    setMcpServers(normalizeMcpConfig(initialMcpConfig));
  }, [initialMcpConfig]);

  useEffect(() => {
    function handleDocumentPointerDown(event) {
      if (event?.target?.closest?.(".select-container")) {
        return;
      }
      setOpenTransportMenuIndex(-1);
      setSttProviderMenuOpen(false);
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
    };
  }, []);

  const mcpStatusText = useMemo(() => formatStatusText(mcpStatus), [mcpStatus]);
  const transportOptions = useMemo(
    () => [
      { value: "stdio", label: "Stdio (本地进程)" },
      { value: "http", label: "SSE (远程 HTTP)" }
    ],
    []
  );
  const sttProviderOptions = useMemo(
    () => [
      { value: "local", label: "local（本地 ONNX）" },
      { value: "cloudflare", label: "cloudflare（远端 API）" }
    ],
    []
  );

  async function handleConfigSubmit(event) {
    event.preventDefault();
    if (!form.model || !form.baseURL || !form.apiKey) {
      setLocalError("主模型的 Model / Base URL / API Key 均为必填项");
      return;
    }
    setLocalError("");
    setSaveMessage("");
    try {
      const payload = { ...form, maxContextWindow: form.maxContextWindow ? Number(form.maxContextWindow) : undefined };
      await onSave(payload);
      setSaveMessage("配置已成功保存");
    } catch { /* error handled by parent */ }
  }

  async function handleMcpSubmit(event) {
    event.preventDefault();
    const finalServers = mcpServers.map(s => {
      const server = {
        name: s.name.trim(),
        transport: s.transport,
        enabled: s.enabled,
        startupTimeoutMs: s.startupTimeoutMs ? Number(s.startupTimeoutMs) : undefined,
        requestTimeoutMs: s.requestTimeoutMs ? Number(s.requestTimeoutMs) : undefined
      };

      if (s.transport === 'stdio') {
        const envObj = {};
        s.env.forEach(item => { if (item.key.trim()) envObj[item.key.trim()] = item.value; });
        server.command = s.command.trim();
        server.args = Array.isArray(s.args) ? s.args : String(s.args || "").split(/\s+/).filter(Boolean);
        server.env = envObj;
      } else {
        const headerObj = {};
        s.headers.forEach(item => { if (item.key.trim()) headerObj[item.key.trim()] = item.value; });
        server.url = s.url.trim();
        server.httpHeaders = headerObj;
      }
      return server;
    });

    for (const s of finalServers) {
      if (!s.name) { setMcpLocalError("Server 名称不能为空"); return; }
      if (s.transport === 'stdio' && !s.command) { setMcpLocalError(`Server [${s.name}] 的命令不能为空`); return; }
      if (s.transport === 'http' && !s.url) { setMcpLocalError(`Server [${s.name}] 的 URL 不能为空`); return; }
    }

    setMcpLocalError("");
    setMcpSaveMessage("");
    try {
      await onSaveMcpConfig({ servers: finalServers });
      setMcpSaveMessage("MCP 配置已成功应用");
    } catch { /* error handled by parent */ }
  }

  function addMcpServer() {
    const newIndex = mcpServers.length;
    setMcpServers(prev => [...prev, { name: "", transport: "stdio", command: "", args: [], url: "", env: [], headers: [], enabled: true, startupTimeoutMs: "", requestTimeoutMs: "" }]);
    setExpandedServers(prev => ({ ...prev, [newIndex]: true }));
  }

  function updateMcpServer(index, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function toggleServerExpand(index) {
    setExpandedServers(prev => ({ ...prev, [index]: !prev[index] }));
  }

  function addMcpEnv(serverIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextEnv = [...next[serverIndex].env, { key: "", value: "" }];
      next[serverIndex] = { ...next[serverIndex], env: nextEnv };
      return next;
    });
  }

  function updateMcpEnv(serverIndex, envIndex, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextEnv = [...next[serverIndex].env];
      nextEnv[envIndex] = { ...nextEnv[envIndex], [field]: value };
      next[serverIndex] = { ...next[serverIndex], env: nextEnv };
      return next;
    });
  }

  function removeMcpEnv(serverIndex, envIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      next[serverIndex] = { ...next[serverIndex], env: next[serverIndex].env.filter((_, i) => i !== envIndex) };
      return next;
    });
  }

  function addMcpHeader(serverIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextHeaders = [...(next[serverIndex].headers || []), { key: "", value: "" }];
      next[serverIndex] = { ...next[serverIndex], headers: nextHeaders };
      return next;
    });
  }

  function updateMcpHeader(serverIndex, headerIndex, field, value) {
    setMcpServers(prev => {
      const next = [...prev];
      const nextHeaders = [...next[serverIndex].headers];
      nextHeaders[headerIndex] = { ...nextHeaders[headerIndex], [field]: value };
      next[serverIndex] = { ...next[serverIndex], headers: nextHeaders };
      return next;
    });
  }

  function removeMcpHeader(serverIndex, headerIndex) {
    setMcpServers(prev => {
      const next = [...prev];
      next[serverIndex] = { ...next[serverIndex], headers: next[serverIndex].headers.filter((_, i) => i !== headerIndex) };
      return next;
    });
  }

  return (
    <div className="config-module">
      <div className="module-title-wrap">
        <h2>智能体配置</h2>
        <p>管理全局运行参数与 MCP 扩展能力。</p>
      </div>

      <form onSubmit={handleConfigSubmit}>
        <div className="config-section">
          <div className="config-section-header"><h3>核心模型 (Core Model)</h3></div>
          <div className="config-section-body">
            <ConfigRow label="Model" desc="主语言模型标识" value={form.model} onChange={v => setForm({...form, model: v})} placeholder="gpt-4o" disabled={loading || saving} />
            <ConfigRow label="Base URL" desc="API 基础地址" value={form.baseURL} onChange={v => setForm({...form, baseURL: v})} placeholder="https://api.openai.com/v1" disabled={loading || saving} />
            <ConfigRow label="API Key" desc="鉴权密钥" value={form.apiKey} onChange={v => setForm({...form, apiKey: v})} isPassword disabled={loading || saving} />
            <ConfigRow label="Max Tokens" desc="最大上下文限制" value={form.maxContextWindow} onChange={v => setForm({...form, maxContextWindow: v})} type="number" disabled={loading || saving} />
          </div>
        </div>

        <div className="config-section">
          <div className="config-section-header"><h3>辅助功能 (Optional)</h3></div>
          <div className="config-section-body">
            <ConfigRow label="Search Key" desc="Tavily 搜索 API Key" value={form.tavilyApiKey} onChange={v => setForm({...form, tavilyApiKey: v})} isPassword disabled={loading || saving} />
            <ConfigRow label="Subagent" desc="子智能体独立配置 (Model, URL, Key)" isMulti 
              values={[form.subagentModel, form.subagentBaseURL, form.subagentApiKey]} 
              onChanges={[v => setForm({...form, subagentModel: v}), v => setForm({...form, subagentBaseURL: v}), v => setForm({...form, subagentApiKey: v})]} 
              disabled={loading || saving} 
            />
            <ConfigRow label="Compression" desc="上下文压缩独立配置 (Model, URL, Key)" isMulti 
              values={[form.compressionModel, form.compressionBaseURL, form.compressionApiKey]} 
              onChanges={[v => setForm({...form, compressionModel: v}), v => setForm({...form, compressionBaseURL: v}), v => setForm({...form, compressionApiKey: v})]} 
              disabled={loading || saving} 
            />
            <div className="config-item">
              <div className="config-item-info">
                <span className="config-item-label">STT 路径</span>
                <span className="config-item-desc">选择语音转文字使用本地 ONNX 或 Cloudflare 远端。不会自动兜底切换。</span>
              </div>
              <div className="config-item-control">
                <div className="select-container">
                  <button
                    type="button"
                    className={`select-trigger ${sttProviderMenuOpen ? "is-active" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (loading || saving) {
                        return;
                      }
                      setOpenTransportMenuIndex(-1);
                      setSttProviderMenuOpen((prev) => !prev);
                    }}
                    disabled={loading || saving}
                  >
                    <span>
                      {sttProviderOptions.find((item) => item.value === form.sttProvider)?.label ||
                        "local（本地 ONNX）"}
                    </span>
                  </button>
                  {sttProviderMenuOpen && (
                    <div className="select-dropdown" onClick={(event) => event.stopPropagation()}>
                      {sttProviderOptions.map((option) => (
                        <div
                          key={`stt_provider_${option.value}`}
                          role="button"
                          tabIndex={0}
                          className={`select-option ${
                            form.sttProvider === option.value ? "is-selected" : ""
                          }`}
                          onClick={() => {
                            setForm({ ...form, sttProvider: option.value });
                            setSttProviderMenuOpen(false);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setForm({ ...form, sttProvider: option.value });
                              setSttProviderMenuOpen(false);
                            }
                          }}
                        >
                          {option.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {form.sttProvider === "cloudflare" && (
              <>
                <ConfigRow
                  label="STT Cloudflare Token"
                  desc="Cloudflare API Token（Workers AI 权限）"
                  value={form.sttCloudflareApiToken}
                  onChange={v => setForm({ ...form, sttCloudflareApiToken: v })}
                  isPassword
                  disabled={loading || saving}
                />
                <ConfigRow
                  label="STT Cloudflare Account"
                  desc="Cloudflare Account ID"
                  value={form.sttCloudflareAccountId}
                  onChange={v => setForm({ ...form, sttCloudflareAccountId: v })}
                  disabled={loading || saving}
                />
                <ConfigRow
                  label="STT Cloudflare Model"
                  desc="示例：@cf/openai/whisper-large-v3-turbo"
                  value={form.sttCloudflareModel}
                  onChange={v => setForm({ ...form, sttCloudflareModel: v })}
                  disabled={loading || saving}
                />
              </>
            )}
          </div>
        </div>

        <div className="config-footer">
          {saveMessage && <span className="status-note success">{saveMessage}</span>}
          {(localError || error) && <span className="status-note error">{localError || error}</span>}
          <button type="submit" className="btn-primary" disabled={loading || saving}>{saving ? "保存中..." : "保存核心配置"}</button>
        </div>
      </form>

      <div className="config-divider" style={{ margin: '1.25rem 0' }} />

      <div className="module-title-wrap">
        <h2>MCP 服务器</h2>
        <p>扩展智能体的工具集。支持本地标准输入输出 (Stdio) 和远程 SSE (HTTP)。</p>
      </div>

      <form onSubmit={handleMcpSubmit}>
        {mcpServers.map((server, sIndex) => {
          const isExpanded = expandedServers[sIndex];
          return (
            <div key={sIndex} className={`config-section collapsible ${isExpanded ? '' : 'collapsed'}`}>
              <div className="config-section-header" onClick={() => toggleServerExpand(sIndex)}>
                <div className="header-main">
                  <input 
                    type="checkbox" 
                    checked={server.enabled} 
                    onClick={e => e.stopPropagation()} 
                    onChange={e => updateMcpServer(sIndex, 'enabled', e.target.checked)} 
                    style={{ width: 'auto' }} 
                  />
                  <h3 style={{ margin: 0, opacity: server.enabled ? 1 : 0.5 }}>{server.name || "未命名 Server"}</h3>
                  <span className="server-type-badge">{server.transport}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <button 
                    type="button" 
                    onClick={(e) => { e.stopPropagation(); setMcpServers(prev => prev.filter((_, i) => i !== sIndex)); }} 
                    className="text-btn-danger"
                  >
                    移除
                  </button>
                  <svg className="chevron icon" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"/></svg>
                </div>
              </div>

              <div className="config-section-body">
                <ConfigRow label="名称" desc="Server 唯一标识" value={server.name} onChange={v => updateMcpServer(sIndex, 'name', v)} disabled={mcpSaving} />
                
                <div className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">传输类型</span>
                    <span className="config-item-desc">选择连接方式</span>
                  </div>
                  <div className="config-item-control">
                    <div className="select-container">
                      <button
                        type="button"
                        className={`select-trigger ${openTransportMenuIndex === sIndex ? "is-active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSttProviderMenuOpen(false);
                          setOpenTransportMenuIndex((prev) => (prev === sIndex ? -1 : sIndex));
                        }}
                        disabled={mcpSaving}
                      >
                        <span>
                          {transportOptions.find((option) => option.value === server.transport)?.label ||
                            "Stdio (本地进程)"}
                        </span>
                      </button>
                      {openTransportMenuIndex === sIndex && (
                        <div className="select-dropdown" onClick={(event) => event.stopPropagation()}>
                          {transportOptions.map((option) => (
                            <div
                              key={`${sIndex}_${option.value}`}
                              role="button"
                              tabIndex={0}
                              className={`select-option ${
                                server.transport === option.value ? "is-selected" : ""
                              }`}
                              onClick={() => {
                                updateMcpServer(sIndex, "transport", option.value);
                                setOpenTransportMenuIndex(-1);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  updateMcpServer(sIndex, "transport", option.value);
                                  setOpenTransportMenuIndex(-1);
                                }
                              }}
                            >
                              {option.label}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {server.transport === 'stdio' ? (
                  <>
                    <ConfigRow label="命令" desc="可执行程序 (node, npx, python)" value={server.command} onChange={v => updateMcpServer(sIndex, 'command', v)} disabled={mcpSaving} />
                    <ConfigRow label="参数" desc="命令行参数 (空格分隔)" value={Array.isArray(server.args) ? server.args.join(' ') : server.args} onChange={v => updateMcpServer(sIndex, 'args', v)} disabled={mcpSaving} />
                    
                    <div className="config-item">
                      <div className="config-item-info">
                        <span className="config-item-label">环境变量 (Env)</span>
                        <span className="config-item-desc">配置 API Key 或其他运行参数</span>
                      </div>
                      <div className="config-item-control">
                        {server.env.map((env, eIndex) => (
                          <div key={eIndex} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <input placeholder="KEY" value={env.key} onChange={e => updateMcpEnv(sIndex, eIndex, 'key', e.target.value)} style={{ flex: 1 }} />
                            <input placeholder="VALUE" value={env.value} onChange={e => updateMcpEnv(sIndex, eIndex, 'value', e.target.value)} style={{ flex: 2 }} />
                            <button type="button" onClick={() => removeMcpEnv(sIndex, eIndex)} className="text-btn">×</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => addMcpEnv(sIndex)} className="text-btn-brand" style={{ width: 'fit-content' }}>+ 添加变量</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <ConfigRow label="URL" desc="远程 SSE 服务地址" value={server.url} onChange={v => updateMcpServer(sIndex, 'url', v)} placeholder="http://localhost:3001/sse" disabled={mcpSaving} />
                    <div className="config-item">
                      <div className="config-item-info">
                        <span className="config-item-label">请求头 (Headers)</span>
                        <span className="config-item-desc">配置 Authorization 或其他鉴权信息</span>
                      </div>
                      <div className="config-item-control">
                        {(server.headers || []).map((header, hIndex) => (
                          <div key={hIndex} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <input placeholder="Header-Name" value={header.key} onChange={e => updateMcpHeader(sIndex, hIndex, 'key', e.target.value)} style={{ flex: 1 }} />
                            <input placeholder="Value" value={header.value} onChange={e => updateMcpHeader(sIndex, hIndex, 'value', e.target.value)} style={{ flex: 2 }} />
                            <button type="button" onClick={() => removeMcpHeader(sIndex, hIndex)} className="text-btn">×</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => addMcpHeader(sIndex)} className="text-btn-brand" style={{ width: 'fit-content' }}>+ 添加 Header</button>
                      </div>
                    </div>
                  </>
                )}

                <div className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">超时设置 (ms)</span>
                    <span className="config-item-desc">配置启动与请求的超时时间（毫秒）</span>
                  </div>
                  <div className="config-item-control" style={{ flexDirection: 'row', gap: '1rem' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>启动超时</span>
                      <input type="number" value={server.startupTimeoutMs} onChange={e => updateMcpServer(sIndex, 'startupTimeoutMs', e.target.value)} placeholder="默认 10000" disabled={mcpSaving} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>请求超时</span>
                      <input type="number" value={server.requestTimeoutMs} onChange={e => updateMcpServer(sIndex, 'requestTimeoutMs', e.target.value)} placeholder="默认 60000" disabled={mcpSaving} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        <button type="button" onClick={addMcpServer} className="btn-add-section">+ 添加新的 MCP 服务器</button>

        <div className="config-footer">
          <span className="status-note">{mcpStatusText}</span>
          {mcpSaveMessage && <span className="status-note success">{mcpSaveMessage}</span>}
          {(mcpLocalError || mcpError) && <span className="status-note error">{mcpLocalError || mcpError}</span>}
          <button type="submit" className="btn-primary" disabled={mcpSaving}>{mcpSaving ? "正在应用..." : "应用 MCP 配置"}</button>
        </div>
      </form>
    </div>
  );
}

function ConfigRow({ label, desc, value, onChange, placeholder, isPassword, type = "text", disabled, isMulti, values, onChanges }) {
  return (
    <div className="config-item">
      <div className="config-item-info">
        <span className="config-item-label">{label}</span>
        <span className="config-item-desc">{desc}</span>
      </div>
      <div className="config-item-control">
        {isMulti ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {values.map((v, i) => (
              <input key={i} value={v} onChange={e => onChanges[i](e.target.value)} placeholder={i === 0 ? "Model" : i === 1 ? "URL" : "Key"} type={i === 2 ? "password" : "text"} disabled={disabled} />
            ))}
          </div>
        ) : (
          <input type={isPassword ? "password" : type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
        )}
      </div>
    </div>
  );
}
