# Agent Note: 待处理会话收件箱底栏插件

Status: implemented

[English](2026-09-22-attention-inbox-plugin.md) | 中文

## 问题

用户在多个工作区里同时开着许多会话，却没有一个地方能回答"此刻哪几个会话在等我？"。内置侧边栏按行显示状态点（`packages/client/ui-workspace/src/client/rows/Rows.tsx` 的 `sessionStatuses()`），但它们分散在折叠的工作区分组之下，分拣就得逐个展开。完成提醒与待交互提醒的 toast（第三方 `dsh-session-status-alert`）是瞬时的，任务一多就会没看到便滑走。用户需要的两项事实客户端其实已经算出来、只是从未聚合：跑完时未被选中且此后没再打开过的会话（`SessionSummary.completed`，`packages/api/session-controller/src/client/sessions/service.ts:50`），以及卡在审批、计划评审或提问上的会话（`uiSession.pendingInteractions`）。

## 决策

`dsh-attention-inbox` 是一个独立的第三方 Web 插件，唯一源码在 `local-tools/tools/dsh-attention-inbox/plugin/`（没有别处的检出、没有同步步骤；`install.sh` 把该目录 link 进 web profile 并把名字追加到 `dsh.profile.bundles`）。本仓库保存这份设计记录。插件加一个带计数角标的底栏按钮和一个浮层面板，跨工作区平铺列出每个需要用户的会话。

**扩展点。** 只用两个官方 list 插槽：按钮用 `sidebar.footer.action`（声明于 `packages/client/ui-sidebar/src/client/contract/slots.ts:46`，owner props `{ wide }`），面板用 `shell.overlay`（`packages/client/ui-layout/src/client/index.ts:86`，点击穿透层；面板自行开回 pointer events）。两处都经 `ctx.slots.inject(name, () => ctx.slots.register(...))` 注册，这正是 `dsh-session-pin` 已经组合过的一对。不做 DOM 注入，不遮蔽 `sidebar.workspaces`。

**数据源（只读）。** `sessions.list.getSnapshot()` → `SessionListState`（`service.ts:69-80`）：`byId[id]` 带 `displayTitle`、`cwd`、`origin`、`parentId`、`running`、`completed`、`blank`、`updatedAt`；`current` 是当前打开的会话。`uiSession.pendingInteractions.getSnapshot()` → `Map<SessionId, { kind }>`，`kind ∈ approval | plan-review | question`。插件不写任何会话状态，不注册宿主服务。

**派生**——一个纯函数 `computeItems(list, pending, prefs)`：

```text
for each summary in byId:
  skip blank; skip id === current; skip origin === 'subagent' unless prefs.showSubagent
  kind = pending.get(id)?.kind ?? (summary.completed ? 'completed' : undefined)
  skip when kind is undefined
  emit { id, title: displayTitle, workspace: basename(cwd) | '(ungrouped)', kind, updatedAt }
sort: interaction kinds before 'completed'; within a kind by updatedAt descending
```

优先级与侧边栏 `sessionStatuses()` 一致（待交互压过运行中和已完成）。自身没有 `cwd` 的子代理沿 `parentId` 借工作区名。"看过即消失"插件零成本：`SessionManager.select()` 会清掉 `completed` 提醒（`packages/api/session-controller/src/client/sessions/manager.ts:182`），交互一旦处理就从 `pendingInteractions` 移除。

**激活顺序。** 静态 `inject = ['sessions', 'slots']`。`uiSession` 为可选，经 `ctx.inject(['uiSession'], cb)` 接入——它会等到服务就绪再回调，服务离开时回滚；缺席时待交互组为空，完成组照常渲染。apply 时一次性 `ctx.get('sessions')` 正是让 `dsh-session-status-alert@0.2.0` 的"前往"按钮静默失效的那个竞态（它的 inject 只列了 `timer`），故排除。

**界面。** 按钮：16 px 收件箱图标；`wide` 时显示文字"待处理"，`count > 0` 时显示红色计数角标（上限 `99+`）；`aria-pressed` 跟随面板开合。面板：`position: fixed`，底栏之上的左下角，宽 320 px，`max-height: 60vh`；头部含标题、计数、"含子代理"复选框与关闭；两组，"等你处理"（warning 点，每行带种类文字）与"完成未看"（done 点）；行为 `[点] 标题 · 工作区`，`role=button`，Enter/Space/点击 → `sessions.open(id)` 然后关闭；有空态；Escape 与外点关闭（点在插件自己的按钮上被排除，免得 toggle 与关闭互相抵消）。所有颜色走 `--dsw-*` token；zh/en 字典按 `navigator.language` 选择。子代理偏好存 `localStorage`（`dsh.attention-inbox.show-subagent`，默认关）。

**store 与生命周期。** `apply` 内创建的闭包 store——`{ open, showSubagent, rev }`——两个组件都经 `React.useSyncExternalStore` 订阅；列表与待交互的订阅只推 `rev` 让行重算。`ctx.effect` 的释放函数退订 `sessions.list`、退订 `pendingInteractions`（另一半由 `ctx.inject` 回滚负责）并移除样式节点；插槽注册随 fiber 释放。

**构建。** 纯 JS，只 `require('react')`，不 import 任何 `@deepseek-ai/*` 运行时值；`scripts/build.mjs` 把 `src/client.js` 包进 `window.__ModuleLoader__.load({ id, factory })`（`dsh-pinned-section` 用的包装）。`package.json` 声明 `dsh.client { platform: 'web', inject }` 与 `dsh.bundle.patch`；patch 插入 `{ id: attention-inbox, name: dsh-attention-inbox }`。Web 服务按内容哈希从磁盘供插件 bundle，所以 `node scripts/build.mjs` 之后刷新页面即可生效，不必重启 `dsh web`。

因为从面板做出的选中可能落在树已经藏起来的行上，配套改动[在侧边栏树中显露当前会话](2026-09-22-reveal-current-session-in-sidebar.zh.md)让工作区浏览器展开所在组、把行安置进折叠、并滚动到它。

## 曾考虑的替代方案

- **遮蔽 `sidebar.workspaces`，在重实现的工作区浏览器上方渲染常显区块。** 这是把内容放到"新会话"与"工作区"之间的唯一官方途径：侧边栏壳声明了五个插槽，没有一个落在那里。代价是重做搜索、分组、折叠、右键菜单与手动排序，并追踪上游浏览器的每次改动；`dsh-session-activity` 正是这么做的，客户端 bundle 73 KB。对一份个人分拣清单来说不成比例，弃。
- **在 `sidebar.workspaces` 节点前做 DOM 注入**（`dsh-pinned-section` 的做法）。能拿到常显区块又不必重实现，但用户排除了一切不在官方扩展点上的做法，且该技术依赖借来的 CSS Module 类名和一个 body 级 `MutationObserver`。
- **直接安装 `dsh-session-activity`。** 它的 attention-first 排序与 Focus 模式零代码就能近似满足需求，但二级布局仍按工作区分组，清单不是跨项目平铺的。
- **包一层内置 `WorkspaceBrowser` 组件、在收件箱下方渲染它。** 被禁止：功能插件不得运行时导入另一个功能插件的值（`packages/client/AGENTS.md` 的导出纪律）。
- **做成 `packages/experimental/*` 工作区包。** 换来类型检查的插槽与 `SessionSummary` 契约，并省掉 `local-tools` 这一步，但工作量约翻倍（TypeScript、CSS Modules、locale 注册、每文件 100% 覆盖、双语 README，且按 `client-ui-agent-team` + `agent-team-web-profile` 惯例要拆两个包）。用户选择独立形态，设计记录放在这里。
- **家目录下单独检出源码、用 `sync.sh` 镜像进 `local-tools`**（`dsh-pinned-section` 的布局）。被用户否决：所有 DSH 插件的源码都放 `local-tools`，那里的插件目录就是唯一源码，同步步骤随之消失。

## 后果

- 一次点击回答"谁在等我"，跨越所有工作区；行在打开或回答后自行消失，因为两项事实都归宿主所有。
- "完成未看"集合是页内内存（`completedNotifications`，`manager.ts:106`）；刷新会清空该组。v1 接受；v2 可在 host settings 持久化 `{ sessionId: lastSeenAt }`，以 `updatedAt > lastSeenAt && !running` 推导未看。
- `SessionSummary` 字段名与两个插槽契约都是从源码读的，不是发布的类型；上游改名会在运行时而非构建期失败。单测与实机检查是仅有的防线。
- 出错或 goal 被阻塞的会话不会浮现：这两种状态今天都到不了客户端列表 store。
- 面板与 `dsh-session-status-alert` 的分组布局部分重叠；两者并存，因为收件箱是拉（想看时打开），toast 是推。

## 测试

- `plugin/test/items.test.mjs`（`node --test`，9 条）经 stub 的 `window.__ModuleLoader__` 加载构建产物 `lib/client.js`——顺带检查了包装——覆盖：`inject` 恰为 `['sessions', 'slots']`；跳过 blank 与 current；子代理开关与父 `cwd` 回退；待交互压过已完成且组内按 `updatedAt` 排序；未知待交互种类被忽略；`uiSession` 缺席降级为只有完成组；`workspaceOf` 的 basename / 父 / 未分组 / 环安全；`sortItems` 稳定且不改输入；缺列表 → 空。
- `local-tools` 的 `validate-changed --strict` 覆盖该目录：shell 语法、每个 JS 产物 `node --check`、构建产物未过期、以及单测。
- 实机（ego-browser，2026-09-22）：新开页面显示按钮无角标、面板空态；另一个会话打开时一个 35 s 子代理跑完，只在"含子代理"开启后角标变 1，行出现在"完成未看"下并带父会话的工作区名，点击后面板关闭、角标清零；三条真实待处理会话跨 `Vault` 与 `local-tools`，跳到手动收起的组里那条时组重新展开、行被选中、留在树视口内、角标减一。零条可归于本插件的控制台错误。
