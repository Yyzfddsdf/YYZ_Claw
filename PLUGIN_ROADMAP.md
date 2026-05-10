# Plugin Roadmap

## 目标
- 完成完整的 plugin 功能
- 完成完整的插件市场功能
- 完成全局 hook 机制

## 当前状态
- 已有基础 plugin 目录发现与 manifest 读取
- 已有插件技能、规则、资产的识别与展示
- 已有插件启用/停用与前端管理页
- `skills`、`rules`、`assets` 已存在，后续重点是标准化、扩展和市场联动
- 目前还不是完整的 Open Plugins 实现

## 还要补的内容
- 完整 plugin 功能
  - `commands`
  - `agents`
  - `hooks`
  - `mcpServers`
  - `app/` 插件级授权扩展
- 完整插件市场功能
  - 插件安装
  - 插件更新
  - 插件卸载
  - 市场列表与排序
  - 安装状态与认证状态
  - 本地 / 项目级插件的统一发现
- 全局 hook 机制
  - 不依赖单个插件启用的全局 hook
  - 会话/项目/用户范围的统一 hook 层
  - 全局 hook 与插件级 hook 的分层加载
- 核心授权扩展
  - `app/` 目录作为需要授权的 MCP 扩展入口
  - 一个插件可以声明多个 provider
  - 用户按 MCP / 按能力授权
  - token / scope / provider 绑定
  - 认证状态与插件能力联动

## 约束
- 不再做旧格式兼容
- 所有新插件实现优先按标准目录结构落地
- 标准来源以 Open Plugins 规范为准
