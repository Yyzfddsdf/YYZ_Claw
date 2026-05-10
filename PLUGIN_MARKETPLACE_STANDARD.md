# Plugin Marketplace Standard

## 目标
- 定义我们自己的插件市场怎么做
- 对齐 Claude Code 的 marketplace 思路
- 把“市场目录”和“插件包”分开
- 支持安装、更新、卸载、缓存和作用域管理

## 核心结论
- 插件市场不是插件本体
- 市场是**插件目录索引**
- 插件是**真正的功能包**
- 用户先添加 marketplace，再从 marketplace 安装 plugin
- marketplace 和 plugin 分层管理

## 1. 结构分层

### 1.1 Marketplace
- Marketplace 是一个 catalog
- 它负责列出可安装的插件
- 它不直接承载插件实现
- 它只描述：
  - 插件名
  - 版本
  - 描述
  - 来源
  - 安装入口
  - 更新入口

### 1.2 Plugin
- Plugin 是实际安装的功能包
- plugin 里包含：
  - `skills/`
  - `agents/`
  - `hooks/`
  - `mcpServers`
  - `app/`
  - 其他插件组件

## 2. Marketplace 来源
- GitHub 仓库
- Git URL
- 本地路径
- 远程 URL

## 3. Marketplace 清单文件

### 3.1 文件位置
- 推荐文件名：`.claude-plugin/marketplace.json`
- 也可以由我们的系统做兼容入口，但核心标准先以 marketplace catalog 为准

### 3.2 顶层结构
```json
{
  "name": "claude-plugins-official",
  "displayName": "Official Marketplace",
  "description": "Official plugin catalog",
  "plugins": [
    {
      "name": "github",
      "version": "1.0.0",
      "description": "GitHub integration",
      "repository": "anthropics/claude-plugins",
      "entry": "github@claude-plugins-official"
    }
  ]
}
```

### 3.3 字段含义
- `name`：marketplace 名称
- `displayName`：展示名
- `description`：市场说明
- `plugins`：可安装插件列表

### 3.4 plugin 条目字段
- `name`：插件名
- `version`：版本号
- `description`：插件说明
- `repository`：来源仓库
- `entry`：安装入口标识
- `homepage`：插件主页
- `author`：作者信息

## 4. 安装模型

### 4.1 安装前
- 用户先添加 marketplace
- 宿主拉取 marketplace catalog
- 用户在 catalog 中选择 plugin

### 4.2 安装时
- 宿主把 plugin 复制到本地缓存或安装目录
- 宿主记录安装来源、版本、scope
- 宿主校验 plugin manifest

### 4.3 安装后
- 插件进入可用列表
- 用户可启用、停用、卸载
- 变更后需要 reload 生效

## 5. 安装作用域
- `user`：用户级，跨项目可用
- `project`：项目级，仓库内协作可见
- `local`：本地级，仅当前环境可见

## 6. 更新模型
- marketplace 可更新
- plugin 可更新
- 自动更新只针对已安装插件
- 更新前要保留旧版本缓存一段时间，避免并发会话中断

## 7. 缓存模型
- marketplace 数据应缓存到本地
- plugin 包应缓存到本地
- 已安装版本和新版本要隔离
- 卸载或更新后的旧包可延迟清理

## 8. 加载模型
- plugin 加载时，宿主读取 manifest
- 宿主发现组件：
  - `skills`
  - `agents`
  - `hooks`
  - `mcpServers`
  - `app/`
- marketplace 只负责提供来源，不直接参与运行

## 9. 错误模型
- marketplace 拉取失败要可见
- plugin 安装失败要可见
- plugin 依赖缺失要可见
- hook / MCP / agent 子组件加载失败要独立报错

## 10. 与插件系统的关系
- marketplace 是插件系统的分发层
- plugin 是内容层
- 宿主负责安装、缓存、启用、卸载、更新
- marketplace 不应该混进 plugin 内部执行逻辑

## 11. 与全局配置的关系
- marketplace 配置可以放在全局 settings
- project 也可以声明可用 marketplace
- 加载时优先处理显式信任的 marketplace

## 12. 安全约束
- 安装前必须显示来源
- 安装前必须显示插件名和版本
- 远程 marketplace 必须可验证来源
- 不允许无提示自动安装未知插件
- 插件能带来的 MCP / hooks / agents 都属于高风险内容，必须按插件整体信任处理

## 13. 目录建议
```text
marketplaces/
  official/
    marketplace.json
  team-tools/
    marketplace.json
```

## 14. 当前实现边界
- 我们现在已经有 plugin 的基础发现和部分加载
- marketplace 还没有完整实现
- 这份文件定义的是后续要做的市场标准

## 15. 后续实现要求
- marketplace 和 plugin 必须分层
- 不要把 marketplace 当 plugin
- 不要把 plugin 当 marketplace
- 安装、更新、卸载、缓存、作用域必须独立建模
- 如果以后要细化市场 JSON 协议，先更新本文件
