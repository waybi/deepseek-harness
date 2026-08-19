# Agent Note: 会话删除

Status: implemented

[English](2026-08-18-session-delete.md) | 中文

## 问题

侧栏会话菜单可以归档一行，但不能销毁其日志。归档只把会话从分组视图中隐藏，产物和工作区记账都还在。想真正去掉一段对话的用户没有产品路径。持久化 seam 也没有删除原语，因此任何 GUI 入口都会是假的。

更早的[会话归档决策](2026-07-31-session-archive-global-set.md)有意把纯视觉的 Delete 行改成归档。该决策对「隐藏而不销毁」仍然成立。本笔记在它旁边增加一条需确认的销毁路径。

## 决策

**会话删除是持久化原语加上宿主持有的 `session.delete` RPC。侧栏菜单把它做成一条 danger 行，并打开确认对话框。归档仍然是非破坏性隐藏。**

- 持久化：`SessionPersistence.delete(id)` 走每 id 写链串行。未知 id 拒绝。未实体化的 create 意图会被取消并成功返回。活动持久化所有者拒绝。成功后该 id 对后续所有操作都视为未知，协调器发出 `session-persistence/deleted`。
- 后端：JSONL 删除会话目录（产物及同目录文件）。SQLite 删除 `sessions` 行并由外键级联删除事件。两者在没有产物时返回 false，以便协调器区分未知 id 与已取消意图。
- 工作区：注册表监听 `session-persistence/deleted`，从 header 索引、每个工作区记账和归档集合中忘掉该 id。工作区注册删除仍然绝不触碰会话日志（[工作区注册删除](2026-07-27-workspace-registration-deletion.md)）。
- RPC：`session.delete({ sessionId, recursive? }) → { deleted: true }`。GUI 始终发送 `recursive: true`，因为侧栏行会隐藏 `origin: 'subagent'` 子会话。非递归请求若仍有 `parentSession` 后代，则以 `session-has-descendants` 失败。未知 id 以 `session-not-found` 失败。本宿主无法释放的活动会话以 `agent-busy` 失败。
- 活动拆卸：API 代理保留它创建／恢复／分叉的每个 `AgentHandle`，并在持久化删除前自底向上 dispose。可继续后代先经 `subagents.drainContinuableDescendants` 排空。活动但没有自有 handle 的会话会被拒绝，而不是泄漏。
- 客户端：`ctx.sessions.delete(id)` 以 `recursive: true` 调用 RPC，并在 unary 回声上立刻丢掉该行，使侧栏不必等待 `host/session-removed`。冷删除也会从 `session-persistence/deleted` 推送该帧，使其他标签页收敛。
- UI：会话菜单保留归档（非 danger，无对话框），并增加删除会话（danger，需确认）。对话框由浏览器持有，因此成功移除可以卸载该行而不拆掉进行中的确认状态。删除当前会话会清空选中项，规则与已有的 `host/session-removed` 变更相同。

## 已考虑的替代方案

**把归档当作删除。** 否决：归档是隐藏而不销毁。合并二者会让误触不可逆，也会卡住未来的取消归档入口。

**拒绝任何活动会话。** 否决：打开一个会话就会让它在宿主重启前无法删除，因为 web 宿主会保留 agent。产品路径必须先 dispose 自有 handle，再删除。

**在 `AgentRegistry` 上增加 `dispose(id)`。** 否决：dispose 是 `AgentHandle` 上的消费方能力。API 代理已经创建这些 handle；保留它们即可维持现有所有权规则。

**用宿主侧过滤代替列表变更。** 否决：删除会移除持久身份。客户端列表必须丢掉该行，而不是隐藏它。

## 后果

归档和删除现在并列在同一菜单里。归档仍无恢复入口。删除是永久的：日志、工作区记账和归档成员资格都会消失。GUI 的递归删除也会销毁被隐藏的子代理会话；确认文案说明了这一点。在本 API 代理之外创建的活动会话（例如排空后仍只由继续执行管理器持有的可继续子会话）仍可能返回 `agent-busy`。持久化契约测试钉住未知 id 拒绝、意图取消和 id 复用。workspace-management e2e 钉住 GUI 链路（菜单 → 确认 → 行消失 → 日志消失）。
