---
description: "长图片会话的按轮水化：一次请求重发哪些图片、被替换的图片对模型长什么样，以及如何保留更多或更少的图片轮次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-rehydrate

[English](README.md) | 中文

## 概述

`dsh-compaction-image-rehydrate` 只重发最近几轮的图片。每次模型请求前，它把 `retainRounds` 轮或更早产生的每张图片替换为一行文本占位，注明图片名、编码字节数，以及模型仍可用文件工具读到的只读落盘路径。当前轮与最近几轮的图片保持原样。用户消息与工具结果的持久事件保留每张原始图片，因此回放能还原完整对话。水化不发起模型调用，也不看 token 压力：它解决的是每次请求重发图片字节的账单，而路由的图片预算由 [`dsh-compaction-image-offload`](../compaction-image-offload/README.zh.md) 负责，上下文窗口溢出由 `dsh-compaction-basic` 负责。

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

在所有会跑图片会话的组合里挂载本包。发行版 `dsh` 基础层已挂。它需要挂载附件存储与文件系统才能给出可读的落盘副本；缺这两个服务时图片留在请求里，并记录一条告警说明原因。

### 最小可用组合

挂载附件存储、文件系统提供方，再挂本包：

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-compaction-image-rehydrate'
  config:
    retainRounds: 2
```

有了这几行，三轮前产生的图片在下一次请求里是占位符，而上一轮刚附上的图片仍以图片字节发送。

### 什么会被替换

当产生图片消息的那一轮，距离正在准备的这一轮达到 `retainRounds` 轮或更早时，图片被替换。替换按消息进行，不按轮：消息保留文本、非图片块与消息标识，每张被选中的图片在原位置变成一段文本块：

```text
[Image from <name> (<media type>, <bytes> bytes) - stored at: <read-only path>]
```

路径是规范化附件在当前工具执行世界中映射出的落盘副本，模型可以用自己的文件工具再次读取该图片。已被图片卸载决策卸载的图片、以及在本组合里没有可读落盘路径的图片，都保留原样；后者每次扫描记录一条告警。

### 设置策略

所有设置都是可选项。生成的[配置目录](../../../docs/config-catalog.zh.md)是完整来源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `retainRounds` | `2` | 产生图片的那一轮之后又开始的轮数达到该值时，图片被替换。当前轮与最近 `retainRounds - 1` 轮保留图片。最小为 `1`。 |
| `enabled` | `true` | 设为 `false` 时所有图片保持原样，插件不记录任何决策。 |

未知设置项，或小于 `1` 的 `retainRounds`，会在构造时拒绝插件。需要反复对照多张历史截图时调大 `retainRounds`；只关心最新一张图片时调小到 `1`。

### 水化何时运行

水化在每次 `agent/pre-step` 运行，早于压缩监听器测算压力。一轮里多次工具往返时每个请求评估一次；正在准备的这一轮产生的图片永远不会比当前轮更早，因此总是保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释水化背后的设计取舍；可观察行为已在[使用本包](#use-this-package)完整覆盖。

### 设计取舍

- **触发条件是轮龄，不是提供方压力。** 无论路由离预算多远，一张图片在之后每个请求里都要付出它的请求字节。等 `IMAGE_OFFLOAD_REQUIRED` 出现再处理，就像图片卸载那样，会让每个中间请求都为模型早已读过的图片付费。
- **只改请求面，不改日志。** 插件追加一条持久的 `image/rehydrate` 决策，由注册的消息投影重写模型可见消息。用户消息与工具结果事件保留图片块，因此会话记录、回放与之后再次读取图片都不受影响。
- **落盘副本就是恢复路径。** 没有可读路径的占位会让模型再也看不到那张图片，因此路径解析不出来时宁可保留图片本身。
- **被动策略的决策不被覆盖。** 水化从不改写图片卸载已卸载的图片，也不碰卸载恢复之后仍可能需要的那条消息。

### 水化机制

每次 pre-step 扫描读取宿主侧的 `imageSurface` 投影，它索引每个当前用户消息与工具结果节点及其产生轮次；折叠对用户消息跟随 `turn/start`，对工具结果取结果负载里的轮次，并丢弃被表面替换遮蔽的节点。扫描取 `session.deriveMessages()`，即经过此前所有消息投影后的消息，对每个早于 `retainRounds` 的节点收集未卸载的图片出现位置、它们的深度优先序号与解析出的只读路径。只要收集到至少一处，就追加一条 `image/rehydrate` 事件，精确命名这些出现位置，由已注册的投影把它们换成文本占位。追加时的校验会拒绝命名不在当前表面上的节点、非图片出现位置、非严格递增的序号、已卸载的出现位置、以及空路径，因此畸形决策进不了日志。pre-step 监听器前置；其内部失败会记录日志并让该步继续。完整签名见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ImageRehydrate` 服务、`rehydrateSession` / `isOld` / `imagePath`、`agent/pre-step` 监听器 |
| [`src/config.ts`](src/config.ts) | 占位文本、默认值、配置校验 |
| [`src/projection.ts`](src/projection.ts) | 宿主侧 `imageSurface` 索引与 `image/rehydrate` 请求面投影 |
| [`src/types.ts`](src/types.ts) | `ImageRehydrateConfig`、`ResolvedConfig`、`RehydratedImage`、`RehydrateResult` 与 `image/rehydrate` 事件声明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [图片卸载](../compaction-image-offload/README.zh.md) —— 对其提供方图片预算作出反应的被动伙伴。
- [工具结果过期](../compaction-tool-result-expiry/README.zh.md) —— 同一套轮龄策略，用在冷的工具输出上。
- [压缩后端](../compaction-basic/README.zh.md) —— 负责上下文窗口溢出的摘要后端。
- [附件](../../attachment/attachment/README.zh.md) —— 本包用来给出路径的持久规范化图片存储。
- [生成的配置目录](../../../docs/config-catalog.zh.md) —— 每个接受的配置字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 被水化的会话图片

#### 模型看到什么

从产生该图片的那一轮之后 `retainRounds` 轮（或更晚）的第一次请求起，该图片在原位置显示为 `[Image from <name> (<media type>, <bytes> bytes) - stored at: <path>]`。消息其余部分不变，包括文本与它在历史中的位置。当前轮与最近几轮的图片仍是图片块。用文件工具再次读取所给路径是回到像素的办法。

#### token 影响

被替换的图片在之后每个请求里只花一行占位，而不再花它的图片 token；水化不发起模型调用。省下的是这一处图片在整个请求中的价格，模型需要那张图片时可能要多花一次工具调用去读落盘副本。

#### KV 缓存影响

每条落地的决策都会从最老的那张被替换图片起重写历史，因此落在它的那个请求里，提供方前缀缓存从该消息起不再匹配；之后的请求共享新的前缀。最老被替换图片之前的消息逐字节保持不变，而且只有图片跨过轮龄边界时才会落地决策，不是每个请求都落地。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **轮龄按轮计，不按图片或 token 计** —— 一轮里附上二十张截图，它们都会原样保留 `retainRounds` 轮。
- **占位符只是指针** —— 模型必须再次读取落盘副本；没有任何机制把图片放回之后的请求，所以长时间对照旧图片要花工具调用。
- **没有附件存储或文件系统提供方的组合什么都不替换** —— 没有可命名的路径，图片继续随请求发送，并每次扫描记录一条告警。
- **没有按图片的策略** —— `retainRounds` 作用于每张图片；长期保留某张参考图目前没有配置项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确非权威；发行行为以上各节、包代码与所链 Agent Note 为准。

- **提供方侧图片缓存，待定** —— 会缓存已上传图片内容的路由能让重复图片几乎免费；在出现这种路由之前，水化是与提供方无关的答案。
- **按需恢复指定图片，待定** —— 能把一张落盘图片重新挂回下一次请求的工具，需要一条请求域的持久输入事件；目前用落盘路径兜底。

</details>
