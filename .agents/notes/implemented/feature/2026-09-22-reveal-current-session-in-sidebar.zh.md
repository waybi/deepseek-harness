# Agent Note: 在侧边栏树中显露当前会话

Status: implemented

[English](2026-09-22-reveal-current-session-in-sidebar.md) | 中文

## 问题

从会话自己的侧边栏行之外的任何地方选中它——完成 toast 的"前往"按钮、跨工作区收件箱、搜索、键盘导航——会切换对话，却可能让侧边栏那一行不可见。`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` 里三层彼此独立的机制把它藏起来：用户曾经收起过的组，在其中的会话变为当前时仍保持收起（自动展开效果被 `Object.hasOwn(groupExpansion, currentGroup)` 守卫拦住）；五行溢出折叠按位置截断、从不检查 `current`，所以第六条及之后的行即使被选中也留在"展开其余 N 个"后面；没有任何东西滚动这棵树。第三方插件无法从外部修补——`groupExpansion` 是插槽私有 store（`index.ts:142`），溢出折叠是组件 `useState`，也没有服务暴露 reveal。

## 决策

工作区浏览器**在 `current` 变化时**显露当前会话，且仅在那时。一次选中变化会展开所在组、把选中行安置进折叠切片、并把行滚进视口。之后用户收起组或折叠仍然生效：效果键在选中变化上，不键在渲染上，所以用户可以收起当前会话所在的组，它会一直收起直到下一次选中。

`rows/WorkspaceBrowser.tsx` 里三个机制：

- **分组。** reveal 效果以依赖列表 `[current, currentGroup]`——刻意不含 `groupExpansion`——执行 `setGroupExpanded(currentGroup, true)`，使它每次选中变化只触发一次，且不与随后的手动收起打架。
- **折叠。** `collapsedSessionRows(sessions, current)` 把当前行留在 `rows` 里。当前行在 `COLLAPSED_SESSION_LIMIT`（5）之后时，它占最后一个可见名额、第五条普通行让位，可见行数与"展开其余 N 个"的数字都不变；已在前五时折叠不动。不涉及 `sessionsExpanded` 状态。
- **滚动。** 树容器上一个 ref 加 `scrollPending`（在 `[current]` 效果里用新 `current` 上膛）。一个无依赖的效果每次渲染后运行：`scrollPending` 有值且树内存在 `[role="treeitem"][aria-selected="true"]` 时，解除并在 `typeof` 守卫后调 `scrollIntoView({ block: 'nearest' })`（`/* v8 ignore */`，`ui-trajectory` 的写法）。逐渲染重试正是为了跨过选中变化与分组展开落地之间那一轮渲染的间隙。

平铺"单列表"模式没有分组和折叠；那里只适用滚动。

## 曾考虑的替代方案

- **让当前组永远保持展开。** 最简单，但会使含当前会话的组无法收起——"keeps an already-expanded group when the selection moves within it"这条测试正是为了保住这个自由。弃。
- **在五行预算之上额外加当前行**（六条可见行）。第一版实现；弃，因为它让可见行数随选中变化，并打破了"keeps the blank New Session outside the five-row folding quota"——那条测试钉住了当前行要占一个名额。"占位"替代了"加行"。
- **由消费方（插件）通过 DOM `scrollIntoView` 显露。** 只解决滚动，被分组或折叠藏起来的行不在 DOM 里、无从滚动。这也是本部署的侧边栏插件正在远离的 DOM 注入风格。
- **在工作区浏览器 store 或服务上暴露 `revealSession(id)` 动作。** 为一个消费方的便利增加公开接口；浏览器已经知道 `current`，自己就做对了。除非有消费方需要"不改选中只显露"，否则推迟。
- **整个展开折叠（`setExpandedSessionGroups`）而不是只安置那一行。** 能显露该行，但同时显露其他所有隐藏行，让组高度因无关原因变化。

## 后果

- 树外做出的任何选中现在都落在可见、高亮、在视口内的行上：`dsh-session-status-alert` 的"前往"按钮、`dsh-attention-inbox`（[note](2026-09-22-attention-inbox-plugin.zh.md)）、搜索结果、键盘导航彼此不知情地一起受益。
- "变化时显露"规则也覆盖经宿主投影成为当前的会话（重载时恢复的选中）：其所在组在首次渲染时展开，包括此前被收起的组。此前只有无记录状态的组会自动展开。
- 侧边栏 ARIA golden 未变：没有已提交的 fixture 把选中会话种在折叠之后或收起组内。将来若有，会在选中处多出一行。
- `scrollIntoView({ block: 'nearest' })` 只滚动树列表；它是侧边栏列里唯一的滚动容器。

## 测试

- `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`："keeps the current session visible past the fold by giving it the last seat"（八行，current 为第三 → 折叠不动；current 为第八 → 行 1–4 + 8，"展开其余 3 个"不变，`aria-selected`）；"re-expands a manually collapsed group when the selection moves into it, and stays collapsible afterwards"（手动收起 alpha，`current` 移入 alpha → 展开；再收起 → 隐藏）；"scrolls the selected row into view once it renders (armed on selection change)"（用 `Object.defineProperty` 装、`Reflect.deleteProperty` 卸一个记录用的 `scrollIntoView`，因为 jsdom 没有：每次选中变化恰好一次调用，无关重渲染零次）。既有的"keeps an already-expanded group when the selection moves within it"与"keeps the blank New Session outside the five-row folding quota"保持绿。
- `pnpm run test:gui`：282 文件、3908 测试绿；`ui-workspace/src` 每文件覆盖 100%。
- `DSH_SNAPSHOT=replay pnpm run test:web:built`：91/93 文件绿；唯一失败（`message-actions.e2e.ts` 对话 golden，Read 工具行）是本改动之前已存在的对话区漂移，与侧边栏无关。
- 实机：从 `dsh-attention-inbox` 面板打开手动收起的 `local-tools` 组里的会话，组重新展开、行被选中（`aria-selected="true"`）且落在树的 `boundingBox` 内（ego-browser，2026-09-22）。
