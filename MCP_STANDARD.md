# MCP Standard

## 目标
- 定义本项目里的 MCP 规范
- 区分全局 MCP 和插件内 MCP
- 明确 JSON 结构、字段含义、作用域和生命周期
- 为后续全局 MCP、插件 MCP、市场和 hook 作用域联动提供统一标准

## 结论
- **JSON 格式不一样**
- 但它们底层都遵守同一套 **Model Context Protocol**
- 也就是说：
  - **协议相同**
  - **配置结构不同**
  - **加载位置不同**
  - **生命周期不同**
  - **作用域不同**

## 1. 全局 MCP

### 1.1 文件位置
- `config/mcp.json`

### 1.2 顶层格式
```json
{
  "servers": []
}
```

### 1.3 server 结构
```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "node",
  "args": ["server.js"],
  "cwd": "D:\\mcp\\filesystem-server",
  "env": {},
  "enabled": true,
  "startupTimeoutMs": 10000,
  "requestTimeoutMs": 30000
}
```

### 1.4 字段含义
- `name`：服务器名称，也是工具命名前缀的一部分
- `transport`：传输方式，`stdio` 或 `http`
- `command`：启动 MCP server 的命令
- `args`：命令参数数组
- `cwd`：启动目录
- `env`：环境变量
- `url`：`http` 传输时的远程地址
- `httpHeaders`：`http` 传输时的请求头
- `enabled`：是否启用
- `startupTimeoutMs`：启动超时
- `requestTimeoutMs`：请求超时

### 1.5 行为
- 保存后热加载
- 由宿主统一管理
- 加载后工具和本地工具一起进入可用工具列表
- 工具名自动加前缀：
  - `mcp__<serverName>__<toolName>`

## 2. 插件内 MCP

### 2.1 文件位置
- 插件根目录的 `/.mcp.json`

### 2.2 顶层格式
```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${PLUGIN_ROOT}/data"
      },
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### 2.2.1 最标准示例
```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/servers/db-server.js", "--config", "${PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${PLUGIN_ROOT}/data"
      },
      "cwd": "${PLUGIN_ROOT}"
    },
    "plugin-api": {
      "command": "npx",
      "args": ["@company/mcp-server", "--plugin-mode"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### 2.2.2 这个示例怎么理解
- `mcpServers` 是插件内 MCP 的顶层集合
- 每个 key 是一个 server 名字，建议短、稳定、可读
- `command` 放可执行程序，不放整串 shell 命令
- `args` 放参数数组，逐项拆开
- `env` 放需要注入的环境变量
- `cwd` 放工作目录
- `${PLUGIN_ROOT}` 代表插件根目录，由宿主展开
- 这份格式对应的是**本地进程型 MCP server**
- 官方这页没有把 `url` / `httpHeaders` 标成插件 `.mcp.json` 的标准字段

### 2.2.3 推荐写法
- 能写成 `command + args` 就不要拼成一整串字符串
- 需要脚本时，把脚本文件放进 `args[0]`
- 需要密钥时优先放 `env`
- 需要插件相对路径时用 `${PLUGIN_ROOT}`
- 一个插件里多个 MCP server 可以并列放在同一个 `mcpServers` 里

### 2.2.1 官方 Open Plugins 口径
- Open Plugins 官方示例只展示了本地进程型 MCP server
- 官方字段只有 `command`、`args`、`env`、`cwd`
- 官方文档没有把 `url`、`httpHeaders` 作为插件 `.mcp.json` 的标准字段
- 也就是说，Open Plugins 的插件内 MCP 格式目前可以确定的是本地 stdio / 进程型配置
- 如果要做远程 MCP，那是 MCP 协议层或宿主扩展层的能力，不是 Open Plugins 这页已经明确写死的插件格式

### 2.3 字段含义
- `mcpServers`：插件内 MCP server 集合
- 每个 key 是一个 server 名称
- `command`：启动命令
- `args`：启动参数
- `env`：环境变量
- `cwd`：工作目录
- 支持 `${PLUGIN_ROOT}` 占位符

### 2.4 行为
- 跟着插件一起分发
- 插件启用时自动启动
- 插件停用或会话结束时停止
- 属于插件能力的一部分
- 工具命名也要做命名空间隔离

## 3. 两者差别

### 3.1 配置位置
- 全局 MCP：`config/mcp.json`
- 插件 MCP：插件根目录 `/.mcp.json`

### 3.2 顶层结构
- 全局 MCP：`servers`
- 插件 MCP：`mcpServers`

### 3.3 生命周期
- 全局 MCP：宿主启动后热加载管理
- 插件 MCP：插件启用时启动，停用时停止

### 3.4 作用域
- 全局 MCP：整个项目可见
- 插件 MCP：只属于该插件

### 3.5 配置语义
- 全局 MCP：是“把外部 MCP 接到项目里”
- 插件 MCP：是“把 MCP 打包进插件里”

## 4. 共同协议层
- 两种 MCP 都必须实现 Model Context Protocol
- 它们暴露出来的能力都还是：
  - `tools`
  - `resources`
  - `prompts`
- 只是配置和加载方式不同

## 5. 命名与前缀
- 全局 MCP 工具前缀：
  - `mcp__<serverName>__<toolName>`
- 插件内 MCP 也应使用命名空间化工具名
- 不允许和本地工具直接冲突

## 6. 和 hook 的关系
- MCP 是工具来源
- hook 可以在 `preToolUse` / `postToolUse` 作用于 MCP 工具
- hook 的 MCP 作用域默认只作用于本插件自己的 MCP
- hook 的 matcher 在 MCP 作用域下可以写 MCP 名字或工具命名空间

## 7. 当前实现边界
- 我们项目现在已经有全局 MCP 热加载
- 我们项目还没有把插件内 MCP 做成完整标准化实现
- 现在 plugin 系统里对 `.mcp.json` 主要还是存在性识别，不是完整接管

## 8. 后续实现要求
- 全局 MCP 和插件 MCP 不要混用成同一种 JSON
- 解析器要分别处理 `servers` 和 `mcpServers`
- 如果以后扩展字段，先更新本文件
