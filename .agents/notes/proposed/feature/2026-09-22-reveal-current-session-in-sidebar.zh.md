# Agent Note: 在侧边栏树中显露当前会话

Status: proposed

[English](2026-09-22-reveal-current-session-in-sidebar.md) | 中文

## 问题

从会话自己的侧边栏行之外的任何地方选中它——完成 toast 的"前往"按钮、跨工作区收件箱、搜索、键盘导航——会切换对话，却可能让侧边栏那一行不可见。`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` 里三层彼此独立的机制把它藏起来：

1. **分组折叠。** 当前组只在没有记录过展开状态时自动展开（第 291 行附近 `useEffect` 里的 `Object.hasOwn(groupExpansion, currentGroup)` 守卫）。用户曾经收起过的组，在其中的会话变为当前时仍保持收起。
2. **行溢出折叠。** 每个展开的组渲染前 `COLLAPSED_SESSION_LIMIT = 5` 条普通行和一个"展开其余 N 个"按钮（`collapsedSessionRows()`，第 44 行）。折叠按位置截断，从不检查 `current`，所以第六条及之后的行即使被选中也留在按钮后面。
3. **滚动。** 没有任何东西滚动这棵树；包内不出现 `scrollIntoView`。

用户看到的结果：对话面板换了，组头染色了，行本身却在屏幕外或根本不存在。第三方插件无法从外部修补——`groupExpansion` 是插槽私有 store（`index.ts:142`），溢出折叠是组件 `useState`（`setExpandedSessionGroups`），也没有服务暴露 reveal。

## 提案

让工作区浏览器**在 `current` 变化时**显露当前会话，且仅在那时。一次选中变化会展开所在组、把选中行纳入折叠切片、并把行滚进视口。之后用户收起组或折叠仍然生效：效果键在选中变化上，不键在渲染上，所以用户可以收起当前会话所在的组，它会一直收起直到下一次选中。

具体是 `WorkspaceBrowser.tsx` 里三处改动：

- **分组。** 去掉 `hasOwn` 守卫；在一个依赖列表为 `[current, currentGroup]`（不含 `groupExpansion`）的效果里执行 `setGroupExpanded(currentGroup, true)`，使它每次选中变化只触发一次，且不与随后的手动收起打架。既有测试"keeps an already-expanded group when the selection moves within it"钉住了选中后手动收起仍然生效。
- **折叠。** 把 `current` 传进 `collapsedSessionRows(sessions, current)`：选中行总在 `rows` 里；普通行预算仍放进前五条其他行，`hiddenCount` 数其余的。`sessionsExpanded` 状态不动，"展开其余 N 个"含义不变。
- **滚动。** 选中变化渲染完成后，在列表容器内找 `[role="treeitem"][aria-selected="true"]` 并调 `scrollIntoView({ block: 'nearest' })`，用 `typeof row.scrollIntoView === 'function'` 守卫并加仓库惯用的 `/* v8 ignore next -- jsdom lacks scrollIntoView */` 标记（`ui-trajectory/src/client/TrajectoryTable.tsx` 的写法）。分组展开是一次状态更新、下一轮渲染才落地，所以滚动效果在 `current` 变化时用 ref 上膛，每次渲染重试直到行存在，然后解除。

平铺"单列表"模式没有分组和折叠；那里只适用滚动这一处改动。

## 曾考虑的替代方案

- **让当前组永远保持展开。** 最简单，但会使含当前会话的组无法收起——"keeps an already-expanded group when the selection moves within it"这条测试正是为了保住这个自由。弃。
- **由消费方（插件）通过 DOM `scrollIntoView` 显露。** 只解决第 3 层，被第 1、2 层藏起来的行不在 DOM 里、无从滚动。这也是本部署的侧边栏插件正在远离的 DOM 注入风格。
- **在工作区浏览器 store 或服务上暴露 `revealSession(id)` 动作。** 为一个消费方的便利增加公开接口；浏览器已经知道 `current`，自己就能做对。除非有消费方需要"不改选中只显露"，否则推迟。
- **整个展开折叠（`setExpandedSessionGroups`）而不是只纳入那一行。** 能显露该行，但同时显露其他所有隐藏行，让组高度因无关原因变化。只纳入选中行是更小的视觉变化。

## 验收标准

- 一个组已手动收起时，从 toast/收件箱打开其中的会话会展开该组且该行可见；之后点组头再收起，行消失（既有测试仍绿）。
- 八个会话的组里打开第八个，它作为第六条可见行出现且显示"展开其余 2 个"；打开第三个，折叠仍显示"展开其余 3 个"。
- 在长列表中选中会话，树滚动到该行在视口内（Playwright：`boundingBox` 落在列表 `boundingBox` 内）。
- `pnpm run test:gui` 绿；`DSH_SNAPSHOT=replay pnpm run test:web` 绿，或当某侧边栏 golden 因"此前隐藏的选中行现在渲染出来"而合理变化时，刷新它并在说明里点出。

## 风险

- 把选中会话种在折叠之后的侧边栏 ARIA golden 会变化（多出一行）。每处刷新必须在 PR 里解释。
- 对滚动容器内的行调 `scrollIntoView({ block: 'nearest' })` 在某些浏览器里也可能滚动外层祖先；列表是该列唯一的滚动容器，预期无可观察影响，但 Playwright 检查钉住它。
- "变化时显露"规则意味着经宿主投影成为当前的会话（如重载时恢复的选中）也会在首次渲染时展开其所在组。这与旧行为在无记录状态的组上一致，现在也适用于此前被收起的组。
