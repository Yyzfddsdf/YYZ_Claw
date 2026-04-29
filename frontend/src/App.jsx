import { useEffect, useMemo, useState } from "react";

import {
  fetchAutomationTasks,
  runAutomationTaskNow,
  updateAutomationTask
} from "./api/automationApi";
import { fetchConfig, saveConfig } from "./api/configApi";
import { fetchMcpConfig, saveMcpConfig } from "./api/mcpApi";
import { AutomationPanel } from "./modules/automation/AutomationPanel";
import { ChatPanel } from "./modules/chat/ChatPanel";
import { useChatSession } from "./modules/chat/useChatSession";
import { ConfigPanel } from "./modules/config/ConfigPanel";
import { DebatePanel } from "./modules/debate/DebatePanel";
import { MemoryPanel } from "./modules/memory/MemoryPanel";
import { PersonaPanel } from "./modules/personas/PersonaPanel";
import { RemoteControlPanel } from "./modules/remote-control/RemoteControlPanel";
import { SkillsPanel } from "./modules/skills/SkillsPanel";

function createEmptyConfig() {
  return {
    model: "",
    baseURL: "",
    apiKey: "",
    webProvider: "",
    tavilyApiKey: "",
    subagentModel: "",
    subagentBaseURL: "",
    subagentApiKey: "",
    maxContextWindow: "",
    compressionModel: "",
    compressionBaseURL: "",
    compressionApiKey: "",
    sttProvider: "local",
    sttCloudflareApiToken: "",
    sttCloudflareAccountId: "",
    sttCloudflareModel: "@cf/openai/whisper-large-v3-turbo"
  };
}

function createEmptyMcpConfig() {
  return {
    servers: []
  };
}

function hasRuntimeConfig(config) {
  return Boolean(config.model && config.baseURL && config.apiKey);
}

export default function App() {
  const [config, setConfig] = useState(createEmptyConfig);
  const [configError, setConfigError] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [mcpConfig, setMcpConfig] = useState(createEmptyMcpConfig);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [mcpError, setMcpError] = useState("");
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState("chat");
  const [automationConversationId, setAutomationConversationId] = useState("");
  const [automationTask, setAutomationTask] = useState(null);

  const chat = useChatSession(Number(config.maxContextWindow || 0));

  useEffect(() => {
    let mounted = true;

    async function loadConfig() {
      setConfigLoading(true);
      setConfigError("");

      try {
        const response = await fetchConfig();

        if (!mounted) return;

        setConfig({
          model: response?.config?.model ?? "",
          baseURL: response?.config?.baseURL ?? "",
          apiKey: response?.config?.apiKey ?? "",
          webProvider: response?.config?.webProvider ?? "",
          tavilyApiKey: response?.config?.tavilyApiKey ?? "",
          subagentModel: response?.config?.subagentModel ?? "",
          subagentBaseURL: response?.config?.subagentBaseURL ?? "",
          subagentApiKey: response?.config?.subagentApiKey ?? "",
          maxContextWindow:
            response?.config?.maxContextWindow === undefined ||
            response?.config?.maxContextWindow === null
              ? ""
              : String(response.config.maxContextWindow),
          compressionModel: response?.config?.compressionModel ?? "",
          compressionBaseURL: response?.config?.compressionBaseURL ?? "",
          compressionApiKey: response?.config?.compressionApiKey ?? "",
          sttProvider: response?.config?.sttProvider ?? "local",
          sttCloudflareApiToken: response?.config?.sttCloudflareApiToken ?? "",
          sttCloudflareAccountId: response?.config?.sttCloudflareAccountId ?? "",
          sttCloudflareModel:
            response?.config?.sttCloudflareModel ?? "@cf/openai/whisper-large-v3-turbo"
        });
      } catch (error) {
        if (!mounted) return;
        setConfigError(error.message || "加载配置失败");
      } finally {
        if (mounted) setConfigLoading(false);
      }
    }

    loadConfig();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadMcpConfig() {
      setMcpLoading(true);
      setMcpError("");

      try {
        const response = await fetchMcpConfig();

        if (!mounted) return;

        setMcpConfig(response?.config ?? createEmptyMcpConfig());
        setMcpStatus(response?.status ?? null);
      } catch (error) {
        if (!mounted) return;
        setMcpError(error.message || "加载 MCP 配置失败");
      } finally {
        if (mounted) setMcpLoading(false);
      }
    }

    loadMcpConfig();

    return () => {
      mounted = false;
    };
  }, []);

  async function handleSaveConfig(nextConfig) {
    setConfigSaving(true);
    setConfigError("");

    try {
      const response = await saveConfig(nextConfig);
      setConfig(response.config);
    } catch (error) {
      setConfigError(error.message || "保存配置失败");
      throw error;
    } finally {
      setConfigSaving(false);
    }
  }

  async function handleSaveMcpConfig(nextConfig) {
    setMcpSaving(true);
    setMcpError("");

    try {
      const response = await saveMcpConfig(nextConfig);
      setMcpConfig(response.config ?? nextConfig);
      setMcpStatus(response.status ?? null);
    } catch (error) {
      setMcpError(error.message || "保存 MCP 配置失败");
      throw error;
    } finally {
      setMcpSaving(false);
    }
  }

  async function loadAutomationTaskByConversationId(conversationId) {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      setAutomationTask(null);
      return null;
    }

    const response = await fetchAutomationTasks();
    const list = Array.isArray(response?.tasks) ? response.tasks : [];
    const matchedTask =
      list.find(
        (item) =>
          String(item?.conversationId ?? "").trim() === normalizedConversationId
      ) ?? null;
    setAutomationTask(matchedTask);
    return matchedTask;
  }

  async function handleOpenAutomationConversation(history) {
    const conversationId = String(history?.id ?? "").trim();
    if (!conversationId) {
      return;
    }
    const conversationSource = String(history?.source ?? "").trim().toLowerCase();
    const automationRootConversationId =
      conversationSource === "subagent"
        ? String(history?.parentConversationId ?? "").trim() || conversationId
        : conversationId;

    await chat.loadConversation(conversationId);
    await loadAutomationTaskByConversationId(automationRootConversationId);
    setAutomationConversationId(conversationId);
    setActiveWorkspace("automation-chat");
  }

  async function handleAutomationScheduleToggle(nextEnabled) {
    if (!automationTask?.id) {
      return;
    }
    await updateAutomationTask(automationTask.id, {
      enabled: Boolean(nextEnabled)
    });
    await loadAutomationTaskByConversationId(automationConversationId);
  }

  async function handleAutomationScheduleRunNow() {
    if (!automationTask?.id) {
      return;
    }
    await runAutomationTaskNow(automationTask.id);
    await loadAutomationTaskByConversationId(automationConversationId);
  }

  async function handleAutomationScheduleChangeTime(nextTimeOfDay) {
    if (!automationTask?.id) {
      return;
    }
    await updateAutomationTask(automationTask.id, {
      timeOfDay: String(nextTimeOfDay ?? "").trim()
    });
    await loadAutomationTaskByConversationId(automationConversationId);
  }

  const canChat = useMemo(() => hasRuntimeConfig(config), [config]);

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <header className="app-sidebar-header">
          <h1>Agent Console</h1>
          <p>智能体服务控制台</p>
        </header>

        <nav className="workspace-nav" role="tablist" aria-label="workspace folders">
          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "chat"}
            className={`nav-item ${activeWorkspace === "chat" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("chat")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            会话工作台
          </button>
          
          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "memory"}
            className={`nav-item ${activeWorkspace === "memory" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("memory")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M12 6v6l4 2" />
              <path d="M20 12a8 8 0 1 1-4-6.93" />
            </svg>
            长期记忆
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "personas"}
            className={`nav-item ${activeWorkspace === "personas" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("personas")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
              <path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
            Agent 身份
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "debate"}
            className={`nav-item ${activeWorkspace === "debate" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("debate")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M7 7h10M7 12h6M5 19l3-3h4a5 5 0 0 0 5-5V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v4a5 5 0 0 0 5 5" />
              <path d="M17 13l2 2l3-4" />
            </svg>
            AI 互博
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "config"}
            className={`nav-item ${activeWorkspace === "config" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("config")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            配置中心
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "automation" || activeWorkspace === "automation-chat"}
            className={`nav-item ${
              activeWorkspace === "automation" || activeWorkspace === "automation-chat" ? "active" : ""
            }`}
            onClick={() => setActiveWorkspace("automation")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M8 2v3M16 2v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
              <path d="M8 13h3M8 17h8" />
            </svg>
            自动化
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeWorkspace === "remote-control"}
            className={`nav-item ${activeWorkspace === "remote-control" ? "active" : ""}`}
            onClick={() => setActiveWorkspace("remote-control")}
          >
            <svg className="icon" viewBox="0 0 24 24">
              <path d="M12 3a9 9 0 0 1 9 9c0 4.97-4.03 9-9 9H6a3 3 0 0 1-3-3v-6a9 9 0 0 1 9-9z" />
              <path d="M8 10h8M8 14h5" />
            </svg>
            远程控制
          </button>
        </nav>
      </aside>

      <main className="workspace-main">
        {activeWorkspace === "chat" && (
          <section className="panel panel-chat" role="tabpanel" aria-label="chat workspace">
            <ChatPanel
              chat={chat}
              modelContextWindow={Number(config.maxContextWindow ?? 0)}
              disabled={!canChat}
              disabledReason="请先到配置中心保存 model / baseURL / apiKey"
              onNavigate={(nav) => setActiveWorkspace(nav)}
            />
          </section>
        )}

        {activeWorkspace === "skills" && (
          <section className="panel panel-skills" role="tabpanel" aria-label="skills workspace">
            <SkillsPanel
              chat={chat}
              onNavigate={(nav) => setActiveWorkspace(nav)}
            />
          </section>
        )}

        {activeWorkspace === "memory" && (
          <section className="panel panel-memory" role="tabpanel" aria-label="memory workspace">
            <MemoryPanel onNavigate={(nav) => setActiveWorkspace(nav)} />
          </section>
        )}

        {activeWorkspace === "personas" && (
          <section className="panel panel-personas" role="tabpanel" aria-label="persona workspace">
            <PersonaPanel chat={chat} onNavigate={(nav) => setActiveWorkspace(nav)} />
          </section>
        )}

        {activeWorkspace === "debate" && (
          <section className="panel panel-debate" role="tabpanel" aria-label="debate workspace">
            <DebatePanel
              disabled={!canChat}
              disabledReason="请先到配置中心保存 model / baseURL / apiKey"
            />
          </section>
        )}

        {activeWorkspace === "config" && (
          <section className="panel panel-config" role="tabpanel" aria-label="config workspace">
            <ConfigPanel
              initialConfig={config}
              initialMcpConfig={mcpConfig}
              mcpStatus={mcpStatus}
              loading={configLoading}
              saving={configSaving}
              mcpLoading={mcpLoading}
              mcpSaving={mcpSaving}
              onSave={handleSaveConfig}
              onSaveMcpConfig={handleSaveMcpConfig}
              error={configError}
              mcpError={mcpError}
            />
          </section>
        )}

        {activeWorkspace === "automation-chat" && (
          <section className="panel panel-chat" role="tabpanel" aria-label="automation chat workspace">
            <ChatPanel
              chat={chat}
              modelContextWindow={Number(config.maxContextWindow ?? 0)}
              disabled={!canChat}
              disabledReason="请先到配置中心保存 model / baseURL / apiKey"
              onNavigate={(nav) => setActiveWorkspace(nav)}
              showHistoryPane={false}
              onBack={() => setActiveWorkspace("automation")}
              automationSchedule={
                automationTask
                  ? {
                      ...automationTask,
                      onToggleEnabled: handleAutomationScheduleToggle,
                      onRunNow: handleAutomationScheduleRunNow,
                      onChangeTime: handleAutomationScheduleChangeTime
                    }
                  : null
              }
            />
          </section>
        )}

        {activeWorkspace === "remote-control" && (
          <section className="panel panel-remote-control" role="tabpanel" aria-label="remote control workspace">
            <RemoteControlPanel />
          </section>
        )}

        {activeWorkspace === "automation" && (
          <section className="panel panel-automation" role="tabpanel" aria-label="automation workspace">
            <AutomationPanel
              onOpenConversation={(history) => {
                void handleOpenAutomationConversation(history);
              }}
              activeConversationId={
                activeWorkspace === "automation-chat"
                  ? String(chat.activeConversationId ?? "").trim()
                  : String(automationConversationId ?? "").trim()
              }
            />
          </section>
        )}
      </main>
    </div>
  );
}
