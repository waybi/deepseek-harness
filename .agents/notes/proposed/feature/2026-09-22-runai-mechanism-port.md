# Agent Note: Port six RunAI Coder harness mechanisms

Status: proposed

English | [中文](2026-09-22-runai-mechanism-port.zh.md)

## Problem

A RunAI Coder session (`~/.coder/sessions/2026/09/21/rollout-…-01a0c2e1-d2d1-7e21-b3e3-d8b55240aba5.jsonl`, 1016 events, 53 assistant messages) produced answers the user rated as "no filler, all substance, easy to follow". Reading the transcript shows the writing rules in its system prompt are one of three layers; the other two are harness mechanisms that push the model toward evidence-backed outcomes and cheap delegation. The writing layer is already ported as `~/.dsh/AGENTS.md`. Six mechanisms remain. The user wants all six, and their cost to land in DSH ranges from editing one config file to changing the core.

## Inventory: mechanism, evidence, DSH counterpart

| # | RunAI mechanism | Evidence in the transcript | What DSH already has | Gap |
|---|---|---|---|---|
| A | `write_cadence` cost audit: after N model round-trips with no user-facing outcome, inject "Cost check: 9 consecutive model round-trips, ~9m5s, ~38417 tokens, no outcome; Produce an outcome or report the blocker." | `<codex_internal_context source="write_cadence">`, 2 occurrences | nothing | full |
| B | Three concurrency watchdogs (`parallel_nudge`, `fake_fanout_watchdog`, `concurrency_nudge`) that compare plan steps marked in-progress against live sub-agents and reject "fake fan-out" | 1 occurrence each | `todo_write` with `content`/`status` only ([tool-todo](../../../../packages/todo/tool-todo/src/index.ts)); no `blocked_by`, no step→agent binding | needs a dependency graph first |
| C | Role-tiered spawn: `agent_type = judge` (clean context, locked low effort) / `awaiter` (polling) / `explorer` (read-only recon); the tool description says a hand-written judge prompt on a default spawn "silently loses both" | `multi_agent_v1.spawn_agent` description in `runai_prompt_shape/…json` | `tool-subagent` Config already carries `persona`, `toolFilter`, `agentOptions{provider,model,reasoningEffort}` and can be mounted several times under distinct `toolName` ([index.ts](../../../../packages/subagent/tool-subagent/src/index.ts)) | configuration only |
| D | Sub-agent operations: `peek_agent` (read-only look at on-disk progress), `resume_agent`, `subagent_inbox_list`; archived reports follow a fixed shape ending with "the three questions you will be asked, answered up front" | `~/.coder/subagent-archive/2026/09/21/155916805-…md` | children persist as ordinary sessions with `origin: 'subagent'` ([child-agent.ts](../../../../packages/subagent/subagent/src/child-agent.ts)); `session_read` reads any session; `list_agents`, `send_message`, `backgroundMode: continuable` | report contract missing; peek covered by `session_read` |
| E | Project-scoped memory: `MEMORY.md` index of one-line links to topic files; each topic file has frontmatter `name/description/type: lesson` and a **Why** paragraph naming the incident and date | `~/.coder/memory/vault-43c0ef76/{MEMORY.md,research-agent-evidence.md}` | `dsh-memory-evolve` (third-party) with daily/project/key tracks; key track has summary+expand | entry format has no Why / scope structure |
| F | `tool_search` deferred tool loading plus `read_output_chunk` (page a truncated result by chunk id) | tool catalog: 25 tools, `tool_search` sources "Multi-agent tools, google, kimi-cu" | full catalog in prompt each turn; oversized results go through `spill` ([spill](../../../../packages/spill/spill/README.md)) with a locator | catalog deferral missing |

## Proposal

Land in three batches ordered by blast radius. Batch A and B need no change under `packages/`; batch C is a pair of time-boxed feasibility checks that each end in a go/no-go, never in silent core edits.

### Batch A — configuration only (`~/.dsh/cordis.patch.yml`, `~/.dsh/AGENTS.md`)

**A1. Role-tiered sub-agents (mechanism C).** Add three `@deepseek-ai/dsh-tool-subagent` rows to the user patch, each with `provider: spawn`, a distinct `toolName`, a fixed `persona`, a `toolFilter`, and `agentOptions` that pin the model tier:

```text
subagent_judge     persona: score ONE artifact against the rubric given; reply verdict + evidence only
                   toolFilter.allow: [read, grep, glob, bash]      agentOptions: low-tier model, reasoningEffort low
subagent_explorer  persona: read-only reconnaissance; report facts with file:line, never edit
                   toolFilter.deny: [write, edit]                  agentOptions: low-tier model
subagent_awaiter   persona: wait for the named job/command and report its terminal state
                   toolFilter.allow: [bash, job_output, job_list]  agentOptions: low-tier model
```

The existing `subagent`/`subagent_fork` rows stay as the default tier. A rule in `~/.dsh/AGENTS.md` routes tasks by shape: verdict → `subagent_judge`, read-only fact finding → `subagent_explorer`, waiting → `subagent_awaiter`, anything that edits or needs heavy reasoning → default. Acceptance: `list_subagent_models` shows the three tools; a `subagent_judge` child that tries `write` is rejected by the filter.

**A2. Sub-agent report contract (mechanism D).** Add to `~/.dsh/AGENTS.md` the template every delegation prompt must include: `## 结论先说` (one paragraph) → evidence sections with `[file](path:line)` links → `## 按可能性排序` when there are competing explanations → `## 你会被追问的三个问题` (the parent's user will ask these; answer them now) → next step. Peek and inbox map onto existing tools, so the same section states: to inspect a quiet child, `session_read @session-<id>`; never send a message just to ask for status.

**A3. Memory entry shape (mechanism E).** Add to `~/.dsh/AGENTS.md` the format for `project` and `key` entries written through the `memory` tool: first line is the lesson in one sentence; second line starts with `Why:` and names the incident and date; third line starts with `Scope:` and names when the lesson applies. Daily entries keep the current free form. The key track's summary mode then indexes line one, matching RunAI's `MEMORY.md` index without changing the plugin.

### Batch B — one external hook script (mechanism A)

`hooks-claude-code` already runs an external command on `PostToolUse` and merges its `additionalContext` into the tool result ([index.ts](../../../../packages/hooks/hooks-claude-code/src/index.ts)); the payload carries `session_id`, `tool_name`, `tool_use_id`. The user's patch already mounts the plugin with `configPath: ~/.dsh/hooks-claude-code.json` for `skill-radar`.

Add `~/.dsh/hooks/cadence-audit.py`, registered on `UserPromptSubmit` and `PostToolUse`:

```text
state file  ~/.dsh/cadence/<session_id>.json  { calls, started_at }
UserPromptSubmit  → reset calls=0, started_at=now
PostToolUse       → calls += 1
                    if calls >= THRESHOLD (default 8) and calls % THRESHOLD == 0:
                      emit additionalContext:
                        "Cost check: <calls> consecutive tool calls, ~<elapsed>, no user-facing outcome yet.
                         Produce an outcome or report the blocker before the next tool call."
```

Threshold comes from `DSH_CADENCE_THRESHOLD`. Children with `origin: 'subagent'` are excluded (their parent already receives their completion notice). Token counts are not in the hook payload, so the message carries call count and wall time only. Acceptance: a session that runs nine `bash` calls without a reply receives exactly one injection; a normal three-call reply receives none; the injection text appears in the session log.

Open point before implementation: whether `Stop` should also fire the check for sessions with an active goal (`stop_hook_active` is always `false` in this plugin), or whether the goal driver's round-end judge already covers that case. Decide from one goal session's log.

### Batch C — two feasibility checks, each time-boxed, each ends in a decision

**C1. Concurrency watchdogs (mechanism B).** The premise is a `blocked_by` dependency graph on `todo_write` and a step→child binding; neither exists. Check, in ≤ 1 hour: reconstruct from the RunAI transcript what `fake_fanout_watchdog` and `concurrency_nudge` actually compare (`in_progress` steps vs. live children), and estimate the schema change to `tool-todo` plus a `PostToolUse` hook that reads both. Decision: a separate Agent Note with the schema, or record here that the user's workload does not justify a core change.

**C2. Deferred tool catalog (mechanism F).** Check, in ≤ 2 hours: whether the tool registry and `agent-loop` catalog rendering admit a "deferred" flag from a plugin without touching `packages/core`, using the `tool-cordis` catalog ([api-catalog.ts](../../../../packages/extensions/tool-cordis/src/api-catalog.ts)) as the reference for lazy exposure. `read_output_chunk` is already served by `spill` locators plus `read --offset/--limit`, so only catalog deferral is in scope. Decision: plugin design note, or drop.

## Status (2026-09-22)

**Batch A shipped and verified.** The user preset `~/.dsh/.agent-presets/standard-tiered` (a copy of `standard` plus the three rows) is the settings default. A fresh session created through `session/create` without `agentPreset` resolved to `standard-tiered`; its catalog listed `subagent, subagent_awaiter, subagent_explorer, subagent_fork, subagent_judge`. A `subagent_judge` child's `request/header.config` was `{provider: local-7357, model: agnes-3.0-flash, reasoningEffort: off}`, its catalog was `bash, glob, grep, list_subagent_models, read, subagent, subagent_fork` (no `write`/`edit`), and its system prompt began with the judge persona. Two corrections against the plan text: `maxDepth` is the child's absolute depth, so the rows use `1` (a `0` rejected every spawn with `subagent depth 1 exceeds maxDepth 0`); the pinned model is `agnes-3.0-flash` (efforts `off`/`high`) because `deepseek-v4-pro-0813` returned `pool_exhausted` with a 3.3 h retry on the day. The AGENTS.md routing rule, report contract, and memory shape are live. Backup: `local-tools/tools/dsh-agent-presets`, `tools/dsh-agents-md`.

**Batch B shipped; live wiring test pending a restart.** `~/.dsh/hooks/cadence-audit.py` (symlink into `local-tools/tools/dsh-cadence-audit`) passes 9 unit tests; `hooks-claude-code.json` registers it on `UserPromptSubmit` and `PostToolUse`, and the plugin's own `parseClaudeCodeConfig` accepts the file with 0 skipped hooks. The plugin reads its config once at startup, so the injection will appear only in sessions started after the next `dsh web` restart; that restart and the nine-`bash`-calls check are the remaining acceptance step. The `Stop` open point stays open: the goal driver's round-end judge already fires for goal sessions, and no evidence yet shows a gap the `Stop` hook would close.

**Batch C decisions.**

- *C1 (mechanism B): do not fork the core.* RunAI's `update_plan` carries per-step `id`, `blocked_by: [{kind, label, ref}]`, `estimated_minutes`, and `agents`, and its watchdogs compare `in_progress` steps against live spawns ("1 ready step(s) but only 0 launch call(s) dispatched this round"). Landing that in DSH means a `tool-todo` schema change, a step→child ledger the subagent plugin does not keep, and a `PostToolUse` reader over both — three core-adjacent edits maintained against `upstream`. The user's sessions delegate rarely enough that the A1 tiers plus the AGENTS.md rule "start independent delegations in the same message" cover the observed failure mode. Revisit only if fake fan-out shows up in a real DSH transcript.
- *C2 (mechanism F): already available; nothing to build.* DSH's `tools` registry has a `mode: ptc` presentation ([index.ts](../../../../packages/core/tools/src/index.ts)) that sends only `run_code` plus a generated SDK prompt, which is the same context saving `tool_search` delivers by a different route; the running Web host is on `native`. Per-scope `ToolRestriction` already hides tools from a child. `read_output_chunk` is served by `spill` locators plus `read --offset/--limit`. A `tool_search`-shaped deferred flag would need the registry's `ToolView` and the loop's catalog rendering to change — core, not plugin — and the benefit over `ptc` is unproven. Dropped; if catalog size becomes a measured problem, flip `DSH_TOOLS_MODE=ptc` first.

## Alternatives considered

- **Port all six as core changes on this fork.** Rejected: the fork tracks `upstream` (`deepseek-ai/deepseek-harness`); every core edit becomes a rebase liability, and four of the six do not need one.
- **Encode the role tiers as prose only, without separate tool rows.** Rejected on RunAI's own evidence: its tool description warns that a judge prompt on a default spawn silently keeps the default context and effort. Separate rows make the pin enforceable by `toolFilter` and `agentOptions`.
- **Implement the cadence audit inside `dsh-memory-evolve` or another already-mounted plugin.** Rejected: the hook plugin is already mounted, the script is 40 lines of Python, and the memory plugin is third-party.
- **Build `peek_agent` as a new tool.** Rejected: children are ordinary sessions and `session_read` already reads them read-only; a rule in `AGENTS.md` is enough.

## Acceptance criteria

- Batch A: the three tool rows load without startup errors; `list_subagent_models` lists them; a judge child cannot write; `~/.dsh/AGENTS.md` carries the routing rule, the report template, and the memory format; `local-tools/tools/dsh-agents-md/sync.sh` is run and the change pushed.
- Batch B: the script has unit tests for reset/increment/threshold; the wiring test above passes in a live session; the script and hook config are mirrored into `local-tools` with `validate-changed` coverage.
- Batch C: each check ends with a dated decision recorded in this note's follow-up or a new note; no `packages/` edit lands without its own Agent Note.

## Risks

- `~/.dsh/AGENTS.md` is workspace-instruction tier, below the system prompt; under long turns the model may drift from A2/A3. Mitigation is the cadence audit itself and, if drift persists, moving the routing rule into the `dsh-persona` text through the patch.
- A cadence threshold of 8 will fire during legitimate long refactors. The env knob and the once-per-multiple rule bound the noise; the message asks for an outcome or a blocker, not a stop.
- `toolFilter.allow` uses global tool names; a renamed tool fails the child at startup, which is the desired loud failure.
- Pinning judge/explorer to a low-tier model saves cost only if the deployment has one configured; with a single route the rows still enforce context and tool isolation but not price.
