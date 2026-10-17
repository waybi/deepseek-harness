---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-agent-instructions-change-content

[English](2026-10-16-agent-instructions-change-content.md) | 中文

## 概述

为 agent-instructions 的 source 变更记录新增可选字段 `content`，使后续指令更新能以统一差异（unified diff）的形式，对照模型上一次看到的全文呈现。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-agent-instructions-change-content
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "6f1681cc505a31a65eee03b27e7f94ae4ed76ce9b5ae4bca71fb57a75444b9dd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "9de52272faf27d4ead463e7867d3442d271a958e8d790edc6fbd13687574fefc"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "be033fe7b167b55adae7b0f299e30499bd4ca4b3e0284ef7e0cbda2459e8eb6b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "23267d5b549863ba75e8a4dd74a786eff57cd79eb0911be8371c56a5868e34ae"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

本次变化是在消息 source 上新增一个可选字段。不认识 `content` 的旧读者忽略该字段，继续呈现整份替换文本。当前读者把缺失、非字符串或与 digest 不符的 `content` 视为未知，改为呈现全文，因此旧会话可以安全恢复。该字段不会进入模型请求，只有消息的 `content` 块会发送。不需要提升 `SESSION_FORMAT_VERSION`。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/context/agent-instructions：全部测试通过，覆盖差异呈现、全文回退、恢复会话、预算截断的基线，以及 `content` 缺失、格式错误、与 digest 不符等情况。

<a id="dev-note"></a>
## 开发备注

无。
