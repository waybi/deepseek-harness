# Agent Note：移植 RunAI Coder 的六套 harness 机制

状态：proposed

[English](2026-09-22-runai-mechanism-port.md) | 中文

## 问题

一次 RunAI Coder 会话（`~/.coder/sessions/2026/09/21/rollout-…-01a0c2e1-d2d1-7e21-b3e3-d8b55240aba5.jsonl`，1016 条事件、53 条助手消息）的回答被用户评价为「没有废话、全是干货、通俗易懂」。读完记录可以确认：系统提示词里的写作规则只是三层之一，另外两层是 harness 机制，负责把模型推向有证据的产出和廉价的委派。写作层已移植为 `~/.dsh/AGENTS.md`；剩下六套机制。用户全部都要，而它们在 DSH 落地的成本从改一个配置文件到动内核不等。

## 盘点：机制、证据、DSH 现状

| # | RunAI 机制 | 记录中的证据 | DSH 已有 | 缺口 |
|---|---|---|---|---|
| A | `write_cadence` 成本审计：连续 N 轮模型往返没有面向用户的产出时注入「Cost check: 9 consecutive model round-trips, ~9m5s, ~38417 tokens, no outcome; Produce an outcome or report the blocker.」 | `<codex_internal_context source="write_cadence">`，出现 2 次 | 无 | 全缺 |
| B | 三种并发督察（`parallel_nudge`、`fake_fanout_watchdog`、`concurrency_nudge`）：比对标为进行中的计划步骤与真实存活的子代理，拒绝「假并行」 | 各出现 1 次 | `todo_write` 只有 `content`/`status`（[tool-todo](../../../../packages/todo/tool-todo/src/index.ts)）；无 `blocked_by`，无步骤→子代理绑定 | 先要有依赖图 |
| C | 角色分级派发：`agent_type = judge`（干净上下文、锁低 effort）/ `awaiter`（轮询等待）/ `explorer`（只读侦察）；工具描述明说「把手写的裁判提示词丢给默认派发，两个收益都会静默丧失」 | `runai_prompt_shape/…json` 里 `multi_agent_v1.spawn_agent` 的描述 | `tool-subagent` 的 Config 已有 `persona`、`toolFilter`、`agentOptions{provider,model,reasoningEffort}`，且可用不同 `toolName` 挂多份（[index.ts](../../../../packages/subagent/tool-subagent/src/index.ts)） | 只差配置 |
| D | 子代理运维：`peek_agent`（只读看落盘进度）、`resume_agent`、`subagent_inbox_list`；归档报告格式固定，结尾是「你会被追问的三个问题，先答上」 | `~/.coder/subagent-archive/2026/09/21/155916805-…md` | 子代理以 `origin: 'subagent'` 落成普通会话（[child-agent.ts](../../../../packages/subagent/subagent/src/child-agent.ts)）；`session_read` 可读任意会话；`list_agents`、`send_message`、`backgroundMode: continuable` | 缺报告契约；peek 由 `session_read` 覆盖 |
| E | 项目域记忆：`MEMORY.md` 索引每行一个链接指向主题文件；主题文件带 frontmatter `name/description/type: lesson` 和一段 **Why**，写明事故与日期 | `~/.coder/memory/vault-43c0ef76/{MEMORY.md,research-agent-evidence.md}` | 第三方 `dsh-memory-evolve`，有 daily/project/key 三轨；key 轨有摘要+expand | 条目格式没有 Why / 适用范围结构 |
| F | `tool_search` 延迟加载工具 + `read_output_chunk`（按 chunk id 翻页截断结果） | 工具目录 25 个，`tool_search` 来源「Multi-agent tools, google, kimi-cu」 | 每轮把完整目录放进提示词；超大结果走 `spill`（[spill](../../../../packages/spill/spill/README.zh.md)）给定位符 | 缺目录延迟加载 |

## 方案

按影响面分三批落地。A、B 两批不改 `packages/` 下任何文件；C 批是两项限时可行性核查，各自以「做 / 不做」的结论收尾，绝不静默改内核。

### A 批——纯配置（`~/.dsh/cordis.patch.yml`、`~/.dsh/AGENTS.md`）

**A1. 角色分级子代理（机制 C）。** 在用户 patch 里加三行 `@deepseek-ai/dsh-tool-subagent`，都用 `provider: spawn`，各配不同 `toolName`、固定 `persona`、`toolFilter`，以及钉住模型档位的 `agentOptions`：

```text
subagent_judge     persona: score ONE artifact against the rubric given; reply verdict + evidence only
                   toolFilter.allow: [read, grep, glob, bash]      agentOptions: low-tier model, reasoningEffort low
subagent_explorer  persona: read-only reconnaissance; report facts with file:line, never edit
                   toolFilter.deny: [write, edit]                  agentOptions: low-tier model
subagent_awaiter   persona: wait for the named job/command and report its terminal state
                   toolFilter.allow: [bash, job_output, job_list]  agentOptions: low-tier model
```

现有的 `subagent`/`subagent_fork` 行保留为默认档。`~/.dsh/AGENTS.md` 加一条按任务形状路由的规则：裁决 → `subagent_judge`，只读查证 → `subagent_explorer`，等待 → `subagent_awaiter`，凡是要改文件或需要重推理的 → 默认档。验收：`list_subagent_models` 能看到三个工具；`subagent_judge` 的子代理调用 `write` 被过滤器拒绝。

**A2. 子代理报告契约（机制 D）。** 在 `~/.dsh/AGENTS.md` 加每次委派 prompt 必含的模板：`## 结论先说`（一段）→ 带 `[file](path:line)` 链接的证据分节 → 有多个竞争解释时加 `## 按可能性排序` → `## 你会被追问的三个问题`（父代理的用户一定会问，现在就答）→ 下一步。peek 和 inbox 落到已有工具上，同一节写明：要看一个安静的子代理，用 `session_read @session-<id>`；不要为了问进度而 `send_message`。

**A3. 记忆条目格式（机制 E）。** 在 `~/.dsh/AGENTS.md` 规定通过 `memory` 工具写 `project` 和 `key` 轨的格式：第一行是一句话教训；第二行以 `Why:` 开头，写明事故和日期；第三行以 `Scope:` 开头，写明何时适用。daily 轨保持自由格式。key 轨的摘要模式会索引第一行，等价于 RunAI 的 `MEMORY.md` 索引，插件不用改。

### B 批——一个外部 hook 脚本（机制 A）

`hooks-claude-code` 已能在 `PostToolUse` 运行外部命令并把其 `additionalContext` 合并进工具结果（[index.ts](../../../../packages/hooks/hooks-claude-code/src/index.ts)）；payload 带 `session_id`、`tool_name`、`tool_use_id`。用户 patch 已为 `skill-radar` 挂了该插件，`configPath: ~/.dsh/hooks-claude-code.json`。

新增 `~/.dsh/hooks/cadence-audit.py`，注册在 `UserPromptSubmit` 和 `PostToolUse`：

```text
state file  ~/.dsh/cadence/<session_id>.json  { calls, started_at }
UserPromptSubmit  → reset calls=0, started_at=now
PostToolUse       → calls += 1
                    if calls >= THRESHOLD (default 8) and calls % THRESHOLD == 0:
                      emit additionalContext:
                        "Cost check: <calls> consecutive tool calls, ~<elapsed>, no user-facing outcome yet.
                         Produce an outcome or report the blocker before the next tool call."
```

阈值读 `DSH_CADENCE_THRESHOLD`。`origin: 'subagent'` 的子会话排除（父代理已经收它们的完成通知）。hook payload 没有 token 数，所以消息只带调用次数和墙钟时间。验收：一个连跑九次 `bash` 不回复的会话恰好收到一次注入；正常三次调用后回复的会话零注入；注入文本出现在会话日志里。

实现前待定：有活动 goal 的会话是否也在 `Stop` 上触发检查（本插件的 `stop_hook_active` 恒为 `false`），还是 goal 驱动器的轮末裁判已经覆盖。看一个 goal 会话的日志再定。

### C 批——两项限时可行性核查，各以决策收尾

**C1. 并发督察（机制 B）。** 前提是 `todo_write` 有 `blocked_by` 依赖图和步骤→子代理绑定；两者都没有。≤ 1 小时内核查：从 RunAI 记录还原 `fake_fanout_watchdog` 和 `concurrency_nudge` 到底比什么（`in_progress` 步骤 vs 存活子代理），估算 `tool-todo` 的 schema 改动加一个读两边的 `PostToolUse` hook 的工作量。决策：另开一份 Agent Note 写 schema，或在本 note 记录「用户工作负载不足以支撑内核改动」。

**C2. 工具目录延迟加载（机制 F）。** ≤ 2 小时内核查：工具注册表与 `agent-loop` 的目录渲染是否允许插件在不动 `packages/core` 的前提下打「deferred」标记，以 `tool-cordis` 的目录（[api-catalog.ts](../../../../packages/extensions/tool-cordis/src/api-catalog.ts)）为懒暴露参考。`read_output_chunk` 已由 `spill` 定位符加 `read --offset/--limit` 覆盖，只有目录延迟在范围内。决策：插件设计 note，或放弃。

## 现状（2026-09-22）

**A 批已落地并验证。** 用户 preset `~/.dsh/.agent-presets/standard-tiered`（`standard` 的副本加三行）已是 settings 默认。通过 `session/create` 不传 `agentPreset` 新建的会话解析为 `standard-tiered`；其工具目录列出 `subagent, subagent_awaiter, subagent_explorer, subagent_fork, subagent_judge`。一个 `subagent_judge` 子会话的 `request/header.config` 为 `{provider: local-7357, model: agnes-3.0-flash, reasoningEffort: off}`，工具目录为 `bash, glob, grep, list_subagent_models, read, subagent, subagent_fork`（无 `write`/`edit`），系统提示词以 judge persona 开头。相对 plan 原文有两处修正：`maxDepth` 是子代理的绝对深度，所以三行用 `1`（写 `0` 会以 `subagent depth 1 exceeds maxDepth 0` 拒绝所有派发）；钉住的模型是 `agnes-3.0-flash`（effort 只有 `off`/`high`），因为当天 `deepseek-v4-pro-0813` 返回 `pool_exhausted`、重试要等 3.3 小时。AGENTS.md 的路由规则、报告契约、记忆格式已生效。备份：`local-tools/tools/dsh-agent-presets`、`tools/dsh-agents-md`。

**B 批已落地；真实接线测试等重启。** `~/.dsh/hooks/cadence-audit.py`（软链到 `local-tools/tools/dsh-cadence-audit`）通过 9 个单测；`hooks-claude-code.json` 在 `UserPromptSubmit` 与 `PostToolUse` 上登记了它，插件自己的 `parseClaudeCodeConfig` 解析该文件 0 条跳过。插件启动时只读一次配置，所以注入只会出现在下次 `dsh web` 重启之后新开的会话里；那次重启和「连跑九次 `bash`」检查是剩下的验收步骤。`Stop` 待定项保持待定：goal 驱动器的轮末裁判已对 goal 会话生效，尚无证据表明存在 `Stop` hook 才能补的缺口。

**C 批决策。**

- *C1（机制 B）：不 fork 内核。* RunAI 的 `update_plan` 每步带 `id`、`blocked_by: [{kind, label, ref}]`、`estimated_minutes`、`agents`，其督察比对的是 `in_progress` 步骤与真实派发（「1 ready step(s) but only 0 launch call(s) dispatched this round」）。在 DSH 落地意味着改 `tool-todo` 的 schema、给 subagent 插件加它现在没有的步骤→子代理账本、再写一个读两边的 `PostToolUse`——三处贴着内核的改动都要对着 `upstream` 维护。用户会话的委派频率不高，A1 的分级加 AGENTS.md「独立委派同一条消息里一起发」的规则已覆盖观察到的失败模式。只有真实 DSH 记录里出现假并行时再重开。
- *C2（机制 F）：已经有了，不用做。* DSH 的 `tools` 注册表有 `mode: ptc` 呈现（[index.ts](../../../../packages/core/tools/src/index.ts)），只发 `run_code` 加一段生成的 SDK 提示词，与 `tool_search` 用另一条路达到同样的上下文节省；当前 Web 主机在 `native`。每 scope 的 `ToolRestriction` 已能对子代理隐藏工具。`read_output_chunk` 由 `spill` 定位符加 `read --offset/--limit` 覆盖。要做 `tool_search` 形态的 deferred 标记，得改注册表的 `ToolView` 和 loop 的目录渲染——是内核不是插件，而且相对 `ptc` 的收益未证实。放弃；若目录体积成为可测的问题，先切 `DSH_TOOLS_MODE=ptc`。

## 备选方案

- **六套全部作为本 fork 的内核改动。** 否决：fork 跟踪 `upstream`（`deepseek-ai/deepseek-harness`），每处内核改动都是 rebase 负债，而六套里四套根本不需要。
- **角色分级只写成文字规则，不拆工具行。** 按 RunAI 自己的证据否决：其工具描述警告，裁判提示词丢给默认派发会静默保留默认上下文和 effort。拆行之后 `toolFilter` 和 `agentOptions` 让钉档位可执行。
- **把成本审计做进 `dsh-memory-evolve` 或别的已挂插件。** 否决：hook 插件已经挂着，脚本 40 行 Python，记忆插件是第三方。
- **新做一个 `peek_agent` 工具。** 否决：子代理就是普通会话，`session_read` 已能只读读取；`AGENTS.md` 一条规则足够。

## 验收标准

- A 批：三行工具配置加载无启动错误；`list_subagent_models` 列出它们；judge 子代理无法写文件；`~/.dsh/AGENTS.md` 含路由规则、报告模板、记忆格式；跑过 `local-tools/tools/dsh-agents-md/sync.sh` 并推送。
- B 批：脚本有 reset/increment/threshold 的单元测试；上文的接线测试在真实会话通过；脚本与 hook 配置镜像进 `local-tools` 且有 `validate-changed` 覆盖。
- C 批：每项核查以带日期的决策收尾，记入本 note 的后续或新 note；没有自带 Agent Note 的 `packages/` 改动不得落地。

## 风险

- `~/.dsh/AGENTS.md` 是 workspace-instruction 层级，低于系统提示词；长回合里模型可能偏离 A2/A3。缓解手段是成本审计本身；若持续偏离，则通过 patch 把路由规则移进 `dsh-persona` 文本。
- 阈值 8 会在正当的长重构里触发。环境变量开关和「每到阈值整数倍才触发一次」限制噪音；消息要的是结论或阻塞点，不是停下。
- `toolFilter.allow` 用的是全局工具名；工具改名会让子代理启动失败，这是想要的显式失败。
- 把 judge/explorer 钉到低档模型只在部署配了低档路由时省钱；单路由部署下这些行仍能隔离上下文和工具，但不省钱。
