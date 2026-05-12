---
name: mcp
description: Explain and author MCP configuration for YYZ_Claw. Use when creating, updating, validating, or explaining global MCP in config/mcp.json or plugin-level MCP in a plugin .mcp.json file.
version: 1.0.0
author: YYZ_Claw
license: MIT
---

# MCP

Use this skill when the task is about:

- configuring a global MCP server
- configuring a plugin-level MCP server
- deciding where an MCP server should live
- explaining MCP JSON fields
- authoring `.mcp.json`
- authoring `config/mcp.json`
- explaining MCP naming, scope, and lifecycle

This skill is the source of truth for how MCP should be written in YYZ_Claw.

---

## 1. Two MCP scopes

YYZ_Claw has two MCP scopes:

### Global MCP

Use global MCP when the server should be available project-wide and is not tied to one plugin.

File:

- `config/mcp.json`

Top-level field:

- `servers`

### Plugin-level MCP

Use plugin-level MCP when the server belongs to one plugin and should only be visible when that plugin is active in the current conversation.

File:

- plugin root `/.mcp.json`

Top-level field:

- preferred: `mcpServers`
- compatible: `mcp_servers`

---

## 2. Global MCP format

Global MCP lives in:

- `config/mcp.json`

The top-level shape is:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "node",
      "args": ["D:\\mcp\\filesystem-server\\server.js"],
      "cwd": "D:\\mcp\\filesystem-server",
      "env": {},
      "enabled": true,
      "startupTimeoutMs": 10000,
      "requestTimeoutMs": 30000
    }
  ]
}
```

### Global MCP fields

- `name`
  - MCP server name
  - becomes part of the final tool namespace
- `transport`
  - `stdio` or `http`
- `command`
  - executable program to launch for `stdio`
- `args`
  - array of command arguments
- `cwd`
  - working directory for the launched process
- `env`
  - environment variables passed to the launched process
- `url`
  - remote endpoint for `http` transport
- `httpHeaders`
  - request headers for `http` transport
- `enabled`
  - whether the global MCP server is active
- `startupTimeoutMs`
  - startup timeout in milliseconds
- `requestTimeoutMs`
  - request timeout in milliseconds

### Global MCP behavior

- loaded by the host
- hot-reloaded when config changes
- visible across the whole project
- tool names become:
  - `mcp__<serverName>__<toolName>`

Example:

- `mcp__filesystem__read_file`

Global MCP supports the `.yyz` root shortcut:

- `${YYZ_ROOT}` or `$YYZ_ROOT` can be used in `command`, `args`, `cwd`, `env`, and `url`
- MCP server processes receive the `YYZ_ROOT` environment variable
- `YYZ_ROOT` comes from runtime `YYZ_DIR`: `YYZ_CLAW_HOME` if set, otherwise `<home>/.yyz`
- global MCP has one shared `${YYZ_ROOT}` and no plugin root
- plugin-level MCP may have many plugin roots, one per enabled plugin, via `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}`

Example:

```json
{
  "servers": [
    {
      "name": "local-memory",
      "transport": "stdio",
      "command": "node",
      "args": ["${YYZ_ROOT}/mcp/local-memory/server.js"],
      "cwd": "${YYZ_ROOT}/mcp/local-memory",
      "env": {
        "DATA_DIR": "${YYZ_ROOT}/memory"
      },
      "enabled": true
    }
  ]
}
```

---

## 3. Plugin-level MCP format

Plugin-level MCP lives in:

- plugin root `/.mcp.json`

Preferred top-level shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/filesystem.js", "--mode", "plugin"],
      "cwd": "${PLUGIN_ROOT}",
      "env": {
        "PLUGIN_MODE": "1"
      }
    }
  }
}
```

Compatible top-level shape:

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/filesystem.js"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### Plugin-level MCP fields

Supported fields per server:

- `command`
- `args`
- `env`
- `cwd`

Current recommended meaning:

- `command`
  - executable program
- `args`
  - array of arguments
- `env`
  - environment variables
- `cwd`
  - working directory

### Plugin-level MCP behavior

- loaded from the plugin's `/.mcp.json`
- only enabled plugins are considered
- only conversations whose `activePluginNames` include that plugin will expose the plugin MCP tools to the model
- tool names are namespaced to avoid collisions

Current plugin-level tool name shape:

- `mcp__<pluginName>__<serverName>__<toolName>`

Example:

- `mcp__novel_writer__hello__say_hello`

Current implementation is aimed at:

- local process MCP servers
- standard `stdio`-style process launch

Do not assume plugin-level MCP is the right place for a project-wide shared server.

---

## 4. `${YYZ_ROOT}`, `${PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_ROOT}`

`${YYZ_ROOT}` means:

- the current user `.yyz` root
- available in global MCP and plugin-level MCP
- resolved from `YYZ_CLAW_HOME` if set, otherwise `<home>/.yyz`

`${PLUGIN_ROOT}` means:

- the root directory of the current plugin

`${CLAUDE_PLUGIN_ROOT}` is a Claude plugin compatibility alias for `${PLUGIN_ROOT}`.

Plugin-level MCP server processes receive both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` environment variables.

It is a host-provided convenience placeholder.

Use it when your plugin-level MCP server needs paths inside the plugin bundle.

Recommended places to use it:

- inside `args`
- inside `cwd`
- inside `env`
- inside `command` only if the executable itself is bundled inside the plugin

Example:

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/demo.js", "--config", "${PLUGIN_ROOT}/config.json"],
      "cwd": "${PLUGIN_ROOT}",
      "env": {
        "DATA_DIR": "${PLUGIN_ROOT}/data"
      }
    }
  }
}
```

This means:

- `node` comes from the system
- `demo.js` comes from the plugin
- the MCP process starts in the plugin root
- `DATA_DIR` points to a plugin-local data directory

`${PLUGIN_ROOT}` is not required.

If the MCP server lives elsewhere, you can instead use:

- absolute paths
- `npx`
- system commands already on `PATH`

---

## 5. When to choose global vs plugin-level MCP

Choose **global MCP** when:

- the MCP server is shared across the whole project
- it is not conceptually owned by one plugin
- it should stay available regardless of plugin selection

Choose **plugin-level MCP** when:

- the MCP server belongs to a specific plugin workflow
- the MCP tools should only appear when that plugin is active in the current conversation
- the plugin bundles or owns the server config

---

## 6. Path rules

### Command and args

Use:

- `command` for the executable
- `args` as an array

Correct:

```json
{
  "command": "python",
  "args": ["server.py", "--name", "yyz"]
}
```

Avoid:

```json
{
  "command": "python server.py --name yyz"
}
```

Avoid:

```json
{
  "command": "python",
  "args": "server.py --name yyz"
}
```

### Why split them

- safer process spawning
- easier cross-platform behavior
- simpler quoting
- easier validation

---

## 7. Plugin manifest fields for MCP

In plugin manifests, YYZ_Claw currently accepts these path fields:

- preferred: `mcpServers`
- compatible: `mcp_servers`
- compatible legacy alias: `mcp`

Recommended plugin manifest snippet:

```json
{
  "name": "my-plugin",
  "description": "Example plugin",
  "mcpServers": "./.mcp.json"
}
```

This path field points to the MCP config file.
It is not the same thing as the top-level `mcpServers` object inside `/.mcp.json`.

---

## 8. Minimal plugin-level MCP example

Directory:

```text
my-plugin/
  .plugin/
    plugin.json
  .mcp.json
  servers/
    example-server.js
```

Manifest:

```json
{
  "name": "my-plugin",
  "description": "Example plugin",
  "mcpServers": "./.mcp.json"
}
```

Plugin MCP:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/example-server.js"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

---

## 9. Authoring checklist

When creating or updating MCP config, check these in order:

1. Is this global MCP or plugin-level MCP?
2. Is the top-level field correct?
   - global: `servers`
   - plugin: `mcpServers` or compatible `mcp_servers`
3. Is `command` only the executable?
4. Is `args` an array?
5. Does `cwd` make sense?
6. Are environment variables in `env`?
7. If this is plugin-level MCP, should paths use `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}`?
8. If this is plugin-level MCP, is the plugin manifest pointing to `./.mcp.json`?
9. If this is plugin-level MCP, should the tools really be plugin-scoped rather than global?

---

## 10. Do not do these

- Do not mix global `servers` format into plugin `/.mcp.json`
- Do not put a whole shell command string into `command`
- Do not make `args` a single string
- Do not choose plugin-level MCP for project-wide shared infrastructure without a good reason
- Do not assume plugin-level MCP tools are visible in every conversation

---

## 11. How to use this skill from plugin work

If you are working inside plugin creation or plugin editing:

- use this skill as the MCP source of truth
- do not redefine MCP format separately inside plugin instructions
- if the task is specifically about plugin-level MCP authoring, follow this skill directly
