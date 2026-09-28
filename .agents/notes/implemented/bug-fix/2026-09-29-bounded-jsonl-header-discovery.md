# Agent Note: Bounded JSONL header discovery

Status: implemented

English | [中文](2026-09-29-bounded-jsonl-header-discovery.zh.md)

## Problem

Session and subagent lists both discover durable session headers. Serial file checks and header reads make independent filesystem waits accumulate before either list can return. Header-only reads avoid replaying large event logs, but do not avoid repeated open, read, decompression, and close operations across the corpus.

### Observed latency and measurement limits

A local diagnosis on 2026-09-29 captured a `session/list` request lasting 38,338 ms. During that request, a separate process using the same source backend and storage root scanned 503 headers in 25,557 ms; its next scan took 2,095 ms. The server's native sample placed most main-thread samples in `kevent` and file workers mainly in `open` and `read`. This supports file-access waiting beyond one server's private queue; it does not identify the system process or resource causing that wait.

A separate process compared the final batched implementation with `listConcurrency` values `1, 8, 1, 8`, reading the same 508 headers and checking deep equality of every result. With no injected delay, elapsed times were 14,650, 80, 155, and 71 ms. The later serial result recovered without changing its concurrency, so the first slow result cannot establish a concurrency speedup under system pressure.

The same comparison then injected a 2 ms timer wait before every header read in that independent process only. With the same configuration order, elapsed times were 1,773, 270, 2,078, and 306 ms. These controlled waits demonstrate reduced accumulation of independent delays, not removal of the system-level trigger; timer scheduling and filesystem work remain part of the elapsed measurements. The live server was not modified by this comparison.

The retained local records are `/tmp/dsh-web-latency-evidence.json`, `/tmp/dsh-slow-stack-results.json`, `/tmp/dsh-slow-server-sample.txt`, and `/tmp/dsh-final-list-benchmark-results.json`. The comparison scripts are `/tmp/dsh-persistence-probe.mts` and `/tmp/dsh-final-list-benchmark.mts`. These machine-local artifacts are not repository fixtures or a portable performance guarantee; the measurements above retain the evidence used for this scheduling choice.

## Decision

The [JSONL backend](../../../../packages/session/session-persistence-jsonl/src/index.ts) exposes `listConcurrency`, a positive integer defaulting to `8`. Header discovery and the shared root-encoding preflight read session directories in bounded batches within each project. Results retain directory enumeration order rather than completion order. Setting the value to `1` selects serial discovery.

Each batch waits for all started reads to settle before propagating cancellation or a read failure. No later batch starts after either is observed. A rejected listing therefore leaves no started header read or open header handle behind. The one-time root-encoding preflight remains shared and independent of an individual caller's cancellation; a caller checks its signal after that preflight settles.

The limit applies to one discovery operation, not to the backend's combined requests or Node's process-wide worker pool. Separate listings can exceed the configured value in aggregate. The change introduces no header cache, global admission queue, file-format change, or durability change. Header decoding, suffix checks, stored identity validation, and duplicate-id rejection remain mandatory.

## Alternatives considered

**Keep every directory read serial.** This uses fewer simultaneous operations, but independently delayed file reads accumulate on the request's critical path. The controlled overlap tests and delayed-read comparison justify bounded overlap without requiring a claim about the system-level trigger.

**Start every header read at once.** Rejected because the corpus size would determine simultaneous file and decompression work. A deployment-controlled bound limits each request's contribution and permits serial operation where necessary.

**Cache headers instead of checking storage.** Deferred because invalidation for external creation, deletion, replacement, and encoding changes is a separate correctness decision. Scheduling the existing authoritative checks does not require a stale-data policy.

**Change the process worker pool or disable background work.** Not selected: concurrent filesystem and compression work share resources, but the observed independent-process slowdown does not establish a server-only pool problem or identify a background culprit. The mitigation does not alter stream writes, system services, or process-wide worker settings.

## Verification

The [bounded-listing tests](../../../../packages/session/session-persistence-jsonl/tests/list-concurrency.spec.ts) hold real header reads behind instance-local barriers to verify overlap, the configured per-call bound, directory order, cancellation and failure draining, independent limits for simultaneous listings, append progress while reads wait, invalid configuration, and duplicate identity rejection. These checks exercise scheduling and cleanup without depending on storage speed or a wall-clock speedup threshold.

The existing [JSONL](../../../../packages/session/session-persistence-jsonl/tests/jsonl.spec.ts) and [Zstandard](../../../../packages/session/session-persistence-jsonl/tests/zstd.spec.ts) suites cover storage validation and encoding behavior. The remaining performance gap is a matched slow-period comparison of the final implementation. Warm scans and deterministic barriers do not close that gap.

## Consequences

Independent header waits can overlap, while each batch retains bounded file-handle and decompression pressure. A slow read still delays its batch, cancellation still waits for already-started work, and concurrent callers can increase total I/O pressure. Discovery remains a full-corpus operation; snapshot revision reads and API cold-summary work are outside this header concurrency limit.

This decision mitigates serial latency amplification rather than establishing or fixing the intermittent system-level cause. It does not promise a maximum listing latency or require clearing logs, restarting the server, or disabling another process.

## Related decisions

The [Zstandard log decision](../architecture/2026-07-19-zstandard-jsonl-session-logs.md) remains authoritative for checksums, frame boundaries, encoding ownership, and header-only semantics. [Session observations](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.md) still own exact read cuts, retained preparations, and projection-backed listing. [Bounded write batching](../architecture/2026-08-08-bounded-session-persistence-write-batching.md) still owns stream-write timing and flush durability. None is superseded or archived by a change to discovery scheduling.
