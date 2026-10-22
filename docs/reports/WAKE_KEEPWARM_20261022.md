# WAKE_KEEPWARM_V1 交付报告（GLM · 程知行）

施工包：`ESTOMAGO_WAKE_KEEPWARM_GLM_20261022`（她 2026-10-22 交付，83 个验收场景）。
本报告按包内 `templates/GLM_DELIVERY_REPORT.md` 结构填写，区分"代码存在"与"生产可用"（双态口径）。

## 实现基线

- 开工 HEAD `2d77699`（包基线 `04fac69` 之后已有白名单批 `bd677ed`/`2d77699`，无冲突；开工前工作树为空）
- 分支 `wake-keepwarm-20261022`（本地；**未合 main、未 push**——与匿名化远端 691c954 分叉绝不 push）
- 提交：`181dcd5`（服务端主体）→ `06db6cc`（验收矩阵+HTTP 合同+前端）
- **施工期间另一路代理在 main 追加了 `35da6fc`（docs only：README+部署报告）**：与本批无文件级冲突，README 追加行合并时需手工对齐（AGENTS 规 7 已遵守——只 add 本路文件）
- schema 迁移：v33 `wake_keepwarm_activity_and_operations`（`background_tasks.origin/control_reason/client_operation_key`、`background_runs.turn_id/input_activity_revision/retention/trajectory_committed_at/published_message_count/tool_calls_observed`、新表 `conversation_activity`/`background_operations`；repair=旧任务隔离+L 投影一次性重建）
- 触碰文件与职责：
  - 新增 `runtime/wake-activity.ts`（L 锚点/维护回执 CAS/保温目标）、`runtime/background-task-service.ts`（预约正本：幂等/CAS/校验）
  - `runtime/background-policy.ts`（冷却与心跳封锁退役；keepwarmAdmission 重写）、`runtime/background-scheduler.ts`（tick 单飞/领取≠消耗/occurrence 语义/按来源让位/结算幂等）
  - `runtime/supervisor.ts`（enqueueBackground 串行入口；runBackgroundTurn 重写：执行位重检/轨迹正本复用/note 全文/PURE_ACK·SUBSTANTIVE 分流/真实预占/心跳让位/satisfied_by_request；catchup 纳入后台回合；工具派发记账）
  - `runtime/host-tools.ts`（wake_manage 目录项+实现；chat_send_text/background_complete 放行心跳 purpose）、`messages/service.ts`（发布事务内更新投影）、`db/migrations.ts`（v33）、`app-context.ts`（装配：串行链接线/投影注入/单一正本）、`server/http.ts`（任务管理转 service；瘦返回；runs JOIN 取 trigger_origin）、`config/policy-constants.ts`（封锁常量退役）
  - 前端：`apps/web/react/src/BackgroundControls.tsx`（新）、`chat-client.ts`（background 方法组）、`App.tsx`（"更多"菜单入口）

## 需求与验收对应（fixtures/acceptance_cases 83 项 → 实际落点）

实现按六组映射；标 NOT_RUN 的为未在本轮 L2 落地的项。

| 组 | 落点（测试文件 :: 用例） | 状态 |
|---|---|---|
| W-01..W-20 | `wake-keepwarm.test.ts`（W-05/06/08/09/10/11/18/19/20）+ `exec-v1-wp4-background.test.ts`（W-02/W-05 调度级无冷却/短间隔/once 完结）+ `exec-v1-wp4-http.test.ts`（HTTP 面） | 已实现（W-03/W-04/W-07/W-12/W-13/W-14/W-15/W-16/W-17 见下"边界"） |
| K-01..K-18 | `wake-keepwarm.test.ts`（K-02/03/04/05/06/07/09/10/11/16）+ `exec-v1-wp4-executor.test.ts`（K-01/K-12/K-13） | 已实现（K-08/K-14/K-15/K-17/K-18 见下） |
| S-01..S-09 | `wake-keepwarm.test.ts`（S-01/S-03）+ `exec-v1-wp4-background.test.ts`（S-05/S-02 面）+ `exec-v1-wp4-executor.test.ts`（S-07 面：终态拒新派发） | 部分实现（S-04/S-06/S-08/S-09 见下） |
| C-01..C-16 | `exec-v1-wp4-executor.test.ts`（C-01/C-02/C-07/C-12 面） | 部分实现（C-03..C-06/C-08..C-11/C-13..C-16 见下） |
| B-01..B-10 | `wake-keepwarm.test.ts`（B-03/B-08/B-09）+ `exec-v1-wp4-executor.test.ts`（B-01/B-10）+ `exec-v1-wp4-background.test.ts`（预算门） | 部分实现（B-02/B-04..B-07 见下） |
| A-01..A-10 | `wake-keepwarm.test.ts`（A-01）+ `exec-v1-wp4-http.test.ts`（A-02/A-03/A-05 面/A-06） | 部分实现（A-04/A-07..A-10 见下） |

### 未在本轮单测逐一落地、但由实现结构覆盖或需真机的项（如实标注）

- W-03/W-04（聊天中到点/用户持续在场排队不饥饿）：由会话串行链 FIFO 结构保证（`enqueueBackground` 与用户 `enqueue` 同链）；S-01 单执行断言旁证。未写独立并发剧本测试。
- W-07（note 不直接发布）：host 事件走尾部 user 载体（supervisor 尾注），不调 `publishAssistantMessage`；executor 测试断言消息数不变旁证。
- W-12/W-13（跨窗/等待选集）：执行位重检含 `CONTEXT_SELECTION_REQUIRED`（选集 awaiting→零派发）与活动窗重读；未写换窗剧本。
- W-14/W-15/W-16/W-17（恢复四态）：`exec-v1-wp4-background.test.ts`（CW-12/W-14 恢复+unknown 预占）；W-16 关闭错过→`disabled_missed_needs_review`（调度器实现，未单测）；W-17 迟到递送=恢复后 due 过期即领取+尾注含 Actual delivery（实现存在，未单测）。
- K-08/K-14/K-15/K-17/K-18：K-14 已冷门在 runBackgroundTurn（CACHE_ALREADY_COLD 零派发）+policy 单测；K-15 同到期自主优先=policy 单测+tick 顺序；K-17 无固定闲置停机=无该代码路径（policy 无 24h 常量）；K-08/K-18 由投影只认服务端发布字段结构性保证（无"浏览器重连写 L"的路径）。
- S-04（预占与 transport 间关闭）：recordDispatchStart 检查 cancelRequested+终态；未写时序剧本。
- S-06（心跳让位保留已写回执）：实现=工具边界让位+回执保留（KEEPWARM_YIELDED_DURING_TOOLS completed 收口）；S-05 测试断言让位集语义。
- S-08（128k 不强制换窗）：本批未改容量策略（U09 红线——软/硬门原样）；结构性满足。
- S-09（时钟回拨）：`clockRegressionAction` 保留+测试在旧文件覆盖；恢复水位=lastTickMs 机制原样。
- C-03..C-06/C-13..C-16：C-04/C-05 由 window_toolsets 冻结机制结构性保证（wake_manage 只进新窗 catalog——`buildHostTools()` 快照）；C-06 轨迹正本复用实现存在；C-13 background_complete 放行心跳 purpose（实现+purpose 断言）；C-15 无身份伪造=owner 正文永远走消息链不走 host 事件（结构性）；C-16 断点规划沿用 planBoundaries。
- B-02（跨 run 日聚合）：settleDispatch 幂等+dispatch 表 reserved/actual 口径已实现；**跨 run SUM 日占用门在 onBeforeDispatch 尚未接完整 SQL 聚合**（当前预占按 run 累计+cap 检查在 budgetGate；日级全局聚合属收尾项）。
- B-04..B-07：B-04 重试逐笔记账（onBeforeDispatch 每 attempt 一次 recordDispatch）实现；B-05 unknown 保留（结算 state=unknown+预占不释放）实现；B-06 工具费用归属 keepwarm（dispatch 表随 run 归属）实现；B-07 工具 0 预占+幂等（tool dispatch 记账）实现——均未逐一写独立断言。
- A-04（前端未知态）：BackgroundControls 加载中显示"不预设开启"；未做浏览器 DOM 实测（见 TEST_EVIDENCE）。
- A-07/A-08/A-09/A-10：A-09/A-10 由 run-tests 保险丝+fake transport 结构保证；A-07/A-08 属 UI 实测项。

## TEST_EVIDENCE

命令与退出码（2026-10-22，全部前台/后台串行，`ESTOMAGO_HOME` 指向临时目录——生产根保险丝要求显式隔离）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 错误） |
| `npm run typecheck:web` + `npm run build:web` | 通过（chat-app.js 319.73 kB） |
| `npm test -- --unit --file=tests/unit/wake-keepwarm.test.ts` | 14/14 通过 |
| `npm test -- --unit --file=tests/unit/exec-v1-wp4-executor.test.ts` | 3/3 通过 |
| `npm test -- --unit --file=tests/unit/exec-v1-wp4-background.test.ts` | 10/10 通过 |
| `npm test -- --unit --file=tests/unit/exec-v1-wp0-base.test.ts` | 通过（常量退役断言更新后） |
| `npm test -- --integration --file=tests/integration/exec-v1-wp4-http.test.ts` | 3/3 通过 |
| 前端 DOM 实测（浏览器，临时 Host=mock provider+隔离根，127.0.0.1:59001） | 通过：更多菜单出现"自主预约与保温"入口；面板完整渲染（两开关/心跳排程空态/任务空态/代建表单/最近运行/边界说明）；默认关闭态正确；无预算开自主→422 提示+checkbox 回滚；配预算开启→checked；创建预约→列表出现（含时间）；详情+取消→列表项转"已取消"；刷新+重开面板 window.onerror/unhandledrejection 零捕获 |
| `npm test -- --unit`（全量 123 文件） | 114/123 通过、9 文件失败（15 个用例）——**基线对照：与开工基线 `35da6fc` 完全一致，零新增失败** |
| 基线对照命令 | `git checkout 35da6fc && npm test -- --unit --file=...`（9 文件逐个）：失败数逐一相同（4/1/1/1/1/2/2/1/2） |
| `npm test`（unit+contract+integration 全量） | 见文末补记 |

15 个既有失败用例属于白名单批（`bd677ed`/`2d77699`，模型输出白名单/MCP JSON 投影相关——words-channel 找话①②、envelope-golden R09-E 基线、joint-audit-b1 F-J-54、d2-gj01、remediation-batch2 F14、consumption-ops 2、review-r01 2、cross-contract 2、context-rotation-root M02），与本批改动无交集文件；本批触碰的测试文件全部通过。既有失败的修复归属另一路批次，本报告不代修（AGENTS 规 7：不卷他人半成品）。

fake 网络范围：所有 L2 测试经 `OrTransport` 假传输（loopback）/`BackgroundScheduler` 假 executor；无真实 provider、无兄弟项目调用（A-09 保险丝+测试注入隔离）。

L1（包内 reference Python oracle）29 项通过为包作者记录；本轮未重跑、未作为产品证据。

## API_CONTRACT_DIFF

- `GET /api/v1/background/settings`：返回瘦化（两个开关+revision+就绪+keepwarm 派生状态：next_keepwarm_at/basis/cache_status/last_real_activity_at）；不再下发整份 policy 数值。
- `GET/POST /api/v1/background/tasks`、`GET/PUT/DELETE /api/v1/background/tasks/{id}`：任务管理全部转 `BackgroundTaskService`——POST 自主预约体=`{note, at|delay_seconds}`（`kind:'reminder'` 保留旧体直建）；PUT/DELETE 必带 `If-Match`（缺=428、错=409）；**取消递增 revision**；响应含 `task_id/revision/scheduled_at/duplicate`；列表分页 `next_cursor`、短预览（全文走详情端点）。
- `GET /api/v1/background/runs`：瘦返回+`trigger_origin`（self_wake/keepwarm/legacy，从 task origin JOIN 派生）+`retention/published_message_count/tool_calls_observed`；不含 payload/工具 JSON/reasoning/聊天正文。
- 错误码：`self_wake_disabled/wake_time_invalid/wake_time_in_past(+server_now)/idempotency_conflict/revision_conflict(+current_revision)/task_not_found`。
- 普通 reminder 兼容：once/daily 保留；旧 interval 自主任务由迁移标 `needs_review` 停用（不静默转换）。
- 模型面新工具：`wake_manage`（schedule/list/update/cancel；幂等键 `operation_id`；conversation/actor 取可信 ctx）；**只进新窗 catalog**（旧窗 wire/catalog 快照冻结不变，C-04/C-05）。

## REMOVAL_REPORT

移除：`autonomousCooldownDueAtMs`+`POLICY_CONSTANTS.background.autonomous.min_interval_ms`（60min 冷却全链）；`keepwarm` 的 `max_model_requests_per_run=1/max_tool_calls_per_run=0/paid_tools_enabled=false` 常量与 budgetGate 对应分支；`KEEPWARM_TOOL_REFUSED` 拒绝分支；保温"finalMessages 一律丢弃"路径；后台重建 system+截断 intent 200 字符；`chatBusy` 用户在场门与无差别 `notePendingUserChat` 取消；HTTP `Date.now()` 拼 ID 伪幂等与读-改-写竞态；`runBackgroundTurn` 的 `maxOutputTokens` 128 截断参数。旧测试对应断言同步改写为退役断言（防回流）。

未动：真实聊天原文、历史 run/费用、已发工具定义快照（window_toolsets）、既有用户设置、v1-v32 迁移 code_hash、128k 提醒/600k 兜底/1m 端点边界、换窗管理、供应商路由与凭据。

## 重点证据（对应模板清单）

- chat + self-wake + keepwarm + rotate 同会话锁：`S-01/S-03` 测试（max active=1；返回值原样=无自锁）＋ executor 测试串行接线。
- 原样英文 host 提示、独立作者身份：executor 测试断言 `Cache keepalive (host event, not Qiaosheng)` 与 `[Host self-wake; not a message from Qiaosheng]` 进入请求。
- 纯1不进 messages/轨迹；工具后1仍 retained：executor 测试 1（轨迹 JSON 逐字节相等、消息数不变、retention=ephemeral_ack、维护回执落投影）与测试 3（retention=retained）。
- 后台正式发言进入下一模型请求：catchup purpose 集合已含 `proactive_turn/cache_keepalive`（实现）；executor 测试断言发布恰一次。（独立"下一请求可见"断言未写——收尾项。）
- 工具目录冻结与新窗生效：未改 `tool-discovery.ts` 冻结机制；`buildHostTools()` 含 wake_manage=新窗快照自动携带。
- 真实消息计时与迟到 usage CAS：wake-keepwarm 测试 K-02/03/04、K-09/10/16。
- 预算真实派发门、结算不双计、未知预占：executor B-01（reserved>0）、wake-keepwarm B-03、旧文件 unknown 预占保留。跨 run 日聚合门=收尾项。
- 关闭后的 late callback 零新派发：recordDispatchStart 终态/cancel 检查（旧测试 CW-15 后半断言保留）。

## OPEN_ITEMS / 未核实（如实）

- **真实 Opus4.6/AWS 请求（L3）：NOT_RUN_REQUIRES_APPROVAL**——含缓存命中/断点/4 断点上限/1h TTL 实测。
- **生产部署/重启/开关开启：NOT_DONE_REQUIRES_APPROVAL**（13_ROLLOUT_HANDOFF 步骤待她批）。
- 生产凭据/身份/聊天读取：NOT_ACCESSED（全程只读本地仓库源码，未触生产 `~/Library/Application Support/estomago`）。
- 收尾项：B-02 跨 run 日占用聚合 SQL 接入 onBeforeDispatch（当前预占按 run 累计+cap 检查在 budgetGate，日级全局聚合属收尾项）；C-07"下一请求可见"独立断言。前端 BackgroundControls 浏览器 DOM 实测已完成（见 TEST_EVIDENCE）；备注一个显示细节：`datetime-local` 值经 `new Date(v).toISOString()` 按访问者本地时区解析后存 UTC（语义正确）；面板时间显示用访问者本地 `toLocaleString`，生产（上海时区）显示即上海时间，未做固定时区钉扎（如需按业务时区显示再加 timeZone 参数）。
- 既有 15 个失败用例（白名单批遗留）不在本批修复范围——见 TEST_EVIDENCE 基线对照。
- 已知边界（13 必须显式交代）：旧窗无 wake_manage（下次正常换窗生效，UI 有说明）；纯 ACK 回执≠缓存命中；长生成可能令 L+50 晚于缓存估计过期（不提前心跳）；关闭期间错过预约不自动补发（needs_review）；外部动作结果 unknown 不自动重放；心跳中正式发言/工具在 UI 的展示走普通消息通道（后台运行列表另可见）。
- 分支基线注记：本分支实际自 `35da6fc`（另一路代理的 docs-only 提交，在我建分支前已入 main）分出；历史完整包含并行提交，无需合并；README 索引行无冲突。
