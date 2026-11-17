# 决策：阶段 A 渲染与路由方案

## 结论
**不新增渲染库**（任务书允许二选一新增 lit-html / preact+htm，本阶段不需要）。

## 原因
整树重渲染的根因不是缺模板库，而是「每次 dispatch 都重建所有节点」。把页面节点改成
「创建一次、局部更新」即可解决，现有 `el()` 工具足够。引入模板库会同时改写全部视图，
违背「小步快跑」。若阶段 C 重做界面时局部更新写起来太啰嗦，再单独评估 lit-html 并另写决策。

## 模型
- `core/nav.ts`（纯函数）：页面栈 `pages` + 浮层栈 `layers`。`back()` = 先弹浮层、再弹页面；到底才退出应用。
- `state.nav` 是唯一导航事实；action：`nav/tab`、`nav/push`、`nav/back`、`layer/opened`、`layer/closed`。
- `views/app.ts` 的 `createAppHost`：DOM 里只挂栈顶页；栈内其它页作为脱离文档节点缓存（回来时原样挂回）；按页记忆滚动位置。
- `views/reader.ts`：外壳与 `<article>` 创建一次；仅「RenderResult 换了」或「长按查词开关变了」才换 article（`data-gen` 递增，测试据此断言）。勾选只原地改属性。
- `views/layers.ts`：浮层宿主，让 DOM 与 `nav.layers` 一致。查词卡片登记为 `lookup` 层，返回键先关它。
- hash 仅作镜像（保留 `#/settings` 深链），用 `replaceState` 写，不触发 hashchange。
- 系统返回键与应用内返回都是 `dispatch({type:'nav/back'})`，手写优先级链已删除。
