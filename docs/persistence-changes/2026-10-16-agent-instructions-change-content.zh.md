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
    previous: "2026-10-05-working-directory-attribution"
    after: "243f35de57d7d099de733ccda54a30191927287c4e5f55f11502fd6c82cce64f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "30d01cf8c827013e15dbfb12582aa4bf5677149240823a8486843975f4d7b1b7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "515cb51ffaaa7ffcf8cad2ee9b12ce4e4669472b3728da5a832c7bf536edd8f7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "5009cf4b46e10aad5fc4889a0580e6a526373c66a454f720b435d8328b115910"
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
