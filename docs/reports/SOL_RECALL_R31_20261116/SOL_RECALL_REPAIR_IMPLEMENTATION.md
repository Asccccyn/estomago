# SOL_RECALL_REPAIR_IMPLEMENTATION｜03 包 R3.1 实施报告

日期：2026-11-17。执行者：GLM（ZCode）。基线：E `c18d316` / M `c213f27`（见 SOL_READONLY_BASELINE.md，实施前已先行交付）。
生产状态：**本批未发布、未重启、未改生产 env/DB**；生产继续跑 E `bind-calendar-0fb8cfa` + M `bind-calendar-82b8eb4`。

## 1. 修改范围总览

### Mariposa（M，~17 文件）

| 模块 | 变更 | 说明 |
| --- | --- | --- |
| `capabilities/input_schemas.py` | prepare 计划合同 v6 | queries 增 `need_kind/need`，`time_hint/speaker` 下沉查询级（计划级退役）；可选 `covered_context`（≤16×320B，E 下传已读最小投影）；新增 `_CROSS_FIELD_CHECKS`：route↔need_kind 一致、mixed 须两类，违规 SCHEMA_VIOLATION |
| `surfacing/service.py` | 检索按查询用途路由 | event 查询走桶、words 查询走我们的话；raw 探查只对 words 查询（`not_words_route`→`not_words_need`）；R04 锁定已满足赢家后补查重选；covered_context 进快照与两阶段判断；plan 规范化含查询级字段 |
| `surfacing/selection.py` | `locked_refs` | 补查后同分区不与锁定赢家竞争；related 预算裁剪永不裁锁定者 |
| `surfacing/judge.py` | 判断模板 v6_r31 + state/缓存 | JEV 规则合入 R3.1（用途先于排序/需要级满足/已读增量/互补/短句背景/连续难过不扩张/P1-P2）；state 增 `needs`/`already_in_context`；`_plan_key` 含查询级字段；`_context_hash` 含 covered；time_basis 溯源查询级 hint |
| `config.py` | 版本标签 | prompt v6_r31、purpose-v2-r31（进合同指纹→旧判断缓存换键） |
| `retrieval/qwen_embed.py` | 生命周期 | RLock 单实例互斥；status idle/loading/ready/failed 只读探测；`warmup()` 真实合成向量校验（非空/有限/2560 维）；`wait_ready` 只读等待 |
| `retrieval/semantic.py` | Qwen 唯一 + 显式维护 | BGE 执行分支/fastembed import/BGE 阈值与前缀全部退役；查询路径零隐式补嵌（REINDEX_BUDGET 默认 0）；新增 `backfill_missing`（事件+words，幂等有界）与 `after_write`（事务外尽力补嵌，失败不回滚写入） |
| `retrieval/words_semantic.py` | Qwen 唯一 | 双 provider 分支退役；查询补嵌默认 0 |
| `retrieval/candidate_service.py` | 退役残留 | local_bge_zh 特判改为"未配置→如实降级" |
| `app.py` | 启动就绪（D1） | lifespan 起后台线程：warmup→分批回填到补完；未配置/权重缺失如实跳过；服务不等预热（期间 dense skipped_cold） |
| `memory/service.py` `memory/extras.py` | 增量接线（M06） | hold/update_text 提交后调 `semantic.after_write()`（事务外） |
| `requirements.lock` | 退役依赖 | 移除 fastembed==0.8.0、onnxruntime==1.30.0 |
| `scripts/migrate_qwen_embeddings.py` | 新增 | 目标空间迁移脚本（幂等/可续跑/--purge-bge 覆盖核对后清理） |
| `mariposa.env.example` | 文档 | Qwen 唯一可选值说明 |
| `runtime/models/`（gitignored） | 资源 | 删除仓内 BGE 权重副本（blobs 90M + models--Qdrant--* 456K）；Qwen 2.1G 保留 |
| tests×11 | 迁移/新增 | 夹具迁移到查询级字段与 Qwen fake 世界；新增 `test_surface_r31_need_and_lock.py`（9 例） |

### estómago（E，6 文件）

| 模块 | 变更 | 说明 |
| --- | --- | --- |
| `memory-surfacing/sol-provider.ts` | Sol 合同 v3_r31 | schema 查询级 need_kind/need/time_hint/speaker（计划级退役，evidence 保留）；默认模板重写为 R3.1（三态/已知与新需要/用途/成对边界）；`validateSolDecision` 增 route↔need_kind 跨字段校验；动态输入渲染 `coveredContext` 摘要段 |
| `memory-surfacing/service.ts` | 已读投影+映射 | preparePhase 先取当前窗已读摘要（`coveredDigest`）进 Sol 输入与 M prepare `covered_context`；`planForMariposa` 逐查询映射（speaker 显示名→枚举）；装配去重增 `textSeenInWindow`（N04：主动先交→auto 不重发全文） |
| `memory-surfacing/repository.ts` | 覆盖事实源 | `visibleRetainedItems` 抽公共（coverage/摘要同源）；`coveredDigest`（保留交付+开窗资料节选，有界）；`textSeenInWindow`（轨迹逐字判定，≥12 字符） |
| `modules/memory/service.ts` | 短回执 | `markCoveredCandidates`：recall 首页/续页候选正文已在本窗轨迹逐字出现→短 `already_in_window` 回执（保留 ref/版本/游标；分页语义不变）；深搜 Round2 与冻结重放不经此路径 |
| `modules/memory/projection.ts` | 白名单 | `already_in_window` 标记随候选出站 |
| tests×3 | 迁移/新增 | 夹具查询级化；新增 `surfacing-r31-window-coverage.test.ts`（3 例） |

## 2. 逐目标结果（00 号文件 7 目标）

1. **单一入口/一次 Sol/三态**：原有实现已达成（基线 2.1），未重写；本批仅合入 R3.1 模板语义。
2. **用途决定检索**：`PASS`（离线）——need_kind 逐查询路由；R01（event 满足不补 raw）原有 event-only 不触发 raw 的行为保留；R04 锁定赢家新增测试证明补查不推翻已满足部分。
3. **P1/P2**：模板与 JEV 规则成文（P1 词义原话可查；P2 已知不重查、明确问当时措辞仍可查）；E 侧 Sol 输入带已读摘要。真实 Sol/JEV 语义效果 `NOT_EXECUTED`（零付费默认）。
4. **共享真实窗口 coverage**：`PASS`（离线工程层）——auto/主动 recall/续页共认 window_trajectories 事实源；跨日/重启/TTL 不清（原有，保留）；普通全覆盖短 already_in_window；N04 方向（主动先交→auto 不重发）接 textSeenInWindow。**精确版本/范围级合并（N19 修订/片段对账）为部分实现**（正文逐字级，未到字符区间级）；显式重读合同表达移交第 4 包（包内既定边界）。
5. **唯一 Qwen**：代码终态 Qwen-only（分支/依赖/权重/双栈全退役）；启动预热+单实例锁+增量接线+迁移脚本齐备；隔离副本真实迁移与 D07 语义验证 `PASS`。生产切换（env qwen3e4b+迁移+重启）**待授权未执行**。
6. **人物/relation/episode**：核验无缺口（基线 2.6），未改；工具面事项归第 4 包。
7. **快照对照**：迁移脚本幂等（同对象同 hash 跳过）；新旧策略对照回放平台未建（真实 Sol/JEV 未授权调用，语义对照 NOT_EXECUTED）。

## 3. 与基线的差异更正

基线 2.5 节曾按 env 样板推断"生产 provider 未配置"；实施中核对 `~/Data/mariposa-secrets/start.sh` 发现**生产实际 `MARIPOSA_SEMANTIC_PROVIDER=local_bge_zh`**，且 BGE 权重在 `~/Data/mariposa/runtime/models`（非仓内副本）。生产 DB 现状：650 合格事件、599 条 BGE 事件向量（51 缺/失效）、481 合格 words、word 向量 0 条。据此部署步骤必须成对切 env（见 DEPLOYMENT_STATUS）。

## 4. 明确未做/部分项

- 生产迁移与 provider 切换、两仓发布、重启：待授权。
- N19 字符区间级精确范围合并、显式重读合同表达：第 4 包协同（已按包边界移交，不在本包强做第二套）。
- conversation_read 未接覆盖去重：其正文本身即"已读"（携带历史），无重复投递问题，归 NOT_APPLICABLE。
- M 仓 5 个 allowlist 备份 untracked 文件保留未动（非本批归属）。
