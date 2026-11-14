---
description: "Round-age image hydration for long image-heavy sessions: which images a request resends, what a replaced image looks like to the model, and how to keep more or fewer rounds of image bytes."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-rehydrate

English | [中文](README.zh.md)

## Summary

`dsh-compaction-image-rehydrate` resends only the most recent rounds' images. Before each model request it replaces every image produced `retainRounds` or more turns ago with one text placeholder naming the image, its encoded size, and the read-only stored copy the model can still read with its file tools. The current turn and the most recent turns keep their images verbatim. The durable `user/message` and `tool/result` events keep every original image, so replay recovers the exact conversation. Hydration makes no model call and runs regardless of token pressure: it addresses the per-request bill of resending image bytes, while [`dsh-compaction-image-offload`](../compaction-image-offload/README.md) owns a route's image budget and `dsh-compaction-basic` owns window overflow.

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

Mount this package in every composition that runs image-capable sessions. The shipped `dsh` base does. It needs an attachment store and a filesystem provider to name a readable stored copy; without them the images stay in the request and a warning records why.

### Smallest working composition

Mount the attachment store, a filesystem provider, and this package:

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-compaction-image-rehydrate'
  config:
    retainRounds: 2
```

With these rows, an image from three turns ago is a placeholder in the next request while the image attached in the previous turn still travels as image bytes.

### What gets replaced

An image is replaced when the turn that produced its message is `retainRounds` or more turns before the turn being prepared. Replacements happen per message, not per turn: the message keeps its text, its non-image blocks, and its identity, and each selected image becomes one text block at its original position:

```text
[Image from <name> (<media type>, <bytes> bytes) - stored at: <read-only path>]
```

The path is the normalized attachment's stored copy, mapped into the current tool execution world, so the model can read the image again with its own file tools. Occurrences that are already offloaded by `dsh-compaction-image-offload`, and occurrences whose stored copy has no readable path in this composition, keep their images; a warning reports the latter once per pass.

### Setting the policy

All settings are optional. The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `retainRounds` | `2` | An image is replaced once this many turns have started after the turn that produced it. The current turn and the previous `retainRounds - 1` turns keep their images. Must be at least `1`. |
| `enabled` | `true` | Set `false` to leave every image in place; the plugin then records no decision. |

An unknown setting, or a `retainRounds` below `1`, rejects the plugin at construction. Raise `retainRounds` for conversations that compare several past screenshots against each other; lower it to `1` when only the newest image matters.

### When hydration runs

Hydration runs on every `agent/pre-step`, before compacting listeners measure pressure. A turn with several tool round-trips evaluates once per request; images from the turn being prepared are never older than the current turn, so they always stay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind hydration; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Round age, not provider pressure, is the trigger.** An image costs its request bytes on every later request whether or not the route is anywhere near its budget. Waiting for `IMAGE_OFFLOAD_REQUIRED`, as the offload plugin does, leaves every intermediate request paying for images the model has already read.
- **The request face changes; the log does not.** The plugin appends one durable `image/rehydrate` decision and a registered message projection rewrites the model-visible messages. The `user/message` and `tool/result` events keep their image blocks, so transcripts, replay, and a later read of the image are unaffected.
- **A stored copy is the recovery path.** A placeholder without a readable path would leave the model unable to see the image again, so an unresolvable path keeps the image in the request instead.
- **The passive policy keeps its own decisions.** Hydration never rewrites an occurrence an offload decision already omitted, and it never touches a message whose images the offload recovery may still need.

### Hydration mechanics

A pre-step pass reads the host-only `imageSurface` projection, which indexes every current `user/message` and `tool/result` node with the turn that produced it; the fold follows `turn/start` for user messages and the `tool/result` payload for tool results, and drops the nodes a surface replacement shadows. The pass takes `session.deriveMessages()` — the messages as every earlier message projection leaves them — and, for each node older than `retainRounds`, collects the non-offloaded image occurrences with their depth-first indexes and resolved read-only paths. When it collected at least one, it appends one `image/rehydrate` event naming the exact occurrences, and the registered projection replaces those occurrences with text placeholders. Append-time validation rejects a decision that names a node off the current surface, a non-image occurrence, an index that is not strictly increasing, an already offloaded occurrence, or an empty path, so a malformed decision cannot enter the log. The pre-step listener is prepended; a failure inside it is logged and the step continues. Exact signatures are in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ImageRehydrate` service, `rehydrateSession` / `isOld` / `imagePath`, the `agent/pre-step` listener |
| [`src/config.ts`](src/config.ts) | Placeholder text, defaults, policy validation |
| [`src/projection.ts`](src/projection.ts) | Host-only `imageSurface` index and the `image/rehydrate` request-face projection |
| [`src/types.ts`](src/types.ts) | `ImageRehydrateConfig`, `ResolvedConfig`, `RehydratedImage`, `RehydrateResult`, the `image/rehydrate` event declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Image offload](../compaction-image-offload/README.md) — the passive sibling that reacts to a provider's image budget.
- [Tool-result expiry](../compaction-tool-result-expiry/README.md) — the same round-age policy applied to cold tool output.
- [Compaction basic backend](../compaction-basic/README.md) — the summarizing backend that owns window overflow.
- [Attachment](../../attachment/attachment/README.md) — the durable normalized image store this package names a path into.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Rehydrated conversation images

#### What the model sees

From the first request of a turn `retainRounds` or more after the turn that produced an image, that image appears as `[Image from <name> (<media type>, <bytes> bytes) - stored at: <path>]` in its place. The rest of the message is unchanged, including its text and its position in history. Images from the current and recent turns are still image blocks. Reading the named path again with a file tool is the way back to the pixels.

#### Token effect

A replaced image costs one placeholder line instead of its image tokens on every later request; hydration makes no model call. The saving is the whole per-request image price for that occurrence, and the model may spend one tool call on the stored copy when it needs the image again.

#### KV Cache effect

Each landed decision rewrites history from the oldest replaced image onward, so the provider prefix cache stops matching at that message for the request that lands it; requests after that share the new prefix. Messages before the oldest replaced image keep matching byte for byte, and a decision lands only when an image crosses the age boundary, not on every request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Round age is measured in turns, not images or tokens** — a single turn that attaches twenty screenshots keeps all of them verbatim for `retainRounds` turns.
- **The placeholder is only a pointer** — the model must read the stored copy again; nothing restores the image into a later request, so a long comparison of old images costs tool calls.
- **A composition without an attachment store or filesystem provider replaces nothing** — there is no readable path to name, so the images keep travelling and a warning reports it once per pass.
- **No per-image policy** — `retainRounds` applies to every image; keeping one reference image indefinitely has no configuration today.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Provider-side image caching, deferred** — a route that caches uploaded image content would make repeated images nearly free; hydration is the provider-independent answer until such a route exists.
- **Restoring a specific image on demand, deferred** — a tool that re-attaches one stored image to the next request needs a durable request-scoped input event; the stored path is the current workaround.

</details>
