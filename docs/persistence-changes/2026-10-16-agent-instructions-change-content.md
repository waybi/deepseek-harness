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
## Compatibility

The transition is an optional-field addition on message sources. Readers that predate `content` ignore the unknown property and keep rendering full replacement text. Current readers treat an absent, non-string, or digest-mismatched `content` as unknown and render the full file, so older sessions resume safely. The field never reaches a model request; only message `content` blocks are sent. No `SESSION_FORMAT_VERSION` bump is needed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/agent-instructions: all tests passed, including diff, full-fallback, resume, truncated-baseline, and absent/malformed/inconsistent `content` cases.

<a id="dev-note"></a>
## Dev Note

None.
