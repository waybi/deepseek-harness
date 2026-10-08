# Agent Note: 会话删除

Status: implemented

[English](2026-08-18-session-delete.md) | 中文

## 问题

归档只把会话从分组视图中隐藏，产物和工作区记账都还在。需要真正去掉一段对话的插件或宿主路径没有持久化原语，因此任何删除入口都只能绕过持久化所有者直接删文件。

更早的[会话归档决策](../../archived/feature/2026-07-31-session-archive-global-set.md)有意把纯视觉的 Delete 行改成归档。该决策对「隐藏而不销毁」仍然成立。本笔记在它旁边增加一个独立的销毁原语。

## 决策

**会话删除是持久化原语 `SessionPersistence.delete(id)` 加上 `session-persistence/deleted` 事件。已交付的 RPC 与侧栏行都不调用它；归档仍然是非破坏性隐藏。**

- 持久化：`delete(id)` 为该 id 占用进程内写槽，因此活动写 handle 或待创建者会以 `SessionAlreadyOwnedError` 拒绝。未知 id 以 `SessionPersistenceNotFoundError` 拒绝。成功后该 id 对之后的 `stat`、`list` 与 `open` 都视为未知，且可以再次创建。串行化来自这一所有权互斥，没有单独的删除队列。
- JSONL 后端：占用写槽后，`delete` 获取会话目录的内核租约，因此其他进程的写者会以 `SessionAlreadyOwnedError` 拒绝。随后删除会话目录并丢弃冷日志缓存。租约与写槽在任何结果下都会释放；只有删除成功后才发出 `session-persistence/deleted`。
- 工作区：注册表监听 `session-persistence/deleted`，从 header 索引、每个工作区记账和归档集合中忘掉该 id。工作区注册删除仍然绝不触碰会话日志（[工作区注册删除](../../archived/feature/2026-07-27-workspace-registration-deletion.md)）。

## 已考虑的替代方案

**把归档当作删除。** 否决：归档是隐藏而不销毁。合并二者会让误触不可逆，也会卡住未来的取消归档入口。

**取消待创建的会话而不是拒绝。** 否决：在基于 handle 的持久化 seam 上，待创建会话由其创建者 handle 持有。关闭该 handle 已经会抹掉待创建会话，因此删除不去触碰另一个所有者的状态。

**由插件直接删除文件。** 否决：绕过持久化所有者会与进行中的追加竞争，并让派生索引继续持有该 id。

## 后果

删除是永久的：日志、工作区记账和归档成员资格都会消失。调用方必须先关闭自己的写 handle 再删除。持久化契约测试对两种 JSONL 编码钉住删除、未知 id 拒绝、所有者拒绝与 id 复用；JSONL 租约测试钉住跨进程拒绝、事件发出以及删除失败后的释放。
