# Plugin Command Standard

## 定义
- `command` 是一种 **`/` 快捷指令**
- 用户输入：
  - `/review`
- 宿主自动把它替换成该 command 定义的详细提示词
- 替换后按普通消息发送给模型

## 最终规则
- `name`
  - 就是指令名本体
  - 不带 `/`
  - 例如：
    - `name: review`
    - 输入时对应 `/review`

- `description`
  - 就是展开后的详细提示词
  - 宿主识别到 `/review` 后，直接把 `description` 替换进输入内容

## 文件格式
- 一个 command 一个 Markdown 文件
- 放在：
  - `commands/`

示例：
```text
commands/
  review.md
```

文件内容：
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

## 宿主行为
- 用户输入 `/review`
- 宿主找到 `name = review` 的 command
- 读取 `description`
- 用 `description` 的内容替换 `/review`
- 然后按普通消息发给模型

## 它不负责什么
- 不自动触发
- 不直接执行工具
- 不负责生命周期事件
- 不等于 `hook`
- 不等于 `agent`
- 不等于 `MCP`

## 一句话标准
- **`name` = 指令名，不带 `/`**
- **`description` = 展开后的详细提示词**
- **没了**
