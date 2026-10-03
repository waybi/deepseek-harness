---
description: "面向按输入 token 计费部署的冷工具输出按轮次过期：选择结果保留原文多少轮，或排查较早的工具结果为何变成一行占位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-tool-result-expiry

[English](README.md) | 中文

## 概述

`dsh-compaction-tool-result-expiry` 降低长时间、工具密集会话的每请求输入账单。每次模型请求前，它把 `coldTurns` 轮或更早产生、且文本超过 `thresholdChars` 的每个工具结果替换为一行占位，注明工具名与移除的大小。当前轮与最近几轮的结果保持原文。完整原文仍保留在会话日志中，可精确回放。过期不发起模型调用，也不看 token 压力：它解决的是每次请求重发旧输出的成本，而上下文窗口溢出由 `dsh-compaction-basic` 负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当会话每轮运行大量工具调用、每次请求都重发完整历史时挂载本包。它会改变模型看到的内容——较早的工具输出变成占位——并让每次请求的前导消息保持一致，因此提供方前缀缓存可以一直匹配到第一个被占位的结果。

### 最小可用组合

先挂载 token 测量，再挂载本包：

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-expiry'
```

有了这些配置行，冷的超大工具结果会在每次请求前自动被占位。你可以比较冷边界之后的两次连续请求来确认：较早的工具结果显示为占位，而完整原文仍在会话日志中。不要求挂载 `dsh-compaction-basic`；挂载时，过期会在每个步骤先落地，缓解后的表层可能跳过摘要。

### 什么会过期

同时满足两条时工具结果过期：产生它的轮次比正在准备的轮次早 `coldTurns` 轮或更多，且其文本超过 `thresholdChars` 个 Unicode 码点。替换保留工具调用、步骤、错误、元数据以及所有非文本块（图片与结构化块）的顺序；所有文本块折叠为一行占位：

```text
[<tool name> output from an earlier turn expired: <N> characters removed; rerun the tool to see it again]
```

工具名取自发出该调用的 assistant 消息；表层上没有命名其调用的结果显示为 `tool`。已经是占位的结果，或文本不比其占位更长的结果，不会被改写。如果替换无法被记录，请求按当前表层继续并记录一条警告；已应用的替换保持不变。

### 设置策略

所有设置都可选。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-tool-result-expiry)是涵盖所有配置字段的真源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `coldTurns` | `3` | 产生结果的轮次之后又开始了这么多轮，结果即为冷。当前轮与之前 `coldTurns - 1` 轮保持原文。 |
| `thresholdChars` | `2048` | 只让文本超过此 Unicode 码点数的结果过期。 |
| `sweepEvery` | `30` | 某一趟落地至少一处替换后，再隔这么多轮才允许下一趟，让提供方前缀缓存在其间保持稳定。`1` 表示每轮都扫。 |
| `idleSweepMs` | `3600000` | 会话距上次请求闲置至少这么久后也允许落地一趟，此时缓存前缀多半已经过期。 |

未知设置会导致插件在构造时被拒绝。在模型很少回看旧结果的会话里调低 `coldTurns` 以更早卸掉输出；调高 `thresholdChars` 以让小结果（文件列表、短命令输出）永久保持原文。

### 过期何时运行

过期在每次 `agent/pre-step` 运行，先于 `dsh-compaction-basic` 测量压力。同一轮内多次工具往返的每次请求各评估一次；同一轮的结果对该轮永远不算冷。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释过期背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **以轮龄而非压力为触发。** 无论窗口是否接近上限，每次请求都会产生输入成本。像 `dsh-compaction-tool-result-pruner` 那样等待压力，会让旧输出留在每个中间请求里。
- **前缀稳定优先于最大化节省。** 只改写工具结果，且只改写冷边界之前的。系统提示词、工具 schema、用户消息与 assistant 消息永不触碰，因此提供方前缀缓存可以匹配到第一个被占位的节点。
- **可安全回放的替换。** 原始事件保留在仅追加日志中；占位通过 `sourceEventSeqs` 引用它，回放可恢复精确输入。
- **影子价格协议。** `compaction/prune` 紧邻替换事件并位于其前，通过注入的 token meter 为被替换节点定价——即 `compaction/prune` 事件上记录的共享协议。

### 过期机制

`expireSession` 单次遍历当前表层，从 assistant 的 `tool-call` 块收集工具名，并收集冷的 `tool/result` 节点。每个文本超过阈值的冷结果经会话已记录的消息投影派生，折叠为一行占位加其非文本块，并作为仅改内容的 `tool/result` 替换追加，前面紧跟 `compaction/prune`。pre-step 监听器以前置方式注册，因此先于 `dsh-compaction-basic` 运行；其中的失败会被记录，步骤继续。精确签名见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ToolResultExpiry` 服务、`expireSession` / `expireContent` / `isCold` / `measureContent`、`agent/pre-step` 监听器 |
| [`src/config.ts`](src/config.ts) | `expiredStub`、默认值、码点计数、策略验证 |
| [`src/types.ts`](src/types.ts) | `ToolResultExpiryConfig`、`ResolvedConfig`、`ExpiredEntry`、`ExpiryResult` |
| — | 不发布运行时不变式伴生入口；Session 会验证每次仅改写内容的操作，其伴生条目负责维护跨事件包围关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具结果修剪器](../compaction-tool-result-pruner/README.zh.md)——按压力触发、保留头尾而非占位的兄弟包。
- [压缩基础后端](../compaction-basic/README.zh.md)——负责窗口溢出的摘要后端。
- [压缩 seam](../compaction/README.zh.md)——本包发出的 `compaction/prune` 影子价格事件。
- [Token meter](../../llm/token-meter/README.zh.md)——为每个被替换节点定价的测量服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-tool-result-expiry)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 已过期的工具结果

#### 模型看到的内容

从某结果所在轮之后至少 `coldTurns` 轮的第一次清扫起，该结果显示为 `[<tool> output from an earlier turn expired: <N> characters removed; rerun the tool to see it again]`，而非其文本。非文本块保持顺序。当前轮与最近几轮的结果为原文。

若原文末尾带有 spill 策略通知（`(Omitted … Full formatted result stored at: <path>. …)`），占位改为 `[<tool> output from an earlier turn expired: <N> characters removed; the complete result is still stored at the path below, read that file instead of rerunning the tool]`，通知原样跟在其后，因此存储路径在过期后仍然保留。

#### Token 影响

每个过期结果在之后的每次请求中只占一行占位，而非其原文。过期不发起模型调用。模型可能需要花一次工具调用重新读取它仍需要的输出。

#### KV Cache 影响

每处落地的替换都会使该节点之后的提供方前缀复用在一次请求内失效；之后的每次请求共享新前缀。第一个占位之前的节点永不改写，因此系统提示词、工具 schema 与近期历史持续匹配。替换是分批落地的：一趟落地后，下一趟要等 `sweepEvery` 轮或 `idleSweepMs` 的闲置间隔；`dsh-compaction-basic` 也会在自己的压缩过程中（前缀此时已经丢失）顺带落地待处理的替换。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **轮龄按轮数计，不按 token 或时间**——一个有大量工具往返的长单轮会保留其全部结果原文，直到下一轮开始。
- **字符阈值不是 token 阈值**——不同提供方 token 密度各异；`thresholdChars` 只能近似节省量。
- **除非结果已 spill，否则占位是唯一的恢复提示**——没有保留的 spill 策略通知时模型必须重跑工具；不提供读取过期文本的工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是维护者的工作背景，明确不具权威性；已交付行为以上述章节、包代码与链接的 Agent Notes 为准。

- **读取工具，延期**——一个从日志读回被替换事件的 `read_expired_output` 工具可以让模型不必重跑有副作用的命令即可恢复；需要一个工具包与 spill 风格的大小上限。
- **按工具的策略，未定**——只读工具（文件读取、搜索）重跑成本低，而命令输出未必；按工具的 `coldTurns` 覆盖目前没有消费方证据。

</details>
