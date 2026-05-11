# Command

## 是什么
- `command` 是一种 **`/` 快捷指令**
- 用户输入：
  - `/review`
- 宿主识别后，把它替换成该 command 定义的详细提示词
- 替换后的内容按普通消息发送给模型

## 核心规则
- `name`
  - 就是指令名本体
  - 不带 `/`
  - 例如：
    - `name: review`
    - 输入时对应 `/review`

- `description`
  - 就是展开后的真实提示词
  - 不再额外区分“简介”和“正文”
  - 宿主直接把它当成最终展开内容

一句话：
- **`name` = `xxx`，不带 `/`**
- **`description` = 展开后的 prompt**

## 放哪里
插件里的 command 放在：

```text
commands/
```

推荐一条 command 一个文件：

```text
commands/
  review.md
  summarize.md
```

## 文件格式
使用 Markdown frontmatter。

示例：

```md
---
name: review
description: |
  你现在要进行代码审查。

  审查目标：
  - 找 bug
  - 找风险
  - 找回归
  - 找缺失测试

  输出要求：
  - 先列问题
  - 再给修改建议
  - 最后给简短总结
---
```

当前最小格式只看这两个字段：
- `name`
- `description`

## 运行时行为
当用户输入：

```text
/review
```

宿主应当：

1. 找到 `name = review` 的 command
2. 读取它的 `description`
3. 用 `description` 完整替换 `/review`
4. 把替换后的真实提示词按普通消息发送给模型

## 不是什么
- 不是 `hook`
  - `hook` 是生命周期事件触发
  - `command` 是用户手动输入 `/xxx`

- 不是 `agent`
  - `agent` 是执行体
  - `command` 只是 prompt 展开入口

- 不是 `MCP`
  - `MCP` 是工具
  - `command` 是提示词

- 不是 `skill`
  - `skill` 是能力说明和方法说明
  - `command` 是快捷输入入口

## 当前决定但暂未实现的行为
以下行为已经定口径，但这一步**先不做实现**：

- 输入框里依然支持 `/xxx` 自动提示
- 额外增加 command 提示项
- 选中 `/command` 后自动补一个空格
- 用户提交后，把 `/xxx` 替换成真实提示词
- 如果一条消息里不只是单独输入 `/xxx`，而是还夹带了其他文字，只要其中出现了已识别的 command，也同样做替换
- 例如：
  - `请按这个要求执行：/review`
  - `/review 重点看安全问题`
  - `先参考 /review 再继续`
  这些都不保留原始 `/review`，而是替换成对应 command 的真实提示词
- remote 端发来的消息进入系统时，也做同样的 command 替换
- 最终不会把 `/name` 原样留在模型上下文里

## 当前状态
- 文档标准已经定好
- 运行时替换规则已经定好
- 输入框提示和 remote 替换逻辑后续再做
