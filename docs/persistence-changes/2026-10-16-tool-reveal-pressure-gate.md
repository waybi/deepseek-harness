---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-tool-reveal-pressure-gate

English | [中文](2026-10-16-tool-reveal-pressure-gate.zh.md)

## Summary

Adds the log-only tools/reveal event and the optional pressureGate readings on compaction/start.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both changes stay in the same Session format version. Existing logs contain neither tools/reveal nor pressureGate and stay valid. tools/reveal is a new required-on-read root: readers that predate it refuse a log carrying it, as every required-on-read event does; the tool registry appends it when tool_search reveals deferred tools and folds every such event into the revealed set, so compaction never drops a reveal. pressureGate is an optional diagnostic field on compaction/start that compaction-basic writes only for a landed pressure condensation; readers that omit it still interpret the event, and its absence means no pressure-gate readings were recorded.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/compaction/compaction-basic/tests/compaction-basic.spec.ts packages/core/tools/tests/deferred-exposure.spec.ts: 2 files, 138 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
