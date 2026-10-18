# 03_REQUEST_AUDIT · 请求链审计

## 1. 一条前端消息产生多少次 API 请求

80 条有派发的前端消息（attempt）→ 112 次 provider_requests：

| 每消息请求数 | 1 | 2 | 3 | 4 | 7 | 8 | 9 |
|---|---|---:|---:|---:|---:|---:|---:|
| 消息数 | 70 | 4 | 2 | 1 | 1 | 1 | 1 |

（1×70+2×4+3×2+4×1+7×1+8×1+9×1 = 112，与派发行数精确闭合。）

- **87.5% 的消息一次请求即收口**（无工具调用或一次直答）。
- 4 次以上请求的消息全部是三条 `memory_hold → QUOTE_MATCH_FAILED → conversation_read 分页 → 重试` 工具链（7/9/8 次派发，已知费用 $0.347/$0.726/$0.641，合计 $1.714）——根因（引用候选截断 60 条误拒较早原话）已由 `6e48036` 修复（10-17 13:15 PDT），**修复后未再发生同类链**；节省金额未经真实 hold 对照实验验证，归 D 类。
- 重试共 3 次（429/瞬时网络，attempt_no>0 行标 SUPERSEDED_BY_RETRY）：runner 仅在"未发布任何事件"时有界重试 ≤2（Retry-After 封顶 30s），401/402/400 不重试。**无同消息双提交**（HTTP 层 Idempotency-Key + submitUserMessageWithTurn 事务去重）、**无 SSE 断开重复生成**（停止=interrupted 终态，recoveryPass 只落终态不重跑模型）。

## 2. Agent 循环防失控

`runOrToolLoop` 硬上限 `MAX_TOOL_ROUNDS=8`（超限收口 TOOL_ROUNDS_EXCEEDED）；工具执行串行（写操作依赖顺序）；连续工具回合每次重算容量硬门（超安全上界 CAPACITY_BLOCKED_HARD）。**未观察到无意义重复工具执行**；多请求消息均为模型主动连续调用（hold→read→再 hold 的合法序列，误拒是旧缺陷所致，已修）。

## 3. 后台隐藏调用

- `BackgroundScheduler` 三类任务中 `autonomous`/`keepwarm` **默认 enabled=false**（config 面可控）；`reminder` 零模型（直接系统通知）。
- 审计期内 112 次派发全部 purpose=chat（Codex §一 + 本批指纹复核）：**无保温、无自主、无换窗评审请求**。
- keepwarm 若将来启用：单次维护请求 max=1、60min 冷却、聊天抢占（用户消息入库即抢占）、逐笔预算预占——机制上有界。
- 无其他定时模型调用（DS 日结链已于 WP5 退役）。

## 4. 输出费用

交接样本 480 输出 token = $0.012，为正常回复长度（可见回复即全部计费输出，流式 usage 记账帧以最后一帧为准，不重复累计）。reasoning_tokens 是输出子项，不双计（attribution.providerInputTotal 防双算 + usage-normalization 测试覆盖）。**无未返回前端的额外生成、无重复生成**；max_tokens=8192 未动、thinking 档位按 OR 模型元数据生成（1008 批裁定），本批未触碰。

## 5. 逐笔费用对账

107 笔有 usage 的请求与 OpenRouter GET /generation 历史逐笔相符（Codex §一，native 计数口径），合计 $6.8649655；本批独立回算 112 行 prq 的 cost 总和同为 $6.8649655（含 4 笔无 generation 的网络派发按 0 计——费用未知项不以零冒充已核实，Codex §一原文照此口径）。4 笔未知 + 1 笔 402 历史查询 404 为仅有的未闭合项，金额影响预计极小（网络失败未达计费），如实挂账。

## 6. 每消息成本口径（第二阶段验收问题）

回答任务书 2.3 的验收问：一条前端消息的费用 = 该 attempt 名下全部 prq 的 usage 之和（usage_observations.request_id 已逐笔回链，turn/attempt 级汇总由 summaryForTurn 权威口径产出）。本批新增 round_no 落库后（04_FIX_REPORT），"哪笔是首发、哪笔是工具续轮、哪笔是重试"一条 SQL 可答，不再需要按行序推断。
