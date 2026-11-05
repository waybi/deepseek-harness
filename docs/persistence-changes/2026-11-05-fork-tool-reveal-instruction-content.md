---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-fork-tool-reveal-instruction-content

English | [中文](2026-11-05-fork-tool-reveal-instruction-content.zh.md)

## Summary

Re-acknowledges the fork's agent-instructions `content` source field, the log-only tools/reveal event, and the optional pressureGate readings after the dsh-v0.2.2-rc.1 merge.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

This record re-acknowledges the fork-only transitions after merging upstream dsh-v0.2.2-rc.1, replacing the fork records 2026-10-16-agent-instructions-change-content and 2026-10-16-tool-reveal-pressure-gate, whose predecessors no longer form one chain with the upstream records. All changes stay in the same Session format version. The `content` property on agent-instructions message sources is optional: readers that predate it ignore it and keep rendering full replacement text, and current readers treat an absent, non-string, or digest-mismatched `content` as unknown and render the full file; it never reaches a model request. tools/reveal is a new required-on-read root that the tool registry appends when tool_search reveals deferred tools and folds into the revealed set, so compaction never drops a reveal; existing logs do not contain it. pressureGate is an optional diagnostic field on compaction/start written only for a landed pressure condensation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/agent-instructions packages/compaction packages/core/tools: all tests passed after the merge.

<a id="dev-note"></a>
## Dev Note

None.
