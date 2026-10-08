---
description: "Turn-age expiry of cold tool output for deployments that pay per input token: choosing how many turns a result stays verbatim, or debugging why an older tool result became a one-line stub."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-tool-result-expiry

English | [中文](README.zh.md)

## Summary

`dsh-compaction-tool-result-expiry` lowers the per-request input bill of long tool-heavy sessions. Before each model request it replaces every tool result produced `coldTurns` or more turns ago, whose text exceeds `thresholdChars`, with a one-line stub naming the tool and the removed size. The current turn and the most recent turns keep their results verbatim. The complete original stays in the session log for exact replay. Expiry makes no model call and runs regardless of token pressure: it addresses the cost of resending old output every request, while `dsh-compaction-basic` owns context-window overflow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when sessions run many tool calls per turn and each request resends the whole history. It changes what the model sees — older tool output becomes a stub — and keeps every request's leading messages identical, so provider prefix caches continue to match up to the first stubbed result.

### Smallest working composition

Mount token measurement, then this package:

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-expiry'
```

With these rows, cold oversized tool results are stubbed automatically before each request. You can verify success by comparing two consecutive requests after the cold boundary: the earlier tool result appears as a stub while the full original remains in the session log. `dsh-compaction-basic` is not required; when it is mounted, expiry lands first on each step so a relieved surface may skip summarization.

### What expires

A tool result expires when both hold: the turn that produced it is `coldTurns` or more turns before the turn being prepared, and its text exceeds `thresholdChars` Unicode code points. The replacement keeps the tool call, step, errors, metadata, and every non-text block (images and structured blocks) in order; all text blocks collapse into one stub:

```text
[<tool name> output from an earlier turn expired: <N> characters removed; rerun the tool to see it again]
```

The tool name comes from the assistant message that issued the call; a result whose call is not named on the surface reads `tool`. A result that is already a stub, or whose text is not longer than its stub would be, is left alone. If a replacement cannot be recorded, the request proceeds with the surface as it stands and a warning is logged; replacements already applied stay in place.

### Setting the policy

All settings are optional. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-tool-result-expiry) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `coldTurns` | `3` | A result is cold once this many turns have started after the turn that produced it. The current turn and the previous `coldTurns - 1` turns stay verbatim. |
| `thresholdChars` | `2048` | Expire only results whose text exceeds this many Unicode code points. |
| `sweepEvery` | `30` | After a pass lands at least one replacement, hold further passes for this many turns so the provider prefix cache stays stable in between. `1` sweeps every turn. |
| `idleSweepMs` | `3600000` | A pass may also land once the session has idled at least this long since its previous request, when the cached prefix has most likely expired anyway. |

An unknown setting rejects the plugin at construction. Lower `coldTurns` to shed output sooner in sessions where the model rarely rereads old results; raise `thresholdChars` to keep small results (file listings, short command output) verbatim indefinitely.

### When expiry runs

Expiry runs on every `agent/pre-step`, before `dsh-compaction-basic` measures pressure. A turn with several tool round-trips evaluates once per request; results from the same turn are never cold for that turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind expiry; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Age, not pressure, is the trigger.** Per-request input cost accrues on every request whether or not the window is near its limit. Waiting for pressure, as `dsh-compaction-tool-result-pruner` does, leaves old output in every intermediate request.
- **Prefix stability over maximal savings.** Only tool results are rewritten, and only those older than the cold boundary. The system prompt, tool schemas, user messages, and assistant messages are never touched, so a provider prefix cache keeps matching up to the first stubbed node.
- **Replay-safe replacement.** The original event remains in the append-only log; the stub cites it through `sourceEventSeqs`, so replay recovers the exact input.
- **The shadow-price protocol.** `compaction/prune` immediately precedes its replacement, pricing the exact replaced node through the injected token meter — the shared protocol documented on the `compaction/prune` event.

### Expiry mechanics

`expireSession` walks the current surface once, collecting tool names from assistant `tool-call` blocks and cold `tool/result` nodes. Each cold result whose text exceeds the threshold is derived through the session's logged message projections, collapsed into one stub plus its non-text blocks, and appended as a content-only `tool/result` replacement preceded by `compaction/prune`. The pre-step listener is prepended so it runs before `dsh-compaction-basic`; a failure inside it is logged and the step continues. Exact signatures are in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ToolResultExpiry` service, `expireSession` / `expireContent` / `isCold` / `measureContent`, the `agent/pre-step` listener |
| [`src/config.ts`](src/config.ts) | `expiredStub`, defaults, code-point counting, policy validation |
| [`src/types.ts`](src/types.ts) | `ToolResultExpiryConfig`, `ResolvedConfig`, `ExpiredEntry`, `ExpiryResult` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool-result pruner](../compaction-tool-result-pruner/README.md) — the pressure-triggered sibling that keeps a head and tail instead of a stub.
- [Compaction basic backend](../compaction-basic/README.md) — the summarizing backend that owns window overflow.
- [Compaction seam](../compaction/README.md) — the `compaction/prune` shadow-price event this package emits.
- [Token meter](../../llm/token-meter/README.md) — the measurement service that prices each shadowed node.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-tool-result-expiry) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Expired tool result

#### What the model sees

From the first sweep of a turn `coldTurns` or more after a result's turn, that result appears as `[<tool> output from an earlier turn expired: <N> characters removed; rerun the tool to see it again]` in place of its text. Non-text blocks keep their order. Results from the current and recent turns are verbatim.

When the original text ends with a spill-policy notice (`(Omitted … Full formatted result stored at: <path>. …)`), the stub instead reads `[<tool> output from an earlier turn expired: <N> characters removed; the complete result is still stored at the path below, read that file instead of rerunning the tool]` and the notice follows it verbatim, so the stored path survives expiry.

#### Token effect

Each expired result costs one stub line instead of its original text on every later request. Expiry makes no model call. The model may spend a tool call to re-read output it still needs.

#### KV Cache effect

Every landed replacement invalidates provider prefix reuse from that node onward for one request; every request after that shares the new prefix. Nodes before the first stub are never rewritten, so the system prompt, tool schemas, and recent history keep matching. Replacements are batched: after a pass lands, the next pass waits `sweepEvery` turns or an idle gap of `idleSweepMs`, and `dsh-compaction-basic` lands any pending replacements inside its own condensation pass, where the prefix is already lost.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Age is measured in turns, not tokens or time** — a long single turn with many tool round-trips keeps all of its results verbatim until the next turn starts.
- **Character thresholds are not token thresholds** — provider token density varies; `thresholdChars` only approximates the saving.
- **The stub is the only recovery hint unless the result was spilled** — without a retained spill-policy notice the model must rerun the tool; no retrieval tool for the expired text ships.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Retrieval tool, deferred** — a `read_expired_output` tool reading the shadowed event back from the log would let the model recover without rerunning side-effecting commands; it needs a tool package and a spill-style size cap.
- **Per-tool policies, undecided** — read-only tools (file reads, searches) are cheap to rerun while command output may not be; a per-tool `coldTurns` override has no current consumer evidence.

</details>
