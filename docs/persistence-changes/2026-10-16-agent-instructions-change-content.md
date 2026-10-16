---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-agent-instructions-change-content

English | [中文](2026-10-16-agent-instructions-change-content.zh.md)

## Summary

Adds an optional `content` field to agent-instructions source changes so a later instruction update can be rendered as a unified diff against the text the model last saw.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The transition is an optional-field addition on message sources. Readers that predate `content` ignore the unknown property and keep rendering full replacement text. Current readers treat an absent, non-string, or digest-mismatched `content` as unknown and render the full file, so older sessions resume safely. The field never reaches a model request; only message `content` blocks are sent. No `SESSION_FORMAT_VERSION` bump is needed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/agent-instructions: all tests passed, including diff, full-fallback, resume, truncated-baseline, and absent/malformed/inconsistent `content` cases.

<a id="dev-note"></a>
## Dev Note

None.
