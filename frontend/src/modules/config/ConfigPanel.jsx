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
    maxContextWindow:
      config?.maxContextWindow === undefined || config?.maxContextWindow === null
        ? ""
        : String(config.maxContextWindow)
  };
}

function normalizeMcpConfig(config) {
  return JSON.stringify(config ?? { servers: [] }, null, 2);
}

function formatStatusText(status) {
  if (!status) {
    return "尚未加载 MCP 配置";
  }

  const toolCount = Number(status.toolCount ?? 0);
  const errorCount = Number(status.errorCount ?? 0);

  return `已加载 ${toolCount} 个 MCP 工具${errorCount > 0 ? `，${errorCount} 个 server 失败` : ""}`;
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
  const [mcpText, setMcpText] = useState(() => normalizeMcpConfig(initialMcpConfig));
  const [mcpLocalError, setMcpLocalError] = useState("");
  const [mcpSaveMessage, setMcpSaveMessage] = useState("");

  useEffect(() => {
    setForm(normalizeConfig(initialConfig));
  }, [initialConfig]);

  useEffect(() => {
    setMcpText(normalizeMcpConfig(initialMcpConfig));
  }, [initialMcpConfig]);

  const mcpStatusText = useMemo(() => formatStatusText(mcpStatus), [mcpStatus]);

  async function handleSubmit(event) {
    event.preventDefault();

    const payload = {
      model: form.model.trim(),
      baseURL: form.baseURL.trim(),
      apiKey: form.apiKey.trim(),
      webProvider: "tavily",
      tavilyApiKey: form.tavilyApiKey.trim(),
      subagentModel: form.subagentModel.trim(),
      subagentBaseURL: form.subagentBaseURL.trim(),
      subagentApiKey: form.subagentApiKey.trim(),
      compressionModel: form.compressionModel.trim(),
      compressionBaseURL: form.compressionBaseURL.trim(),
      compressionApiKey: form.compressionApiKey.trim()
    };

    const maxContextWindowText = String(form.maxContextWindow ?? "").trim();
    if (maxContextWindowText) {
      const maxContextWindow = Number(maxContextWindowText);
      if (!Number.isInteger(maxContextWindow) || maxContextWindow <= 0) {
        setLocalError("最大对话窗口必须是正整数");
        return;
      }
      payload.maxContextWindow = maxContextWindow;
    }

    if (!payload.model || !payload.baseURL || !payload.apiKey) {
      setLocalError("model / baseURL / apiKey 都是必填项");
      return;
    }

    setLocalError("");
    setSaveMessage("");

    try {
      await onSave(payload);
      setSaveMessage("配置已保存到后端 config/config.json");
    } catch {
      setSaveMessage("");
    }
  }

  async function handleMcpSubmit(event) {
    event.preventDefault();

    let parsed;
    try {
      parsed = JSON.parse(mcpText);
    } catch {
      setMcpLocalError("MCP 配置必须是合法 JSON");
      return;
    }

    setMcpLocalError("");
    setMcpSaveMessage("");

    try {
      await onSaveMcpConfig(parsed);
      setMcpSaveMessage("MCP 配置已保存并热加载");
    } catch {
      setMcpSaveMessage("");
    }
  }

  function updateField(field, value) {
    setForm((prev) => ({
      ...prev,
      [field]: value
    }));
  }

  return (
    <div className="config-module">
      <div className="module-title-wrap">
        <h2>运行配置</h2>
        <p>主模型必填。子智能体和压缩模型都可单独配置；留空时自动回退主模型配置。</p>
      </div>

      <form className="config-form" onSubmit={handleSubmit}>
        <label>
          <span>Model</span>
          <input
            value={form.model}
            onChange={(e) => updateField("model", e.target.value)}
            placeholder="例如 gpt-4-mini"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Base URL</span>
          <input
            value={form.baseURL}
            onChange={(e) => updateField("baseURL", e.target.value)}
            placeholder="例如 https://api.openai.com/v1"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>API Key</span>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => updateField("apiKey", e.target.value)}
            placeholder="sk-..."
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Tavily API Key</span>
          <input
            type="password"
            value={form.tavilyApiKey}
            onChange={(e) => updateField("tavilyApiKey", e.target.value)}
            placeholder="tvly-..."
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Max Context Window</span>
          <input
            type="number"
            min="1"
            step="1"
            value={form.maxContextWindow}
            onChange={(e) => updateField("maxContextWindow", e.target.value)}
            placeholder="例如 128000"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Subagent Model</span>
          <input
            value={form.subagentModel}
            onChange={(e) => updateField("subagentModel", e.target.value)}
            placeholder="留空则回退主 Model"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Subagent Base URL</span>
          <input
            value={form.subagentBaseURL}
            onChange={(e) => updateField("subagentBaseURL", e.target.value)}
            placeholder="留空则回退主 Base URL"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Subagent API Key</span>
          <input
            type="password"
            value={form.subagentApiKey}
            onChange={(e) => updateField("subagentApiKey", e.target.value)}
            placeholder="留空则回退主 API Key"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Compression Model</span>
          <input
            value={form.compressionModel}
            onChange={(e) => updateField("compressionModel", e.target.value)}
            placeholder="留空则回退主 Model"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Compression Base URL</span>
          <input
            value={form.compressionBaseURL}
            onChange={(e) => updateField("compressionBaseURL", e.target.value)}
            placeholder="留空则回退主 Base URL"
            disabled={loading || saving}
          />
        </label>

        <label>
          <span>Compression API Key</span>
          <input
            type="password"
            value={form.compressionApiKey}
            onChange={(e) => updateField("compressionApiKey", e.target.value)}
            placeholder="留空则回退主 API Key"
            disabled={loading || saving}
          />
        </label>

        <button type="submit" disabled={loading || saving}>
          {saving ? "保存中..." : "保存配置"}
        </button>
      </form>

      {loading && <p className="status-note">正在读取后端配置...</p>}
      {saveMessage && <p className="status-note success">{saveMessage}</p>}
      {(localError || error) && <p className="status-note error">{localError || error}</p>}

      <div className="config-divider" />

      <div className="module-title-wrap config-subtitle">
        <h2>MCP 配置</h2>
        <p>使用 `config/mcp.json` 管理本地 MCP servers，保存后会自动热加载。</p>
      </div>

      <form className="config-form mcp-form" onSubmit={handleMcpSubmit}>
        <label>
          <span>Servers JSON</span>
          <textarea
            value={mcpText}
            onChange={(e) => setMcpText(e.target.value)}
            placeholder='{"servers":[{"name":"filesystem","command":"node","args":["server.js"]}]}'
            disabled={mcpLoading || mcpSaving}
          />
        </label>

        <button type="submit" disabled={mcpLoading || mcpSaving}>
          {mcpSaving ? "保存中..." : "保存 MCP 配置"}
        </button>
      </form>

      <p className="status-note">{mcpStatusText}</p>
      {mcpLoading && <p className="status-note">正在读取 MCP 配置...</p>}
      {mcpSaveMessage && <p className="status-note success">{mcpSaveMessage}</p>}
      {(mcpLocalError || mcpError) && (
        <p className="status-note error">{mcpLocalError || mcpError}</p>
      )}
    </div>
  );
}


