---
description: "The persisted session-projection cache for deployments and maintainers choosing, configuring, or debugging durable checkpoints, zero-I/O list reads, and accelerated cold projection folds."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

## Summary

This package keeps durable per-session projection checkpoints so history lists, statistics, and goal snapshots can read cached values without loading each session log. Cold projection folds can resume after the checkpointed prefix, reducing restart work. The session log remains authoritative: a crash can leave a checkpoint stale, but never ahead of committed events, and incompatible records are ignored or backed up. Choose it for restarted sessions with frequent projection reads; skip it when projections are live-only or extra storage writes and unbounded checkpoint retention outweigh the saved work.

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

Mount this package beside the projection registry and the storage stack when clients should list projection values for cold sessions without loading their logs. Without it, consumers must obtain the log before they can reconstruct cold projection values.

### When to choose it

Choose it when a deployment restarts sessions and needs durable projection values for history lists, statistics, or goal snapshots. Skip it when projections serve only live sessions, or when the extra storage writes cost more than the saved projection work.

### Minimal configuration

All four fields are required — flush cadence and the memory bound are deployment choices with no universally correct value; base ships 30 days and 300 records:

The cache opens its domain through the storage stack, so base mounts `storage`, `storage-json` (root `dshHomePath('storages')`), and `storage-domain` (`backend: json`) before it:

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
    startupMaxAgeDays: 30
    maxResidentRecords: 300
```

| Field | Default | Meaning |
|---|---|---|
| `writeEveryEvents` | required | Committed events per session that force a durable checkpoint write between mandatory points |
| `writeIntervalMs` | required | Longest time a dirty checkpoint may stay unwritten between mandatory points |
| `startupMaxAgeDays` | required (base: `30`) | Startup reads only records whose document changed in the last this-many days; a record changed exactly at the window start is included |
| `maxResidentRecords` | required (base: `300`) | Most records startup reads (newest first), and the most complete records kept in memory afterwards |

The plugin injects `storageDomain`, `sessionProjections`, and `sessions`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-projection-cache) is the exhaustive source for every accepted field and its JSDoc.

### How checkpoints are written

Three mandatory points always write: session creation persists the seed-derived cut, `turn/end` persists the value that listing reads want, and session disposal persists the final live cut. Between them, the configured count and interval throttles write as events accumulate. Every write atomically replaces the session's complete record through the domain write chain; a failure logs a warning and keeps the cache stale, and the next write self-heals.

### Startup and memory bound

Startup lists the stored record documents without reading them and reads only those changed inside the `startupMaxAgeDays` window, newest first, at most `maxResidentRecords` of them. Other records stay on disk until a reader needs one. `ensureLoaded(id)` reads one session's complete record before a fold (`hydratePrepared`); Session observation reads and the migration-required projection read call it. `loadListing(meta)` reads one record for the Session list, keeps only its summary-key values as a listing view, and drops the complete record again, so listing every session never keeps every complete record. `loadListings(metas, signal)` does the same for many sessions in turn and skips sessions memory already answers for and sessions whose record a previous read found missing (a later write clears that mark); session mentions (`session-reference`) and forge change-request states await it before their synchronous `cachedSnapshot` pass. After any read or write, the least recently used clean complete records leave memory until at most `maxResidentRecords` remain, each keeping its listing view. A record whose session is live, or whose write is still in flight, never leaves memory, so the count can exceed the bound while more such sessions exist. A failed on-demand read logs a warning and serves the session as uncached.

### Reading cached values

`cachedSnapshot(meta, keys?)` is the read-only face: it synchronously serves client values from the storage domain's in-memory tables with zero I/O. When the complete record is not in memory, its listing view answers if every requested key is a summary key; otherwise the read misses. It accepts a record whose lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`) matches the header and serves its version- and schema-matching keys as one block whose `asOfSeq` is the lowest watermark among the served rows. That watermark is the stored record's own: a header witnesses no inherited cut and cannot vouch that the row sequence is comparable with the log a consumer later opens, so the Session list labels the block `cached` and the client lets every value the connected Session later produces supersede it. A row can also be frozen where its projection unit was released before the write, so its watermark may trail the log by more than the last checkpoint interval. Within one format generation the cut is fixed at fork time and distinguishes no lifecycle the other fields do not, and a viewed value never seeds a fold, so seeded (forked) sessions are served exactly like unseeded ones. `cachedPredecessorTitle(meta)` is the narrower listing-only exception across a Session-format edge: a structurally admitted predecessor record whose lifecycle matches may expose only a current-version-compatible `title` row, because title text is invariant across the adjacent edges. All other predecessor rows remain unavailable. `coldSnapshot(meta, inheritedEventCount, events)` is a fold face: it accepts the exact cut with a complete ordered log, skips the checkpointed prefix while folding, and refreshes the record without reading persistence itself.

### What the cache guarantees

The log leads and the cache follows: a live checkpoint flushes the session's buffered events durably before the cache row lands, so a crash can leave the cache behind the log but never ahead of it. Reads and writes share the storage domain's coherent in-memory state; the per-unit write chain mutates memory only after durability. Each version-stamped record must match the live unit schema and the lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`); the fold faces (`hydratePrepared`, `coldSnapshot`, and checkpoint writes) also require the exact `inheritedEventCount`, so a row folded from another Session format generation or fork cut cannot seed the caller. The JSON backend stores each record at `<root>/session_projcache/sessions/<id>.json` in an owner-only directory tree. Domain read validation preserves every own JSON key in checkpoint values, including `__proto__` and `constructor` inside opaque metadata. It rejects values that cannot survive a lossless JSON round trip, using the same rules as checkpoint writes. Each projection then validates its hydration state with its own `stateSchema`; fields carrying opaque JSON need a validator that preserves their keys.

Upgrades never block startup or expose an unproven fold. Records stamped with a version in the spec's `compatibleVersions` remain structurally readable for a current checkpoint rewrite, but a missing or older `formatVersion` never matches a current Session and therefore cannot seed hydration. A lifecycle-matching predecessor title remains available only through the listing hint above because title text is invariant across the adjacent Session-format edges and its row still passes the current projection `stateVersion` and schema. Once the format matches, absent lineage fields decode as the unseeded lineage — exact for unseeded sessions, while a seeded caller fails the identity match and refolds cold. A stored record that still fails schema validation is moved aside as `<id>.json.bak.<stamp>` under the domain's `invalidRecords: 'backup-and-skip'` policy, logged with its cause, and rebuilt by the next checkpoint.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the cache's durability and storage ownership; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The cache is a fold shortcut over the projection registry's checkpoint face, stored in a `per-record` domain data table. It commits to six consequences: reads never bypass the domain write chain; every background write is fail-soft; a `ver` mismatch discards rather than migrates a row; a record must pass the live unit's `stateSchema`; writes replace one complete session record through the lossless-JSON boundary; and the log leads, the cache follows.

### Read and write ownership

The cache stores one version-stamped document per session in the `session_projcache` domain. It does not depend on a session-persistence backend, call `locate`, or inspect per-session directories. A malformed or stale record reads as absent, and consumers that require a cold value own any log refold.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SessionProjectionCache` service, write-behind listeners, cache reads |
| [`src/spec.ts`](src/spec.ts) | The `session_projcache` domain spec and record identity types |
| [`src/residency.ts`](src/residency.ts) | Startup record selection and least-recently-used order of resident records |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the cache to the registry it checkpoints and the storage domain that holds its records.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract and drive semantics this cache checkpoints.
- [Session projection registry](../session-projection/README.md) — the `ctx.sessionProjections` service whose checkpoints this cache persists.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain routing and backend behavior that store cache records.
- [Session package map](../README.md) — adjacent persistence, title, and telemetry packages.
- [Session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) — the persisted projection cache design rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the persisted cache accelerates host-side reads of projection state and registers nothing model-facing.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the cache needs operational care. They are current package constraints, not a task backlog.

- **No retention surface on disk** — stored records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself. Only memory is bounded.
- **First read outside the window costs one disk read** — the first open, history read, or list row of a session outside the startup set reads its record document; the list reads such rows in the background within its backfill concurrency, so their titles arrive after the first list response.
- **The first full listing reads every record outside memory once** — `loadListing` and `loadListings` read each cold record from disk the first time a list, mention search, or forge state stream asks for it; later calls are served from the kept listing views. Listing views hold only summary-key values, so they stay small, but they are kept for every listed session until the plugin unloads.
- **Listing views are not bounded** — each session whose record was read or evicted keeps one summary-key view in memory; summary values are small, but their count grows with the number of listed sessions.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **No cache-side cold refold** — the cache serves and refreshes its rows but never reads the session log (it does not depend on the persistence layer); a consumer that needs a guaranteed cold snapshot refolds from the log itself.
- **Every schema or domain-version change must prove its upgrade story** — a change to the stored record schema or the domain version lands in the same PR with an archived fixture of the previously shipped on-disk format under `tests/fixtures/` and test cases in `tests/fixtures.spec.ts` proving the chosen disposition: read-compat recovery (`compatibleVersions`), current-version rewrite, or backup-and-skip salvage. A bump whose old records are simply discarded still proves that the discard neither causes startup to fail nor poisons the tree.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
