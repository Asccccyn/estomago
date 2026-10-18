# 01_BASELINE · 基线锁定

审计批：`estomago-cost-20261018`（执行：程知行/GLM，任务书：她转林石见 2026-10-18 执行书）
前置审计：Codex《estómago：OpenRouter 费用审计》2026-10-17（账单快照截止 20:22:27 UTC / 13:22:27 PDT）——本批不重复其对账，以独立指纹复核其结论后转入代码侧落地。

## 1. 工作区状态（本批开工时）

- 分支 `main`，HEAD `bb5e7b1`。
- 他人未提交改动（**保留未动**，vision 批次半成品，与本批不同区域）：
  `apps/host/src/media/model-input.ts`、`apps/host/src/runtime/supervisor.ts`（仅 L2152 附近一行传参）、
  `apps/web/dist/chat-app.js`、`apps/web/react/src/chat-client.ts`、4 个 web/react 测试文件、
  未跟踪 `tests/unit/vision-support-cache.test.ts`。
- 本批提交只含自己的 hunks（`git apply --cached` 精确暂存，AGENTS §7）。

## 2. 生产状态

- launchd `online.charstarearth.estomago` 在线（本批开工时 PID 22585），launchd 日志最后写入 2026-10-18 00:20（本地）。
- **审计截止（10-17 20:22 UTC）后生产无任何新模型派发**：`usage_observations` 最新一条即 Codex 报告收尾样本（$0.052412）。数据面基线 = Codex 审计的 112 次派发。
- 本批**未重启生产、未部署**（任务书第九阶段：部署待她批准）。生产进程载入的是上次 kickstart 时的工作树快照；v28 迁移将在下次重启时自动应用（见 07_ROLLBACK）。

## 3. 上一轮修复在位确认

| 修复 | 提交 | 本批核验 |
|---|---|---|
| Bedrock 供应商误删 Claude 缓存标记（模型族由 `anthropic/` 前缀判断，非供应商名） | `2e7447f` 批 | `apps/host/src/runtime/or-payload.ts:70-74` 在位；显式尾点路径 L86-115 在位 |
| 引用误拒后的重复回读（候选截断 60 条） | `6e48036`（10-17 13:15 PDT） | 在 main，配 `tests/unit/quote-seen-scope.test.ts` |

## 4. 调用链（实际代码映射）

```
前端 chat-client.ts ── POST /api/v1/conversations/:id/messages（Idempotency-Key）
  → server/http.ts handleRequest L227-289
  → messages/service.ts submitUserMessageWithTurn（事务：message+turn+attempt+幂等）
  → supervisor enqueue → runSerialized → runTurn L1609
      ├─ buildTimeContext（time/context.ts）——动态时间，注入**尾部** user 消息，不进 system 前缀
      ├─ identity.loadVerifiedMaterials——A 段正文（身份+规则+I）
      ├─ windowBootstrap L646——B 段（Mariposa 开窗资料，成功才进进程缓存）
      ├─ 轨迹正本 window-trajectories + catchupEntries + 人工选集 → messages
      ├─ cache-plan.planBoundaries——A/B/G 断点
      └─ runOrToolLoop L329（round 0..8，MAX_TOOL_ROUNDS=8）
           ├─ INSERT provider_requests（每轮一行；重试尝试另插行 attempt_no>0）
           ├─ runner-openrouter → buildOrPayload（A/B/G+Bedrock 显式尾点，ephemeral 1h，
           │    provider.only=amazon-bedrock，assertAppendOnly 前缀断言）
           ├─ or-sse 记账帧 x.usage → usage_observations（request 级，回链 prq）
           └─ tool_use → HostToolExecutor → 结果 append → 下一轮（同窗冻结 tools）
```

后台旁路：`BackgroundScheduler`（15s tick）→ autonomous/keepwarm → `runBackgroundTurn` 复用 runOrToolLoop，费用按 background_dispatches 逐笔结算。**默认 autonomous/keepwarm 关闭**；审计期内无后台派发（Codex §一 + 本批指纹复核一致）。

## 5. 现行缓存实现（代码事实）

- 断点：A=system[0] 末块、B=system[1]（开窗资料）末块、G=上次已发送尾界（≤3 显式）+ Bedrock 显式尾点（合计 ≤4），全部 `{type:'ephemeral', ttl:'1h'}`（or-payload.ts L8-9、cache-plan.ts）。
- 前缀守卫：`assertAppendOnly`（model/session_id/provider/tools 四键逐键等值 + messages 只追加，or-payload.ts L134-151）；工具按窗冻结（`frozenToolsByWindow`，supervisor.ts L958-965，F-J-09）。
- 关键控制字段（provider 固定/压缩插件禁用/stream）由 buildOrPayload 固定，调用方不可覆盖。

## 6. 计费追踪现状（第二阶段差距分析）

已有：`usage_observations`（逐笔记 input/output/cache_read/cache_creation/cost_usd/reasoning/anomalies/raw_json，scope=request/turn/cumulative，回链 request_id→provider_requests）、`provider_requests`（purpose 四分类、attempt_no、generation_id、payload_json 内部投影、payload_wire_json wire 证据）、turn↔attempt↔prq 外键链。

缺口（本批补齐，见 04_FIX_REPORT）：
1. 工具循环轮次（round）未落库——"哪次派发是工具续轮"只能靠同 attempt 行数推断。
2. 上下文指纹（tools/A 段/B 段/messages hash、断点位置）无内生列——审计需逐笔解析 MB 级 payload_wire_json（Codex 审计与 02 号文档的回算就是这么做的）。
3. 缓存写入 1h/5m 分型：OR 不在 usage 里区分 TTL；请求侧全量 1h（or-payload 固定），按请求参数即可归类，无缺失字段可记 null。
