# Agent Note: 有界 JSONL header 发现

Status: implemented

[English](2026-09-29-bounded-jsonl-header-discovery.md) | 中文

## 问题

会话列表与 subagent 列表都需要发现持久化会话的 header。串行文件检查和 header 读取会让独立的文件系统等待逐次累积，使两个列表都必须等扫描结束才能返回。仅读取 header 避免了大型事件日志的回放，但没有消除整个语料库中重复的打开、读取、解压和关闭操作。

### 观测延迟与测量限制

2026-09-29 的本机诊断捕获到一次耗时 38,338 ms 的 `session/list` 请求。在该请求期间，另一个进程使用相同源码后端和存储根目录，耗时 25,557 ms 扫描了 503 个 header；其下一次扫描耗时 2,095 ms。服务端原生采样中，大多数主线程样本位于 `kevent`，文件工作线程主要位于 `open` 和 `read`。这支持文件访问等待不局限于单个服务进程的内部队列，但未确定造成等待的系统进程或资源。

另一个进程按 `listConcurrency` 值 `1、8、1、8` 比较最终分批实现，读取同一批 508 个 header，并逐次检查所有结果的深度相等性。不注入延迟时，耗时依次为 14,650、80、155 和 71 ms。后一次串行结果在未改变并发数的情况下恢复，因此首次慢结果不能证明系统压力下的并发提速。

同一次比较随后仅在该独立进程的每次 header 读取前注入 2 ms 定时器等待。按相同配置顺序，耗时依次为 1,773、270、2,078 和 306 ms。这些受控等待证明了独立延迟的累积有所减少，而非系统层触发原因被消除；定时器调度和文件系统工作仍包含在实际耗时中。该比较没有修改运行中的服务。

保留的本机记录为 `/tmp/dsh-web-latency-evidence.json`、`/tmp/dsh-slow-stack-results.json`、`/tmp/dsh-slow-server-sample.txt` 和 `/tmp/dsh-final-list-benchmark-results.json`。比较脚本为 `/tmp/dsh-persistence-probe.mts` 与 `/tmp/dsh-final-list-benchmark.mts`。这些本机产物不是仓库 fixture（测试前置数据），也不是可移植的性能保证；上面的测量值保留了本次调度选择所依据的证据。

## 决策

[JSONL 后端](../../../../packages/session/session-persistence-jsonl/src/index.ts) 公开 `listConcurrency`，它是默认值为 `8` 的正整数。Header 发现和共享根编码预检在每个项目内按有界批次读取会话目录。结果保留目录枚举顺序，而非完成顺序。将其设为 `1` 即选择串行发现。

每个批次都会等待已启动的读取全部结束，之后才传播取消或读取失败。观察到任一情况后都不再启动后续批次。因此，列表拒绝时不会遗留已启动的 header 读取或未关闭的 header 句柄。一次性根编码预检仍由调用方共享，不受单个调用方取消的影响；调用方在该预检结束后检查自己的取消信号。

限制作用于单次发现操作，而非后端所有请求的合计并发或 Node 的进程级工作线程池。不同列表调用的合计并发可以超过配置值。本次变更不引入 header 缓存、全局接纳队列、文件格式变更或持久性变更。Header 解码、后缀检查、存储身份校验和重复 id 拒绝仍为必需步骤。

## 考虑过的替代方案

**保持所有目录读取串行。** 同时进行的操作更少，但独立延迟的文件读取会在请求关键路径上累积。受控重叠测试和延迟读取比较支持采用有界重叠，无需先断定系统层触发原因。

**一次启动全部 header 读取。** 不采纳，因为这会让语料库规模决定同时进行的文件和解压工作量。由部署方控制的上限限制了每个请求带来的负载，并允许在必要时使用串行操作。

**缓存 header，替代存储检查。** 延期，因为外部创建、删除、替换和编码变更所需的缓存失效规则是另一项正确性决策。调度既有的权威检查不需要引入陈旧数据策略。

**更改进程工作线程池或禁用后台工作。** 不选择：并发文件系统和压缩操作确实共享资源，但已观测到的独立进程变慢既不能确定服务端独有的线程池问题，也不能确定某个后台任务是原因。本次缓解不改变流式写入、系统服务或进程级工作线程配置。

## 验证

[有界列表测试](../../../../packages/session/session-persistence-jsonl/tests/list-concurrency.spec.ts) 用实例内屏障阻挡真实 header 读取，以验证重叠、配置的单调用上限、目录顺序、取消和失败后的完全停稳、同时进行的列表各自独立限流、读取等待时追加仍可推进、非法配置及重复身份拒绝。这些检查验证调度和清理，不依赖存储速度或实际耗时提速阈值。

既有 [JSONL](../../../../packages/session/session-persistence-jsonl/tests/jsonl.spec.ts) 与 [Zstandard](../../../../packages/session/session-persistence-jsonl/tests/zstd.spec.ts) 测试套件覆盖存储校验和编码行为。尚缺少的是最终实现的匹配慢期性能对照。暖态扫描和确定性屏障不能补足这一证据缺口。

## 影响

独立 header 等待可以重叠，每个批次仍限制文件句柄与解压压力。慢读取仍会拖延其所在批次，取消仍需等待已启动的工作，并发调用方可能增加总 I/O 压力。发现仍是完整语料库操作；快照修订值读取和 API 冷会话摘要工作不受此 header 并发上限控制。

本决策缓解串行延迟放大，不等于确定或修复了间歇发生的系统层原因。它不承诺列表延迟上限，也不要求清理日志、重启服务或禁用其他进程。

## 相关决策

[Zstandard 日志决策](../architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md)仍负责校验和、帧边界、编码归属与仅读取 header 的语义。[Session observation](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md)仍负责精确读取切点、保留的准备结果和基于投影的列表。[有界写入批处理](../architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)仍负责流式写入时机和 flush 持久性。发现调度的变更不取代或归档其中任何一项。
