---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-tool-reveal-pressure-gate

[English](2026-10-16-tool-reveal-pressure-gate.md) | 中文

## 概述

新增仅写入日志的 tools/reveal 事件，并在 compaction/start 上新增可选的 pressureGate 读数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-tool-reveal-pressure-gate
baseline: false
changes:
  - root: "event:compaction/start"
    previous: "2026-09-11-initial"
    after: "03f828a8bd704f93d79fb62889c2854940522762a61a4b1f05a88755df3d5e2f"
    decision: same-version
  - root: "event:tools/reveal"
    previous: null
    after: "7f8f9df3947c286eb63d943fdb341b8d615fa862fdb23b15e659398a02662dc3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两项变更都保持同一 Session 格式版本。已有日志既不含 tools/reveal 也不含 pressureGate，仍然有效。tools/reveal 是新的读取必需根：早于它的读取方会拒绝含该事件的日志，与所有读取必需事件一致；工具注册表在 tool_search 揭示延迟工具时追加该事件，并把所有此类事件折叠进已揭示集合，因此压缩不会丢失揭示记录。pressureGate 是 compaction/start 上的可选诊断字段，compaction-basic 仅在压力压缩实际落地时写入；不读取该字段的读取方仍能解释该事件，缺失表示未记录压力门读数。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/compaction/compaction-basic/tests/compaction-basic.spec.ts packages/core/tools/tests/deferred-exposure.spec.ts：2 个文件、138 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
