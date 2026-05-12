# MCP 使用说明

## 这份文档是干什么的

这份文档讲的是：

- 全局 MCP 怎么配
- 插件级 MCP 怎么配
- 当前项目到底支持到什么程度
- 会话里什么时候能看到插件 MCP 工具

标准定义看：

- [MCP_STANDARD.md](/D:/Work/YYZ_Claw/MCP_STANDARD.md)

---

## 1. 全局 MCP

全局 MCP 配在：

- `config/mcp.json`

顶层格式：

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

适合：

- 整个项目都要用的 MCP
- 不属于某个插件的 MCP

全局 MCP 支持 `.yyz` 根目录便捷访问：

- `${YYZ_ROOT}` 会在 `command`、`args`、`cwd`、`env`、`url` 中展开为当前用户的 `.yyz` 根目录。
- `$YYZ_ROOT` 是同义写法。
- MCP 进程环境变量会自动注入 `YYZ_ROOT`。
- `YYZ_ROOT` 来自运行时 `YYZ_DIR`：如果设置了 `YYZ_CLAW_HOME` 就使用该目录，否则使用当前用户主目录下的 `.yyz`。
- 全局 MCP 只有一个共享的 `${YYZ_ROOT}`，没有插件根目录。
- 插件级 MCP 可以有多个插件根目录，每个启用插件各自展开自己的 `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`。

示例：

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

## 2. 插件级 MCP

插件级 MCP 配在插件根目录：

- `/.mcp.json`

当前实现支持两个顶层字段：

- `mcpServers`
- `mcp_servers`

推荐优先写：

- `mcpServers`

### 示例 1：推荐写法

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/my-server.js", "--mode", "plugin"],
      "env": {
        "PLUGIN_MODE": "1"
      },
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### 示例 2：兼容写法

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/my-server.js"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### 支持字段

- `command`
- `args`
- `env`
- `cwd`

说明：

- `command` 放可执行程序
- `args` 必须是数组
- `cwd` 是工作目录
- `env` 是进程环境变量
- `${YYZ_ROOT}` 会在运行时展开成当前用户的 `.yyz` 根目录
- `${PLUGIN_ROOT}` 会在插件级 MCP 中展开成插件根目录
- `${CLAUDE_PLUGIN_ROOT}` 是插件级 MCP 的兼容别名，含义同 `${PLUGIN_ROOT}`

### `${YYZ_ROOT}`、`${PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_ROOT}` 应该怎么用

`${YYZ_ROOT}` 代表**当前用户的 `.yyz` 根目录**，全局 MCP 和插件级 MCP 都可以使用。

`${PLUGIN_ROOT}` 代表**当前插件的根目录**，只适用于插件级 MCP。

`${CLAUDE_PLUGIN_ROOT}` 是兼容 Claude 插件格式的别名，含义同 `${PLUGIN_ROOT}`，也只适用于插件级 MCP。

它们都是宿主提供的路径占位符，用来避免把路径写死成绝对路径。

适合填写在这些位置：

- `args`
  - 当参数里要传插件内脚本、配置文件、数据目录路径时
- `cwd`
  - 当 MCP server 希望以插件根目录作为工作目录时
- `env`
  - 当环境变量里要引用插件内路径时
- `command`
  - 只有当可执行文件本身就放在插件目录里时才这样写

推荐示例：

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

这个示例里：

- `command`
  - 是系统里的 `node`
- `args`
  - 指向插件自己带的 `demo.js`
  - 也顺便传入插件自己的 `config.json`
- `cwd`
  - 让这个 MCP server 以插件根目录启动
- `env.DATA_DIR`
  - 告诉 server 它的数据目录在插件根目录下的 `data/`

如果你的 MCP server 不在插件目录里，也可以完全不用 `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`，直接写：

- 系统命令
- `npx` 包
- 绝对路径

---

## 3. plugin manifest 怎么写

插件 manifest 里，当前实现也支持两种字段名来指向 `.mcp.json`：

- `mcpServers`
- `mcp_servers`

推荐写法：

```json
{
  "name": "my-plugin",
  "description": "Example plugin",
  "mcpServers": "./.mcp.json"
}
```

兼容写法：

```json
{
  "name": "my-plugin",
  "description": "Example plugin",
  "mcp_servers": "./.mcp.json"
}
```

---

## 4. 当前项目里的真实加载规则

### 全局 MCP

- 后端启动后统一加载
- 热刷新走全局 MCP 管理链

### 插件级 MCP

- 插件必须是 enabled
- 插件根目录里要存在 `.mcp.json`
- 后端会读取并启动插件声明的 MCP server

但是要注意：

- **插件 MCP server 启动** 和 **工具对当前会话可见** 不是一回事

当前规则是：

- 已启用插件的 MCP server 可以被宿主加载
- 只有当前会话的 `activePluginNames` 命中了该插件
- 这些 MCP 工具才会真正出现在模型可用工具列表里

也就是说：

- 插件没启用：不会加载
- 插件启用了，但当前会话没选它：工具不会暴露给这轮模型
- 插件启用了，当前会话也选了它：工具才可用

---

## 5. 工具名会长什么样

插件级 MCP 工具会被自动命名空间化。

当前实现里，工具名大致会变成：

- `mcp__<pluginName>__<serverName>__<toolName>`

例如：

- 插件名：`novel-writer`
- server 名：`hello`
- tool 名：`say_hello`

最终可能是：

- `mcp__novel_writer__hello__say_hello`

这样做是为了：

- 不和全局 MCP 冲突
- 不和本地工具冲突
- 不和别的插件 MCP 冲突

---

## 6. 推荐用法

推荐把插件级 MCP 用在这些场景：

- 某个插件私有的工具链
- 某个插件自己的外部桥接能力
- 某个插件自己的本地 server

不推荐拿插件级 MCP 代替全局 MCP 去做：

- 整个项目都共用的通用工具
- 和插件完全无关的基础设施

这种应该继续放全局 MCP。

---

## 7. 当前限制

当前插件级 MCP 已经支持：

- 读取 `.mcp.json`
- 兼容 `mcpServers` / `mcp_servers`
- 跟随插件启停刷新
- 在会话里按 `activePluginNames` 暴露工具

当前还没做的：

- 插件级 MCP 的前端可视化编辑器
- 远程 HTTP 型插件 MCP 的标准化主路径
- 更细粒度的插件 MCP 状态面板

---

## 8. 最小排查清单

如果插件 MCP 没生效，先看：

1. 插件是否 enabled
2. 插件根目录是否真的有 `.mcp.json`
3. `.mcp.json` 顶层是否是：
   - `mcpServers`
   - 或 `mcp_servers`
4. `command` 是否可执行
5. `args` 是否是数组
6. 当前会话是否真的选中了这个插件
