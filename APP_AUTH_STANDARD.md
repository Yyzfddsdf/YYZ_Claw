# App Auth Standard

## 目标
- 定义插件里的 `app/` 授权扩展能力
- 支持**部分需要授权的 MCP** 接入用户授权
- 作为 OAuth-like 的账号绑定与权限层
- 让插件在需要外部账号时，不把认证逻辑混进核心插件标准

## 定位
- `app/` 不是 Open Plugins 标准的核心组件
- `app/` 是我们框架里的**核心扩展能力**
- 它解决的是“某些 MCP 要不要、以及怎么拿到用户授权”
- 它不是 `skills/`、`commands/`、`mcpServers` 的替代品

## 核心用途
- 让某些 MCP 在使用前先完成账号授权
- 让某些 MCP 根据账号、组织、scope 解锁能力
- 保存 provider 绑定信息
- 让未授权的 MCP 只暴露基础能力，授权后再暴露增强能力

## 目录职责
- `app/` 目录是插件级的授权扩展目录
- 它描述的是“这个插件需要哪些授权能力”，不是“按软件拆目录”
- 一个插件可以在 `app/` 里声明多个授权 provider
- 这些 provider 是同一个插件的不同外部账号能力，不是多个软件的树状拆分
- `app/` 目录可以包含：
  - 登录入口定义
  - OAuth 配置
  - 回调处理
  - token 存储策略
  - scope 说明
  - 账号状态检测

## 结构建议
```text
plugin-name/
  .plugin/
    plugin.json
  app/
    app.json
    oauth.json
    scopes.json
    providers.json
```

## `app.json` 作用
- 定义这个插件里哪些 MCP 需要授权
- 定义授权名称和展示文案
- 定义这个插件支持哪些外部 provider
- 定义 OAuth 或其他认证方式
- 定义需要的 scopes
- 定义回调地址或宿主处理方式
- 定义账号状态读取方式

## `providers.json` 作用
- 列出这个插件支持的外部授权提供方
- 例如：
  - GitHub
  - Google Drive
  - Slack
- 每个 provider 是同一个插件授权扩展域下的一个能力点

## `oauth.json` 作用
- 描述 OAuth-like 授权流程
- 可包含：
  - `clientId`
  - `authorizationUrl`
  - `tokenUrl`
  - `redirectUri`
  - `scopes`
  - `pkce`
  - `refreshToken`

## `scopes.json` 作用
- 描述这个 app 需要哪些权限
- 例如：
  - 读仓库
  - 写评论
  - 读文档
  - 读日历
  - 访问组织资源

## 运行时行为
- 插件加载时可以读取 `app/` 是否存在
- 宿主可以根据 `app/` 判断这个插件里的哪些 MCP 需要授权
- 如果需要授权，宿主应展示授权入口
- 授权完成后，宿主保存凭证或绑定结果
- 后续相关 MCP 能力根据授权状态决定是否可用

## 与 `connector` 的关系
- `connector` 是实现层的绑定对象
- `app/` 是规范层的授权声明
- `app/` 说明“这个插件里的某些 MCP 要什么授权”
- `connector` 负责“把这个授权真连上”
- 如果以后落地到具体实现，可以再把 `connector` 映射到 `app` 声明

## 与 Open Plugins 的关系
- Open Plugins 没有把 `app/` 做成核心标准组件
- 我们这里把它定义成扩展能力
- 这属于我们的框架创新，不强依赖 Open Plugins 原生规范

## 与 MCP 的关系
- MCP 负责工具能力
- `app/` 负责这些 MCP 在使用前需要的账号和权限能力
- 两者可以结合：
  - 先授权 app
  - 再启用需要该账号的 MCP 工具

## 核心创新点
- 让部分 MCP 能按能力请求授权，而不是一刀切全开
- 让插件市场可以区分“可直接用”和“需授权后可用”
- 让插件真正具备账号级、组织级、权限级的扩展能力

## 当前边界
- 这套能力目前是规范层
- 不等于已经实现完整 OAuth 流程
- 后续实现时优先支持可审计、可撤销、可分 scope 的授权

## 后续实现要求
- 不要把授权逻辑混进 `skills` 或 `commands`
- 不要把 `app/` 当成普通静态资源目录
- 不要让授权状态和插件启用状态混为一谈
- 不要把 `app/` 跟 hooks 挂钩
- 如果以后细化成具体 JSON 协议，先更新本文件
