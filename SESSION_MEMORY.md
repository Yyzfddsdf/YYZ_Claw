# SESSION MEMORY

## 上一步实际完成了什么
- 已开始重构子智能体能力装配：
  - `ScopedToolRegistry` 新增“默认继承全部主工具 + 黑名单剔除”能力。
  - `AgentRuntimeFactory` 改为子智能体默认继承主工具池全部工具，只从 `backend/src/subagents/tools` 读取共享私有工具，只从 `backend/src/subagents/hooks` 读取共享私有 hook。
  - 新增全局子智能体工具黑名单配置 [backend/src/services/subagents/subagentToolPolicy.js](/D:/Work/YYZ_Claw/backend/src/services/subagents/subagentToolPolicy.js)。
  - 子智能体 definition 已去掉 `toolsDir / hooksDir / inheritedBaseToolNames / inheritedBaseHookNames`，definition 只保留角色元数据与 prompt 入口。
  - 原本挂在 `builder / researcher / reviewer` 下的能力型私有工具已搬回 `backend/src/services/tools`，主智能体和子智能体现在共用同一套实现能力工具。
  - 子智能体目录下只保留共享私有工具 `subagent_finish_report`。
  - 原本每个子智能体的私有 hook 已删除，约束已迁回对应 `prompt.md`。
  - 新增所有子智能体共享的通用 hook：`backend/src/subagents/hooks/subagentSharedDiscipline.hook.js`。
- `npm run build` 已通过，说明这轮工具/hook 收敛没有打断基础构建。
- 已确认子智能体的 `goal_submit` 与整组 `plan_*` 不再进入全局黑名单；子智能体现在可以维护自己的独立 `goal/plan` 状态。
- 已在 `code mode` 内加入很细的左侧活动栏，支持 `文件树 / Git` 两种面板切换，顶部全局 `code / work` 切换按用户要求未改。
- 已补 Git 面板：commit message 输入框、AI 流式生成、部分文件勾选提交、无选择时默认 push、单文件回退、分支列表、本地/远程分支合并显示、Git 不可用 / 初始化 Git 状态。
- 已补后端 Git 能力：状态、diff 预览、初始化、stage、commit、push、revert、AI commit 描述流式接口。
- 已把工作区按钮统一改成符号图标按钮，避免文字按钮。
- 已按反馈把左侧活动条改成白底，并把两个模式按钮改成更明确的文件 / 分支图标。
- 已把 Git 文件列表从原始 `?? / untracked / English status` 改成中文状态徽标，并去掉原始状态码显示，方便区分“未追踪 / 已修改 / 已暂存”等状态。
- 已把 Git 列表拆成“待提交 / 未提交”两个区域，新增按钮是把文件加入待提交区而不是简单勾选。
- 已把刷新按钮单独做成更轻的蓝色工具按钮。
- 已把 Git composer 重排成三层结构：顶部极窄刷新条，中间大输入块，AI 生成按钮嵌在输入框右上角，底部放 commit / push 主按钮。
- 已把主操作按钮改成扁平文字胶囊按钮，commit / push 直接可见，不再是方形图标块。
- 已把分支区压扁成更像时间线的卡片列表，分支名、当前分支 sha、远程分支 sha、最新提交描述都会显示，领先关系用小标签标注。
- 已开始把分支区进一步收敛成单列时间线，去掉了 local / remote 大分组和 `origin` 伪节点，分支行只保留分支名与“当前 / 追踪 / 本地最新 / 远程最新”这类小标注，不再显式展示 local / remote 字样。
- 已把“待提交”在未选中文件时的空区域继续收紧，改成让未提交文件列表直接向下延展到分支区上方。
- 正在继续压缩分支时间线：修正 `HEAD -> main` 兜底导致每条记录都被当成当前分支的问题，避免 `当前 / 本地领先` chip 在每个节点重复出现；同时把右侧 chip 真正贴右并提升层级，避免被提交描述挤住。
- 已把分支时间线的展开详情改成全量文件列表，不再只显示前 4 个文件；文件行可点击，后端新增了 commit 级单文件 diff 预览接口，准备把中间编辑区切到分支文件的详细 before/after diff。
- 已给分支时间线行加了白底 hover 详情卡，鼠标移到分支上会展示完整 commit 信息、时间、本地账号名/邮箱、提交作者/邮箱、增减行和文件数。
- 已把分支 hover 详情改成右侧固定浮层，不再挂在分支条下面，避免挡住其他分支；浮层用更高 z-index 覆盖编辑区。
- 已把 hover 浮层里的 commit 描述改成可完整换行展示，不再省略，浮层本身也扩大并允许内部滚动。
- 已把 Git 主按钮逻辑修正为：只要存在 diff，且没有勾选文件，就默认 commit 全部 diff；只有工作区干净时才会切成 push。
- `npm run build` 已通过，后端新模块也已做导入检查。

- 已把子智能体定义资产迁到 `.yyz/subagents`，registry 改为读取 `definition.json + prompt.md`；共享 hooks/tools 仍留在源码目录。
- 已新增子智能体资产管理 API 与前端面板，支持在侧边栏工作区里新建、编辑、删除子智能体类型。
- 已修复打包版主进程启动后端时的 `spawn ...\\YYZ_CLAW.exe ENOENT`：
  - 根因是打包态子进程沿用了 `app.asar` 路径作为 `cwd`，Windows 无法把 asar 虚拟路径当真实工作目录。
  - [electron/main.cjs](/D:/Work/YYZ_Claw/electron/main.cjs) 现已改为：
    - 脚本入口仍指向 `app.getAppPath()/service.js`
    - 但打包态 `cwd` 改为 `path.dirname(process.execPath)` 这个真实磁盘目录
  - 已重新生成 [release/win-unpacked](/D:/Work/YYZ_Claw/release/win-unpacked) 和 [YYZ_CLAW Setup 0.1.0.exe](/D:/Work/YYZ_Claw/release/YYZ_CLAW%20Setup%200.1.0.exe)
  - 已实测直接启动 `win-unpacked\\YYZ_CLAW.exe` 能正常拉起主窗口，不再弹主进程 JavaScript 错误。

## 下一步打算做什么
- 继续验证安装版首次启动时，`.yyz/subagents` 默认资产初始化是否正常。
- 继续检查 Git 分支时间线与 commit 级 diff 预览的交互细节，尤其是 hover 浮层和详细 diff 切换。
- 如有需要，补齐 `package.json` 的 `description / author`，去掉打包日志里的提醒。

## 关键约束 / 风险
- Git 面板依赖本机 `git` 可用；无仓库时会走初始化，若外部仓库状态变化，branch / ahead / behind 需要重新拉取。
- 目前 diff 预览按单文件前后对比渲染，后续如果要支持更复杂的多文件联动预览，还需要再拆一层状态。
- 打包版后端仍通过 `process.execPath + ELECTRON_RUN_AS_NODE` 拉起 `service.js`；后续如果 Electron 大版本改变这条能力，需要优先回头验证打包态启动链。
