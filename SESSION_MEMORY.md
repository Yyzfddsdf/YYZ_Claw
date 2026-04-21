# SESSION MEMORY

## 上一步实际完成了什么
- 已在聊天主链路新增联网工具：`web_search`、`web_fetch`，并接入 Tavily provider（可扩展工厂结构，当前固定 tavily）。
- 已在聊天主链路新增本地可见浏览器工具：`browser_open`、`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_wait`、`browser_snapshot`、`browser_screenshot`、`browser_vision`、`browser_close`。
- 已实现浏览器会话共享层：按会话自动拉起 Edge/Chrome（默认自动优先 Edge），通过 CDP 连接并复用。
- 已在配置页新增 `Tavily API Key` 输入项，并把后端配置 schema 扩展为支持 `webProvider`、`tavilyApiKey`、`tavilyBaseUrl`。
- 已新增 `playwright-core` 后端依赖，并完成构建校验。

## 下一步打算做什么
- 联调真实场景：配置 Tavily Key 后验证 `web_search/web_fetch` 返回质量与错误提示。
- 联调浏览器工具在本机的可见自动化表现（启动、导航、截图、关闭）。
- 根据实际操作效果收敛选择器策略与 snapshot 输出结构，必要时补充更稳的元素定位方案。

## 关键约束 / 风险
- 代码仓库当前是脏工作区，存在用户之前未提交改动；本次未回滚这些改动。
- 浏览器工具依赖本机已安装 Edge/Chrome，且需允许本地 CDP 端口。
- `browser_vision` 当前是“截图 + 文字上下文”路径，不是额外调用独立视觉模型服务。
