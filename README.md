# Agent Framework (Node.js)

单入口工程化智能体框架，前后端同端口运行，前端填写模型配置，后端保存到 `config/config.json`。

## 关键能力

- 自动注册工具：后端扫描 `backend/src/services/tools/*.tool.js`
- 基础工具已内置：`read_file`（相对/绝对路径+行范围/全文）、`list_dir`（目录列表）、`run_terminal`（终端命令）、`apply_patch`（统一 diff 写入）
- 智能体类自实现：`ChatAgent` 负责对话循环、工具调用、重试机制
- 流式输出解析：SSE 推送 token/tool/retry/final 事件
- 自动拼接工具内容：流式阶段实时构建 mergedText
- 对话历史持久化：保存到根目录 `History/chat_history.sqlite`
- 会话历史检索：`session_search` 基于 SQLite FTS5 搜历史消息，再按会话级返回摘要，不把长原文直接塞回主模型
- 会话 fork 链路：只有 `fork` 会产生子会话；压缩不会新建子会话，而是原地改写当前会话
- 会话标题自动生成：基于首句额外请求模型 API 生成标题（非直接使用首句）
- 混合工具层：本地 tools 保留，MCP tools 通过 `config/mcp.json` 热加载接入
- Token 统计：每次模型调用的 prompt / completion / total token 都会落库，并在会话页透明显示
- 长期记忆图谱：独立 `memory.sqlite`，使用 topic -> content -> memory node 三层结构，加 node relation 边
- 前后端严格分模块：API 层、业务层、控制层分离
- 单端口启动：通过根目录 `service.js` 启动

## 目录说明

- `service.js`：单入口，构建前端并启动后端服务
- `config/config.json`：运行时配置持久化文件（由前端保存）
- `History/chat_history.sqlite`：对话历史 SQLite 文件
- `memory.sqlite`：长期记忆图谱 SQLite 文件
- `backend/src/services/agent/ChatAgent.js`：智能体核心
- `backend/src/services/tools/ToolRegistry.js`：工具自动注册与调用
- `backend/src/services/mcp/McpManager.js`：MCP server 管理与工具转发
- `backend/src/services/history/SqliteChatHistoryStore.js`：会话历史、fork lineage、FTS 检索
- `backend/src/services/tools/sessionSearch.tool.js`：历史会话搜索工具
- `backend/src/services/memory/SqliteLongTermMemoryStore.js`：长期记忆图谱存储
- `backend/src/controllers`：HTTP 控制器
- `backend/src/routes`：路由层
- `frontend/src/api`：前端 API 与 SSE 客户端
- `frontend/src/modules/config`：配置模块
- `frontend/src/modules/chat`：聊天与流式展示模块
- `frontend/src/modules/memory`：记忆图谱可视化与编辑模块

## 提示词文件

当前项目把提示词分成几类文件，按“全局 -> 工作区 -> 会话”逐层叠加：

- `./.yyz/AGENTS.md`：全局 AGENTS，默认规则和执行约束，不存在也不会影响运行
- `工作区/.yyz/AGENTS.md`：工作区级 AGENTS，覆盖当前工作区的具体规则，不存在也不会影响运行
- `工作区/.yyz/SOUL.md`：工作区级可选人格文件，用来描述语气、风格、身份，不存在也不会影响运行
- `./.yyz/rules.md`：审批规则文件，决定哪些工具/命令需要确认
- `./.yyz/skills/`：全局 skills 目录，承载当前项目可用的全局技能包
- `工作区/.yyz/skills/`：工作区 skills 目录，只对当前工作区生效的技能包

说明：

- `AGENTS.md` 负责“怎么做事”
- `SOUL.md` 负责“像谁、怎么说话”
- `rules.md` 负责“什么需要审批”
- `skills/` 负责“当前可用的能力包”，分全局和工作区两层

说明：

- `AGENTS.md` 和 `SOUL.md` 都是可选文件，存在则加载，不存在则跳过。

## 启动

1. 安装依赖
   - `npm install`
2. 启动服务（同端口）
   - `npm run start`
3. 打开页面
   - `http://localhost:3000`

## 配置流程

1. 在页面左侧填写 model/baseURL/apiKey
2. 点击保存
3. 后端自动写入 `config/config.json`

## 会话历史 / Fork / Session Search 逻辑

这部分不是“普通聊天记录列表”，而是一套带 lineage 的历史系统。核心数据在 `History/chat_history.sqlite`。

### 1. 会话模型

`conversations` 表除了标题、工作区、审批模式、token 使用量外，还额外保存：

- `parent_conversation_id`
  - 只有 `fork` 子会话才会有值
- `source`
  - 当前只使用 `chat` 和 `fork`
- `model`
  - 记录该会话最近一次主要运行使用的模型名

配套的 `conversation_messages` 表保存原始消息，`conversation_messages_fts` 是 FTS5 检索索引。

### 2. 只有 Fork 会产生子会话

当前项目明确规定：

- `fork` 会创建一个新会话，并把原会话 id 写入 `parent_conversation_id`
- 压缩不会创建子会话
- 压缩只会原地改写当前会话消息
- 当前没有 `tool source` 会话这一层语义

也就是说，子会话语义只用于“人工分叉一个新实验线”，不用在压缩或工具运行上。

### 3. Session Search 的实际执行链

`session_search` 的目标不是“把长历史原文塞回主模型”，而是“历史消息检索 + 会话摘要回放”。

执行流程：

1. 空 `query`
   - 直接返回最近会话列表
   - 不调用模型
   - 最近列表走 `listRecentConversationsRich()`，不是逐条 N+1 读取
2. 非空 `query`
   - 用 `searchConversationMessages()` 在 FTS5 上搜历史消息
   - 屏蔽压缩产物：
     - `meta.kind = "compression_summary"`
     - `meta.kind = "tool_event"`
   - 给每个命中附带前后 1 条消息上下文
   - 命中后按具体 `conversationId` 去重，不按家族强行压成 1 条
   - 拉回该会话完整 transcript
   - 用“短语命中 -> 多词近邻共现 -> 单词命中”的方式截取相关窗口
   - 再调用摘要模型生成回顾摘要
   - 如果摘要模型失败，则退回 raw preview

摘要模型配置优先级：

1. `compressionModel`
2. `compressionBaseURL`
3. `compressionApiKey`

缺失时允许回退到主模型配置。

### 4. 当前家族隔离规则

`session_search` 会排除“当前会话所在家族”的整条 lineage：

- 当前会话本身
- 祖先
- 后代
- 兄弟分支

但其他家族不做家族级压缩。

这意味着：

- 当前家族永远不会互相搜到
- 别的家族里，如果母会话和 fork 子会话后续内容已经分叉，它们可以同时被搜到

### 5. 删除母对话时的重挂规则

如果删除的是一个有直接子会话的母对话，不会简单断链。

实际规则是：

1. 从它的直接子会话里，选择与原母对话时间最接近的一个作为接班者
2. 接班者的：
   - `parent_conversation_id` 置空
   - `source` 改回 `chat`
3. 其他兄弟子会话重新挂到这个接班者下面

这样做是为了避免“会话还在，但 parent 指向已删除节点，最后搜索不到”的幽灵对话。

### 6. 前端上的 Fork 标识

前端 `Fork` 徽标不是按“历史出身”判断，而是按“当前是否还是子会话”判断：

- `parentConversationId` 非空：显示 `Fork`
- `parentConversationId` 为空：不显示 `Fork`

所以一个 fork 子会话如果因为母对话删除而升格成新的母对话，前端不会再继续把它显示成 `Fork`。

## 长期记忆图谱逻辑

长期记忆不是聊天历史的摘要表，而是一个独立的结构化图谱，数据库文件为根目录 `memory.sqlite`。

### 1. 三层结构

记忆图谱固定分三层：

1. `topic`
   - 主题层，例如“偏好 / 经历 / 性格”
2. `content`
   - 主题下的内容层，相当于一个较具体的分组
3. `memory node`
   - 真正可触发、可关联的长期记忆节点

另外还有第四类“边”：

- `memory_node_relations`
  - 只允许 node -> node 关系
  - 当前是无向 canonical pair 存储，不区分左右方向

### 2. 默认主题与存储模型

`SqliteLongTermMemoryStore` 初始化时会：

- 自动创建 `memory_topics`
- 自动创建 `memory_contents`
- 自动创建 `memory_nodes`
- 自动创建 `memory_node_relations`
- 自动补默认主题：
  - `偏好`
  - `经历`
  - `性格`

时间字段统一保存为公历字符串时间，不再混用时间戳。

为了 recall 优化，`memory_nodes` 现在直接升级为双关键词组结构：

- `specific_keywords_json`
- `general_keywords_json`

这是破坏性升级。

- 旧版单 `keywords_json` 的记忆节点不做兼容迁移
- 检测到旧节点结构时，会直接删除 `memory_nodes` 和 `memory_node_relations` 后重建
- topic 与 content 可继续保留，旧 node 需要按新结构重新录入

### 3. 为了 Recall 优化，记忆节点为什么不是一句超短文本

每个 memory node 不是只存一句话，而是五个字段：

- `name`
- `coreMemory`
- `explanation`
- `specificKeywords`
- `generalKeywords`

设计意图：

- `coreMemory` 保存稳定事实本体
- `explanation` 保存背景、边界、为什么重要
- `specificKeywords` 保存强命中的具体召回词
- `generalKeywords` 保存放宽表达面的泛化召回词

推荐写法：

- `specificKeywords`
  - 写项目名、模块名、产品名、接口名、报错词、功能名、专有表达
- `generalKeywords`
  - 写类别、主题、意图、抽象标签、场景词

示例：

```json
{
  "specificKeywords": ["session_search", "hermes", "FTS5"],
  "generalKeywords": ["会话检索", "历史搜索", "检索能力"]
}
```

所以它更像“结构化长期记忆单元”，不是聊天摘要，也不是 embedding chunk。

### 4. 去重与重复检测

记忆图谱不是无脑追加，创建时会做重复检测：

- topic 名称相似度检测
- content 名称相似度检测
- node 名称相似度检测
- node 整体指纹相似度检测

当前阈值是 `0.8`。

node 的重复判断不是只看 `name`，还会综合：

- `name`
- `coreMemory`
- `explanation`
- `specificKeywords`
- `generalKeywords`

目的是尽量防止把同一条长期记忆反复写成多个近义节点。

为了 recall 优化，重复检测里的关键词权重也分开处理：

- `specificKeywords` 权重更高
- `generalKeywords` 权重更低

这样能减少“泛化词很多但其实不是同一条记忆”的误判。

当前去重范围也不是完全一样的：

- `topic` 去重接近全局
- `content` 去重限制在同一个 `topic` 下
- `node` 去重现在已经改成全库扫描，不再只限当前 `content`

这样可以防止模型通过“先新建一个 content，再写一个重复 node”的方式绕过去重。

### 5. 关系边的语义

关系边只存在于记忆节点之间，不存在 topic -> content 这种“图边”。

`memory_link_nodes` 的语义是：

- 两个 node 如果存在稳定长期关系，可以建立一条 relation
- relation 会存：
  - `relation_type`
  - `reason`

存储时会把两个 node id 规范成 canonical pair，所以：

- `A -> B`
- `B -> A`

在数据库里是同一条边，不会重复建两次。

### 6. 为了 Recall 优化，Agent 怎么使用记忆图谱

聊天智能体不会直接改数据库，而是通过一组 memory tools：

- `memory_browse`
- `memory_find_candidates`
- `memory_retrieve`
- `memory_create_topic`
- `memory_create_content`
- `memory_create_node`
- `memory_update_topic`
- `memory_update_content`
- `memory_update_node`
- `memory_link_nodes`
- `memory_merge_nodes`
- `memory_delete`

其中：

- `memory_browse` 负责按层级浏览
- `memory_find_candidates` 负责在写入前查最相近的 topic/content/node 候选
- `memory_retrieve` 负责精确读取某个 topic/content/node 的说明
- `memory_merge_nodes` 用于把重复或高度重合的多个记忆节点合并成一个新节点

和 recall 直接相关的 tool 规范现在统一改成：

- `memory_find_candidates`
  - 在任何 create 前优先使用
  - 返回推荐动作：优先 update / merge / 复用现有 content 或 topic，最后才 create
- `memory_create_node`
  - 现在必须提供现有 `contentId`
  - 必须同时提供 `specificKeywords` 和 `generalKeywords`
  - 不再自动补建 topic/content
- `memory_create_content`
  - 现在必须提供现有 `topicId`
  - 不再自动补建 topic
- `memory_update_content`
  - 如果要移动内容块，只能提供现有 `topicId`
  - 不再通过 `topicName` 自动补建 topic
- `memory_update_node`
  - 可以分别更新 `specificKeywords` 与 `generalKeywords`
  - 如果要移动节点，只能提供现有 `contentId`
  - 不再通过 `contentName/topicName` 自动补建父级
- `memory_merge_nodes`
  - 合并后也必须重新给出两组关键词
  - 如果要落到别处，只能提供现有 `contentId`

tool 层的写法原则：

- create 之前先 `memory_find_candidates`
- 先复用已有 `topicId/contentId/memoryNodeId`
- 优先 `update` / `merge`，最后才 `create`
- `specificKeywords` 不要偷懒写成泛词堆
- `generalKeywords` 不要只写空泛废词
- 两组一起服务于 recall，不是为了展示好看

### 7. 为了 Recall 优化，运行时召回怎么做

当前 recall 不是 Hermes 那种“固定塞一坨长期记忆”，而是：

1. 每轮请求开始前，同步执行一次 recall 判定
2. 输入只取当前 user 消息，最多再带上一条最近 user 消息
3. 直接扫描底层 `memory_nodes`
4. 不走 topic -> content -> node 的层级递进
5. 不做异步，不做预取，不做下一轮 delayed injection
6. 命中后把结果包成 `<long-term-memory>...</long-term-memory>` 临时块
7. 只在模型 API message 副本里注入，不写回历史，不让前端直接看到

为了首轮就把速度做好，recall 从一开始就带加速结构：

- 预处理后的节点缓存
- store revision 驱动的索引失效
- 短语索引
- token 倒排索引

#### Recall 打分规则

双关键词组不是平权的：

- `specific exact`：`+10`
- `specific partial`：`+4`
- `general exact`：`+4`
- `general partial`：`+1`

字段支持分也不一样：

- `specific` 命中后，`name/coreMemory/explanation` 支持分更高
- `general` 命中后，支持分更低，只做辅助放宽

触发原则：

- 命中 1 个强具体词，通常就能进入候选
- 只命中泛化词时，必须命中更多、总分更高才允许 recall
- 最终按分数排序、去重，默认只取 `top 3`

这个设计的目标是：

- 具体词保证精度
- 泛化词补召回面
- 同时尽量控制误召回

### 8. Runtime Block 注入架构

除了 recall，这次还补了一层统一的 runtime block 注入架构。

它不是前端提示，不是 tool result hook，也不是会落库的系统消息，而是：

- 每次模型请求前临时生成
- 只注入 API message 副本
- 不写回历史
- 不进入审批快照
- 不让前端直接看到

这一层的公共抽象不再是 `hook`，而是 `runtime block`。

原因很简单：

- hook 只是 runtime block 的一种
- recall block 不是 hook
- 以后文件块、审批块、风险提示块也都不应该被硬塞成 hook

所以现在的结构是：

- `RuntimeScopeBuilder`
  - 负责准备 runtime scope
- `RuntimeBlockRegistry`
  - 负责自动加载 block provider
- `RuntimeBlockRuntime`
  - 负责统一收集、标准化、排序、去重、裁剪 runtime blocks
- `RuntimeInjectionComposer`
  - 负责最后把不同 channel 的 blocks 注入 API conversation 副本

#### 作用域怎么取

Runtime scope 不自己翻整段全历史，也不重复做压缩边界判断。

上游会先整理好一份 scope，当前实现是：

- 当前会发给模型的 `system messages`
- 最新 compression summary 之后的全部原始消息
- 不包含 compression summary 本身
- 当前 turn 的 runtime tool events
- 本轮 recall 结果
- 当前审批模式等 runtime 状态

这样做的原因是：

- 避免 runtime 层自己重复做历史裁剪逻辑
- 保证它和 compression 链使用同一套边界
- 让 runtime block 只关心“产出什么 block”，不关心“历史从哪截”

关键代码：

- `backend/src/services/context/ConversationCompressionService.js`
- `backend/src/services/runtime/RuntimeScopeBuilder.js`

#### Runtime Block 架构

当前代码分层如下：

- `backend/src/services/hooks/HookRegistry.js`
  - 自动扫描 `backend/src/services/hooks/definitions/*.hook.js`
- `backend/src/services/hooks/HookBlockBuilder.js`
  - 只负责把 hook 结果变成 hook block 的内部结构
- `backend/src/services/runtime/RuntimeBlockRegistry.js`
  - 自动扫描 `backend/src/services/runtime/providers/*.runtime-block.js`
- `backend/src/services/runtime/RuntimeBlockRuntime.js`
  - 统一收集所有 provider 的 runtime block
- `backend/src/services/runtime/RuntimeInjectionComposer.js`
  - 统一决定 system block 和 current_user block 怎么塞进 API 副本

也就是说：

- hook 现在只是一个 block provider 的上游输入
- recall 也是一个 block provider
- 两者最后都走同一套 runtime block 管线

#### 生命周期

每轮请求的大致流程是：

1. `chatController` 先组好本轮 system messages 和原始消息
2. `ChatAgent` 先解析本轮 recall 结果
3. `RuntimeScopeBuilder` 基于当前 conversation 和 raw messages 构建 scope
4. `RuntimeBlockRuntime` 调用所有 provider 收集 blocks
5. runtime 对 blocks 统一做标准化、排序、去重、裁剪
6. `RuntimeInjectionComposer` 把：
   - system channel blocks
   - current_user channel blocks
   注入到 API conversation 副本
7. 本轮如果还有 tool loop，继续复用同一轮的 runtime cache
8. 下一轮重新计算，不继承上一轮的 runtime blocks

所以它是：

- `同轮复用`
- `跨轮失效`
- `只存在于 runtime`

#### Runtime Block 的统一协议

每个 runtime block provider 至少导出：

- `name`
- `description`
- `priority`
- `resolve(scope, context)`

provider 返回的 block 最终会被标准化成统一结构，例如：

```js
{
  id: "runtime_block_xxx",
  type: "runtime_hooks",
  source: "hook" | "memory" | "files" | "runtime",
  channel: "system" | "current_user",
  level: "info" | "warning" | "strong",
  priority: 180,
  shouldInject: true,
  oncePerTurn: true,
  tags: ["runtime", "hooks"],
  metadata: {},
  content: "<runtime-hooks>...</runtime-hooks>"
}
```

这里最关键的是：

- block 不要求都长得像 hook
- block 可以直接返回 `content`
- 也可以通过自定义 `wrapper.open / wrapper.close` 和 `bodyLines` 生成内容

这就是“可自定义包围块”的抽象基础。

#### Runtime 最后怎么裁决

所有 provider 产出的 blocks 不会原样全塞进 prompt，而是要经过统一处理：

1. 过滤掉 `shouldInject === false`
2. 标准化字段
3. 按 `channel + type + content + tags` 去重
4. 按 `priority` 和 `level` 排序
5. 按 channel 分别裁剪

当前默认预算大致是：

- `system` channel：最多 `3` 个 blocks
- `current_user` channel：最多 `2` 个 blocks

其中：

- `runtime hooks` 走 `system` channel
- `long-term-memory recall` 走 `current_user` channel

#### Runtime 注入和 Hook 注入的关系

这层和已有的 tool result hook 不是一回事：

- `tool result hook`
  - 跟着单个工具结果走
  - 属于局部、事后提示
  - 更像“这个工具结果需要补充说明”
- `runtime block`
  - 跟着整轮请求走
  - 属于全局、请求前提示
  - 更像“这轮模型调用前，需要先统一知道哪些运行时规则和上下文块”

所以：

- tool result hook 适合描述某个工具结果
- runtime block 适合统一调度当前轮的行为边界和隐藏上下文

#### Hook 在新架构里的位置

hook 没被删除，而是变成了更干净的一层：

- hook 负责“提出建议”
- `HookBlockBuilder` 负责把这些建议组装成 hook block
- `hooks.runtime-block.js` 再把它作为一个普通 runtime block provider 接入总管线

也就是说：

- hook 不是总抽象
- hook 只是 runtime block 的一种来源

这比直接把 recall 也塞成 hook 更合理，因为：

- recall 是数据块，不是提示块
- hook 是控制面
- recall 是内容面

#### 当前内置的 Runtime Block Providers

当前已经接入两类 provider：

- `hooks.runtime-block.js`
  - 产出 `<runtime-hooks>...</runtime-hooks>`
  - channel 是 `system`
- `longTermMemoryRecall.runtime-block.js`
  - 产出 `<long-term-memory>...</long-term-memory>`
  - channel 是 `current_user`

这正好对应：

- 规则提示块
- 数据上下文块

#### 第一批内置 hook

第一批内置 hook 仍然保留，放在 `backend/src/services/hooks/definitions/` 下：

- `memory_write_opportunity`
  - 从当前消息里的稳定性信号判断这轮是否可能包含值得长期保存的信息
  - 主要看偏好、纠正、长期规则、稳定环境事实和近轮重复证据，不靠 `记住/别忘` 这种直白词当主逻辑
- `memory_write_workflow`
  - 在消息或 memory tool 触发下，提醒先 `memory_find_candidates`，优先 `update/merge`
- `recalled_memory_boundary`
  - 提醒 recalled memory 是隐藏上下文，不是新的用户输入
- `parsed_files_grounding`
  - 提醒上传文件解析结果是隐藏 supporting context，相关时要优先 grounding

因此现在 hook 的触发源既可以是：

- message
- tool
- memory recall
- 以后继续扩展的 runtime state

#### 当前已有的共享信号

记忆相关 hook 现在已经抽了一层共享信号分析：

- `backend/src/services/hooks/memoryWriteSignals.js`

这一层主要判断：

- 偏好信号
- 纠正信号
- 长期规则信号
- 稳定环境事实
- 近轮重复证据

同时也会压掉：

- `这次先`
- `临时`
- `跑一下`
- `调试`
- `这一轮`

这类明显偏短期任务态的信息。

所以现在“提醒写记忆”不再主要依赖 `记住/别忘` 这种显式词，而是优先看信息本身是否稳定、是否值得长期保存。

#### 怎么扩展新 block 和新 hook

如果后续要加新 runtime block，有两种扩展点：

1. 新 hook
   - 在 `backend/src/services/hooks/definitions/` 下新增 `xxx.hook.js`
   - 导出 `name / description / priority / evaluate()`
   - hook 只负责判断，不负责注入
2. 新 block provider
   - 在 `backend/src/services/runtime/providers/` 下新增 `xxx.runtime-block.js`
   - 导出 `name / description / priority / resolve()`
   - provider 可以直接返回 block content
   - 也可以返回带 wrapper 的 block 定义

也就是说：

- hook 自己负责“提出建议”
- block provider 负责“产出哪种注入块”
- runtime 负责“决定哪些 block 真正进 prompt”
- composer 负责“最后怎么塞进去”

### 9. HTTP API 与前端面板

前端 Memory 面板直接走独立 API，不复用聊天历史接口。

主要接口：

- `GET /memory/topics`
- `GET /memory/topics/:topicId`
- `POST /memory/topics`
- `PUT/PATCH /memory/topics/:topicId`
- `DELETE /memory/topics/:topicId`
- `GET /memory/contents/:contentId`
- `POST /memory/contents`
- `PUT/PATCH /memory/contents/:contentId`
- `DELETE /memory/contents/:contentId`
- `POST /memory/nodes`
- `PUT/PATCH /memory/nodes/:nodeId`
- `DELETE /memory/nodes/:nodeId`
- `POST /memory/node-relations`

前端展示方式也是按三层走：

- 左侧 topic 列表
- 中间 content 列表
- 右侧 memory node 详情、两组关键词和 related nodes

所以这套记忆图谱不是“后台黑盒”，而是用户能直接看到、改动和整理的结构化长期记忆系统。

### 10. 多智能体编排与调度器

这套多智能体现在已经不是“纯骨架”了，而是已经接上了主聊天链路的第一版可运行基础设施。

它的目标仍然不是 runtime 隐藏注入，而是：

- 用真正可见的结构化 `user` 消息承载调度通信
- 用独立 runtime 承载主智能体和子智能体
- 用持久化公共池和 queue 保证重启后还能恢复状态

#### 当前核心组件

- `backend/src/services/orchestration/OrchestratorSchedulerService.js`
  - queue core
  - atomic step
  - ready / consumed flush
  - pool broadcast
- `backend/src/services/orchestration/SqliteOrchestratorStore.js`
  - agent / pool / queue / delivery 持久化
- `backend/src/services/orchestration/OrchestratorSupervisorService.js`
  - 创建 / 删除 / 查看 / 调度子智能体
- `backend/src/services/orchestration/AgentWakeDispatcher.js`
  - idle 唤醒
  - 前台运行 / 后台运行状态接力
  - waiting approval 时保持 atomic step 不提前释放
- `backend/src/services/orchestration/ConversationAgentRuntimeService.js`
  - 按 `conversationId` 解析该走主 runtime 还是子 runtime
- `backend/src/services/subagents/SubagentDefinitionRegistry.js`
- `backend/src/services/subagents/AgentRuntimeFactory.js`

#### 主智能体和子智能体现在怎么跑

- 主智能体和子智能体都复用 `ChatAgent`
- 子智能体不再走一套单独实现，而是：
  - 自己的 scoped tool registry
  - 自己的 hook registry
  - 自己的 definition prompt
  - 共同复用 runtime blocks / recall / approval / stream 协议
- 前台用户直接进入子会话时，也会按 `conversationId` 选中对应子 runtime
- 工具审批恢复同样会按 `conversationId` 回到正确的 runtime，而不是一律回主智能体

#### 调度消息语义

调度器消息不是 runtime block，也不是隐藏 sidecar context。

它们会作为真正的聊天消息插入历史：

- `role = "user"`
- `meta.kind = "orchestrator_message"`
- `meta.subtype = ...`

这样前端可以明确区分：

- 普通用户输入
- 主子智能体 dispatch
- 子智能体上报
- 公共池轻量广播
- 公共池全量广播

其中子智能体“最终完成交接”已经单独抽离：

- `pool_report`
  - 只用于共享阶段性进度、阻塞和协作情报
  - 会进入公共池，其他子智能体可能看到
- `subagent_finish_report`
  - 只允许子智能体使用
  - 只会在“本回合是由主智能体调度触发”时，于当前回合结束后定向发给主智能体
  - 不进入公共池，不广播给兄弟子智能体
  - 如果没有显式调用该工具，但本回合正常结束且有最终 assistant 输出，会走同一条专属通道做兜底

#### queue 内核和消息语义仍然解耦

`OrchestratorSchedulerService` 现在只负责：

- session / agent
- public pool
- queue
- atomic step
- ready / consumed flush

真正插入什么消息对象，由下层决定：

- 直接传 `message`
- 或传 `messageFactory`
- 或继续使用默认的 `orchestratorMessageAdapter`

所以 scheduler core 不再内置“消息一定是 orchestrator kind”这层假设。

#### 原子步骤与等待审批

这层现在最重要的行为边界是：

- 正在 atomic step 内时，调度消息只入 queue，不插历史
- atomic step 完成后才 flush 到目标会话
- 如果 run 进入 `pending_approval`
  - 不提前 finish atomic step
  - 不提前释放 queue
  - 等确认恢复后再继续同一条调度链

这保证了：

- 不会因为审批暂停把“后来的消息”插进错误位置
- 不会为了吞吐把更重要的任务边界打乱

#### 公共池与持久化

公共池现在已经是真实持久化运行时，不是内存临时广播：

- `orchestrator_pool_entries`
- `orchestrator_pool_deliveries`
- `orchestrator_agent_queue`
- `orchestrator_agents`

这意味着：

- 服务重启后仍可恢复 agent 状态
- 子智能体删除后，其公共池历史仍保留
- 轻量广播和全量广播都有 delivery 记录

#### 子智能体 skills 约定

子智能体不会去读取自己目录下的 `skills/*.md` 全文直接塞进 system。

真正的 skill 体系统一仍然来自：

- 全局 `.yyz/skills/`
- 工作区 `.yyz/skills/`

skills 继续沿用当前会话的全局选择性注入：

- 主对话和子对话看到的是同一套已选 skills
- 工作区 skills 不区分主智能体 / 子智能体
- 子智能体 definition 不再单独声明 skills 选择

system 里只注入：

- skill name
- skill description
- skill index

如果需要完整技能内容，agent 必须主动调用：

- `skill_view`

子智能体 definition 当前只负责声明：

- 自己的 `prompt.md`
- `inheritedBaseToolNames`
- `inheritedBaseHookNames`
- 本地增量 `tools/`
- 本地增量 `hooks/`

#### 前端当前状态

前端第一版也已经接上：

- 历史列表区分主对话 / fork / subagent
- subagent 会话禁止 fork
- 子对话 developer prompt 前端只读
- 流式生成期间允许切换查看别的对话
- SSE 增量会继续按原 `conversationId` 写入本地缓存，不会因为你切换视图就丢

当前仍未完成的主要是：

- 主界面直接展示完整子智能体管理面板
- orchestration 消息的专门视觉样式
- 主对子对话更强的图形化关系导航

## MCP 教程

这套项目支持本地 tools + MCP tools 的混合架构。默认本地工具继续由 `backend/src/services/tools` 管理，MCP 工具通过 `config/mcp.json` 额外加载。

当前 MCP 支持两种传输：

- `stdio`：本地进程，通过 `command + args + cwd + env` 启动
- `http`：远程 MCP endpoint，通过 `url + httpHeaders` 连接

### 1. MCP 配置文件位置

- `config/mcp.json`

保存后会被后端热加载，不需要重启服务。

### 2. 配置格式

`config/mcp.json` 的顶层结构是：

```json
{
  "servers": []
}
```

每个 `server` 支持这些字段：

- `name`：服务器名称，前端和日志里显示用
- `transport`：传输方式，`stdio` 或 `http`，默认 `stdio`
- `command`：启动 MCP server 的命令
- `args`：命令参数数组
- `cwd`：启动目录，通常放 MCP server 项目根目录
- `env`：环境变量对象，API key / token / secret 都放这里
- `url`：`http` 传输时的远程 MCP 地址
- `httpHeaders`：`http` 传输时附加的请求头，认证信息一般放这里
- `enabled`：是否启用，默认 `true`
- `startupTimeoutMs`：启动超时，默认 `10000`
- `requestTimeoutMs`：请求超时，默认 `30000`

### 3. 最小示例

如果你的 MCP server 是一个 Node.js 进程，配置可以写成这样：

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "cwd": "D:\\mcp\\filesystem-server",
      "env": {},
      "enabled": true
    }
  ]
}
```

保存后，后端会自动启动这个 server，并读取它暴露出来的 tools。

### 4. 带密钥的 stdio 示例

如果 MCP server 需要 API key、token、secret，统一放到 `env` 里：

```json
{
  "servers": [
    {
      "name": "knowledge-base",
      "command": "node",
      "args": ["index.js"],
      "cwd": "D:\\mcp\\kb-server",
      "env": {
        "OPENAI_API_KEY": "sk-xxxx",
        "MY_SERVICE_TOKEN": "abc123",
        "MCP_REGION": "ap-southeast-1"
      },
      "enabled": true,
      "startupTimeoutMs": 15000,
      "requestTimeoutMs": 30000
    }
  ]
}
```

建议：

- 密钥放 `env`
- 不要把密钥写进 `args`
- 如果你的 MCP server 本身支持 `.env`，也可以让它自己读取，但这层配置仍建议显式写在 `env`

### 5. 远程 HTTP 示例

如果你要接远程 MCP endpoint，比如 Stitch，这样填：

```json
{
  "servers": [
    {
      "name": "stitch",
      "transport": "http",
      "url": "https://stitch.googleapis.com/mcp",
      "httpHeaders": {
        "X-Goog-Api-Key": "你的 API key"
      },
      "enabled": true,
      "requestTimeoutMs": 30000
    }
  ]
}
```

注意：

- `httpHeaders` 里的 key/value 会直接作为请求头发送
- 认证 key 这种敏感信息不要提交到公开仓库
- 如果服务端需要额外 header，继续往 `httpHeaders` 里加

### 6. 前端怎么改

前端配置中心已经加了 MCP 区块：

- 左侧进入「配置中心」
- 在 `MCP 配置` 区域直接编辑 JSON
- 点击保存后，后端会立刻热加载
- 加载成功后，MCP 工具会和本地工具一起出现在模型可用工具列表里

### 7. 后端接口

- `GET /api/mcp-config`：读取当前 MCP 配置和加载状态
- `POST /api/mcp-config`：保存 MCP 配置并热加载

### 8. 工具命名

为了避免和本地 tools 冲突，MCP 工具会被自动加前缀，格式是：

```text
mcp__<serverName>__<toolName>
```

例如：

```text
mcp__filesystem__read_file
```

### 9. 常见问题

- 如果保存后没有生效，先看 `config/mcp.json` 是否是合法 JSON
- 如果某个 server 启动失败，前端会显示加载状态和失败数量
- 如果工具名冲突，MCP 工具仍会带 `mcp__...` 前缀，不会覆盖本地工具
- 如果某个 MCP server 依赖环境变量，优先检查 `env` 是否写对
- 如果远程 HTTP server 连不上，先检查 `url`、`httpHeaders`、网络和认证 key 是否正确

## 接口

- `GET /health`
- `GET /api/config`
- `POST /api/config`
- `GET /api/chat/histories`
- `GET /api/chat/histories/:conversationId`
- `POST /api/chat/histories/:conversationId/fork`
- `PUT /api/chat/histories/:conversationId`
- `DELETE /api/chat/histories/:conversationId`
- `POST /api/chat/stream` (SSE)
- `GET /api/memory/topics`
- `GET /api/memory/topics/:topicId`
- `POST /api/memory/topics`
- `PUT/PATCH /api/memory/topics/:topicId`
- `DELETE /api/memory/topics/:topicId`
- `GET /api/memory/contents/:contentId`
- `POST /api/memory/contents`
- `PUT/PATCH /api/memory/contents/:contentId`
- `DELETE /api/memory/contents/:contentId`
- `POST /api/memory/nodes`
- `PUT/PATCH /api/memory/nodes/:nodeId`
- `DELETE /api/memory/nodes/:nodeId`
- `POST /api/memory/node-relations`

## 说明

- 当前默认不填任何配置，`config/config.json` 初始为 `{}`。
- 未保存有效配置前，聊天接口会返回配置校验错误。
- `config/mcp.json` 默认初始为 `{"servers":[]}`，但也可以手动删除并由后端重新创建。
