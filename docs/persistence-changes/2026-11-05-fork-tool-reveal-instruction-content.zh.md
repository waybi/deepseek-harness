---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-fork-tool-reveal-instruction-content

[English](2026-11-05-fork-tool-reveal-instruction-content.md) | 中文

## 概述

在合并 dsh-v0.2.2-rc.1 后重新确认 fork 的 agent-instructions `content` source 字段、仅写日志的 tools/reveal 事件和可选的 pressureGate 读数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-fork-tool-reveal-instruction-content
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "05e81a5d7c84406c765d863c579db992c774e53d5678673687cc8913cb9fcdf4"
    decision: same-version
  - root: "event:compaction/start"
    previous: "2026-09-11-initial"
    after: "03f828a8bd704f93d79fb62889c2854940522762a61a4b1f05a88755df3d5e2f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d2eda505a1441c0284cc1b2311e4dce95bcd3b91355520568a14bf8c67001908"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a9e9c00a231af8e597dde79a881ffeb5670dcbcb3893814743c18d54321842dd"
    decision: same-version
  - root: "event:tools/reveal"
    previous: null
    after: "7f8f9df3947c286eb63d943fdb341b8d615fa862fdb23b15e659398a02662dc3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "921e70915c2ded2d65e48d7919e9b2c39e2f5055f6daff5f1e093fbe62aa4a2f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

本记录在合并上游 dsh-v0.2.2-rc.1 后重新确认 fork 独有的类型变化，取代 fork 记录 2026-10-16-agent-instructions-change-content 与 2026-10-16-tool-reveal-pressure-gate；它们的前驱与上游记录不再构成一条链。所有变化保持同一 Session 格式版本。agent-instructions 消息 source 上的 `content` 是可选字段：不认识它的旧读者忽略该字段并继续呈现整份替换文本，当前读者把缺失、非字符串或与 digest 不符的 `content` 视为未知并呈现全文；它不会进入模型请求。tools/reveal 是新的读取必需根，工具注册表在 tool_search 揭示延迟工具时追加它并折叠进已揭示集合，因此压缩不会丢失揭示记录；已有日志不含该事件。pressureGate 是 compaction/start 上的可选诊断字段，仅在压力压缩实际落地时写入。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/context/agent-instructions packages/compaction packages/core/tools：合并后全部测试通过。

<a id="dev-note"></a>
## 开发备注

无。
