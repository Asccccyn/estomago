# SOL_READONLY_BASELINE｜03 包（Sol 自动浮现 R3.1 + 唯一 Qwen）实施前只读对照报告

日期：2026-11-17（Asia/Shanghai）。执行者：GLM（ZCode）。
依据：`~/Downloads/03_SOL_RECALL_QWEN_20261116.zip`（R3.1）00–08、prompts、contracts、SCENARIOS、COMMON_EXECUTION_RULES。
性质：**只读基线，未改任何代码/配置/索引/资源**。按 00 号文件要求，本报告发出后才进入实施。

## 1. 仓库与运行版本（本地事实，未做任何远端操作）

| 仓 | 协作分支 | 本地 HEAD | 工作树 | 生产运行 |
| --- | --- | --- | --- | --- |
| E `~/Projects/estomago` | `unified-main-20261102` | `c18d316`（docs） | 干净 | host pid 18111 跑 `estomago-releases/bind-calendar-0fb8cfa`（launchd `online.charstarearth.estomago`，start.sh cd 到 release；DB `chat.sqlite3`）；content=`pkg2-0fb14ac`；media-embedding worker=`audit-fix-20261108-70c7609` |
| M `~/Projects/mariposa` | `main` | `c213f27`（docs） | 仅 5 个 `scripts/allowlist-backup-*.json` untracked 备份（不属本批，保留不动） | uvicorn pid 17934 端口 18780，launchd `com.charstarearth.mariposa-runtime`，cwd=`mariposa-releases/bind-calendar-82b8eb4`，venv=`~/Data/mariposa/venv-album-p2a` |

远端分叉按 2026-11-15 裁定视为脱敏线，不核对不对账。两仓生产均从 release 副本运行，**工作仓改动不触产，发布+重启才生效**；重启须另行取得本次明确同意。

## 2. 逐需求对照（要求 → 当前证据 → 状态 → 拟改）

### 2.1 单一浮现入口、一次 Sol、有限近文（01§1–2）

- 现状：**已达成**。旧关键词门已退役（`apps/host/src/memory-surfacing/trigger.ts:1-4` 注释明言）；每条正式 accepted+dispatchable 消息登记一个幂等作业（`repository.ts:88-98` ON CONFLICT DO NOTHING）；Sol 三态在事务提交后 preparePhase 内一次调用（`service.ts:341-345, 512-529`，瞬时错误仅一次有界重试）；草稿/工具续轮/assistant/通话期不触发（`message-lifecycle.ts:33-55`、`supervisor.ts:2266-2270`、`service.ts:136-162`）。近文按用户消息计数（`trigger.ts:30-65`，默认先前 3 条用户消息+其间回复；`LIMIT 40` 仅原始行上界）。
- 拟改：保留；仅随 R3.1 更新默认判断模板文本（见 2.6）。

### 2.2 用途决定检索内容 / 复合缺项（01§3–4，R01–R09）

- 现状：**部分达成**。
  - M plan 合同 v5（`backend/mariposa/capabilities/input_schemas.py:1210-1309`）：`purpose/route/breadth/queries` 已生效，`additionalProperties:false` 全层；**缺口①**：queries 每项只有 `semantic/keywords`，无逐查询 `need_kind/need`；`time_hint/speaker` 是 plan 级而非查询级（CONTRACT_MAPPING 要求移到各 query 且仅约束自己的 query）。
  - 路由：plan 级 route 三值；words 查询走 `words_candidates`，event 走 `tiered_partition_retrieval`；raw 仅 words/mixed 路由两种触发（检索零结果 / quote 未满足，`surfacing/service.py:343-368`）。**缺口②**：`satisfied` 只认 words/source 赢家（`service.py:546-552`）——event 用途的满足状态没有同等的第一公民表达；**缺口③**：补查候选并入后在全 selection_pool 重跑选择（`service.py:626-632`），违背"已满足部分保留，只为缺项补查、不得全池来源赛马"（R04）。
  - 单一/相关选择：related 全部合格互补入选+预算 6 截断、single 每分区一份且仅 identity_anchored≥2 才歧义弃权（`selection.py:67-101`）——与 L04 方向一致。
- 拟改：schema 增逐查询 `need_kind/need/time_hint/speaker`（同合同最小增补，不外挂第二 schema）；`_plan_from_args` 规范化与持久化跟进；检索/JEV/缓存消费者逐项消费新字段；需要级停止（event/words 分别记满足，补查只针对缺项，已满足赢家保留）；raw 触发条件改为"仍有未满足 words 用途"，event 满足不再引发 raw。

### 2.3 共享真实窗口 coverage（01§7、02§5–6、N16–N25）

- 现状：**部分达成**。
  - 已有：coverage 表按 `(conversation_id, window_id, memory_id, body_hash)`（`db/migrations.ts:983-993`）；唯一写点 `markRetained`；读取三处均要求"coverage 行+保留交付正文真实出现在该窗轨迹消息"双成立（`repository.ts:299-346`）；无 TTL/午夜/重启清除（全仓无 DELETE FROM surfacing_coverage）；滚窗=新 window_id 自然重建；并发准入 CAS+freezeDelivery+finalAdmit 二次复核+dropAtFinalAdmission（`repository.ts:252-297`、`service.ts:302-319`）。生产 DB 实测 57 行 coverage 分布 7 个已 CLOSED 窗，当前 ACTIVE 窗 0 行——换窗是唯一换代边界，符合"跨日不清、真滚窗重建"。
  - **缺口④**：`memory_recall`/`memory_recall_next`/`memory_read_full`/`conversation_read` 不读不写 coverage；recall 仅下推来源级 `excluded_source_ids`（`modules/memory/service.ts:466-493`，cap 64；recall_next 无）——主动与自动两套账，同窗已注入桶可经主动 recall 全文重复。
  - **缺口⑤**：不存在对模型可见的 `already_in_window` 短回执（全仓零命中；仅有作业侧 reason_code）。
  - **缺口⑥**：显式重读无合同表达；主动 recall 有意不带去重集（B4 注释），但按包边界，公共工具合同的最小补齐属第 4 包，本包先落短回执并保留合法深读/版本链，重读表达缺口在交付中单列移交。
- 拟改（E）：recall/recall_next/read_full 结果投影接 `coveredInWindow` 同一判定：全覆盖条目以短 `already_in_window` 语义回执替代正文（保留 ref/版本/游标/分页语义）；部分覆盖只交必要未读增量不改集合语义；主动读取实际送达同样进入覆盖账（沿用既有轨迹判定，不建第二已读库）。conversation_read 为携带历史读取，正文即已读，不重复去重（如实核对后归 NOT_APPLICABLE 或接线，视实现成本在实施报告如实标注）。

### 2.4 P1/P2 与短句背景（01§6，N01–N03、N09）

- 现状：模板层已有 words/source 投影通道（`contracts.ts:22, 102-110` words/source 保留 speaker/quote_text/source_context_text）；P2 型去重依赖 coverage（存在但按 2.3 缺口只有自动路径）。**缺口⑦**：Sol 默认模板与 JEV 模板未含 R3.1 的"当前已知与新需要/增量判断/连续难过不扩张"等成文规则。
- 拟改：Sol 默认模板与 JEV 判定提示按 R3.1 两份 prompt 合入（保留现行 schema 字段与严格校验，逐字触发证据、来源许可等现行有效字段不删）。

### 2.5 唯一 Qwen3-Embedding-4B 与 BGE 退役（01§9、03§D/E，D01–D07、M01–M07、N11–N13）

- 现状：**未达成（当前分支=D2 尚未 Qwen）**。
  - 双实现并存：`retrieval/semantic.py:18-98` BGE(fastembed ONNX 512 维)/Qwen3-Embedding-4B(MLX 4bit 2560 维) 由 `MARIPOSA_SEMANTIC_PROVIDER` 单值切换，纯 switch 无回退链；`config.py:96` 默认空=未配置；生产 env 未设（dense 关闭，检索走 Tier0/Tier1 BM25）。11/9 一笔 dense 降级已由用户解释为切生产漏启动，不以旧快照断言现状。
  - Qwen 实现完整但休眠：`qwen_embed.py` 懒加载、官方 instruct、last-token 池化、L2 归一；模型权重在仓内 `runtime/models/qwen3-embedding-4b-4bit`（2.1G，已存在，无需下载）。
  - **缺口⑧**：启动无预热/就绪（`app.py:37-65` lifespan 无语义项）；`qwen_embed._load` 无单实例锁（D02）；warmup 仅手动能力 `maintenance.semantic.warmup`。
  - **缺口⑨**：增量索引只接了删除（`deletion/service.py:107-125` 同事务清向量）；create/update 不写向量，靠查询路径懒补 budget=20 或手动 warmup（M06 明确不允许）。
  - **缺口⑩**：BGE 资源未退役：`semantic.py` BGE 分支、`requirements.lock` fastembed/onnxruntime、`runtime/models/blobs`（90M fastembed 缓存）、`models--Qdrant--bge-small-zh-v1.5`（456K）、DB 内 BGE 向量行。
  - words 独立向量空间 `word_embeddings`+`wordbody-v1`（`words_semantic.py`）同样双模型待切换。
  - `docs/closure/qwen4b_deployment.md` 不存在（11/9 文档所指为历史定位线索）。
- 拟改：lifespan 有界后台预热+单实例互斥+只读 readiness；查询保持零隐式 reindex；create/update 走显式索引维护接线写 Qwen 向量（失败可见可恢复）；迁移脚本在隔离目标空间构建 Qwen 向量（事件+words）后成对切换；全链合格后退役 BGE 执行分支/配置/依赖/权重/旧向量（逐消费者证据，非按名批量删）。生产 DB 的实际迁移与 provider 切换涉及发布重启，**本批只准备代码+脚本+隔离副本验证，生产执行待授权**。

### 2.6 人物、relation/episode（01§8、03§F，P01–P08、C05）

- 现状：E 单一身份正本（`identity/service.ts:123-181`，manifest+hash 校验；I 唯一注入点=开窗 B 段分页+`memory_i_read`）；显示名从配置解析注入模板与携带图（`app-context.ts:182-195`、`supervisor.ts:1721-1724`）；relation/episode 为 memory 域工具、多数通话期可用、按窗冻结（`modules/memory/module.ts:427-518`、`supervisor.ts:183-187`）。M 侧 episode 三面与 relations 族注册齐全（`capabilities/registry.py:284-324`）。**无明显缺口**；本包按 F 只做核验性检查，公共工具面改动（如有）移交第 4 包。

### 2.7 SDK/API 首次出站与 retain（02§6，L11、C06）

- 现状：**已达成**。装配→冻结→finalAdmit→markDispatched（OR/DS onBeforeDispatch + SDK round0）→markRetained（成功轨迹替换后）链路完整（`supervisor.ts:2266-2284, 2381-2389, 2771-2783, 744, 1034, 2917-2931`；SDK 输入流 `sdk-host-query.ts:36-119`）。本批不改。

## 3. 现行有效预算（不沿用旧文档数值）

M（`config.py`）：RECALL_SESSION_TTL 24h、BURST 3、JUDGE_CANDIDATE_CAP 40、DELIVERY_LIMIT 3、PACKET_BYTES 24576、JUDGE_TIMEOUT 5s/ROUND_DEADLINE 20s；SURFACE：DELIVERY_VALIDATION_DEADLINE 4s、PREPARE_DEADLINE 10s、JUDGE_POOL_CAP 24、RELATED_DELIVERY_BUDGET 6、SUPPLEMENT_MIN_BUDGET 1500ms、DAILY_JUDGE_CAP 100、费用上限默认 None（有付费出站即 blocked）。
E（`estomago.yaml` 生产）：`delivery_deadline_ms: 300000`。Sol 模型 `gpt-6.1-sol`（key 走 `ESTOMAGO_SOL_API_KEY` 独立 secret）。

## 4. BGE 资源消费清单（退役分母，待 Qwen 全链合格后执行）

| 资源 | 位置 | 消费者 | 处置 |
| --- | --- | --- | --- |
| BGE provider 分支 | `semantic.py` fastembed import/TextEmbedding/QUERY_PREFIX | `get_provider()` 非 qwen 分支 | 移除执行可能性 |
| 依赖 | `requirements.lock: fastembed==0.8.0, onnxruntime==1.30.0` | 仅 BGE 路径 | 确认无他消费者后移除 |
| 权重/缓存 | `runtime/models/blobs`（90M）、`models--Qdrant--bge-small-zh-v1.5`（456K） | fastembed 懒加载 | 确认归属后删除（不动 Qwen 2.1G 目录与共享缓存根） |
| DB 向量 | `memory_embeddings`/`word_embeddings` 中 `BAAI/bge-small-zh-v1.5|*` 行 | 无（provider 关闭即不读） | 迁移验证后清理 |
| 阈值/env 样板 | `MARIPOSA_SEMANTIC_THRESHOLD`、env.example 注释 | BGE 分支 | 随分支退役，文档写实际终态 |

共享保护项：`requirements-dense.lock`（mlx 栈，Qwen 用）、媒体嵌入 worker（独立服务，不经 M 文字链）、原始记忆/来源/审计数据、历史报告中的 BGE 字样。

## 5. 跨包接缝

- 第 2 包（system 正本/午夜绑定）：本包读同一身份服务，不复制 profile；raw 不等待每日绑定（现行已满足：绑定任务独立，检索不依赖）。
- 第 4 包（MCP 工具面）：显式重读的合同表达、公共工具参数补齐归其最小补齐；本包先落短回执并保留 ref/version/cursor 链。
- 第 1 包（媒体）：已完成的相册两修复不重开；媒体嵌入不经 M 文字向量链，BGE 退役不触及。

## 6. 局部冲突与待裁决项

1. **无阻断性冲突**：包内目标与两仓现行架构一致，全部缺口可在现有模块原位收敛，无需第二服务/第二 schema/新窗口系统。
2. **生产重启与切换待授权**（不阻断代码实施）：M 生产 provider 切 qwen3e4b + 向量迁移 + BGE 资源清理、E 生产发布，均需届时单独取得本次同意；等待期完成代码、隔离验证与切换计划。
3. 显式重读合同表达缺口移交第 4 包（包内明文边界，非本包冲突）。

## 7. 验证计划（对应 05 四层证据）

1. 离线合同/回放：M pytest 最小范围（schema/路由/停止/JEV 缓存身份/迁移脚本，`-x -q` 指定文件，遵守 M 仓测试硬约束：前台、有界、不跑全量）；E `npm test` 相关批次（独立临时 ESTOMAGO_HOME）。出站捕获验证 already_in_window 投影与固定分页游标保留。
2. 本地 Qwen：隔离 DB 副本上跑真实 Qwen 嵌入（少量合成同义正例/干扰项，D07），验证维度/空间/增量新增/更新/删除。
3. 真实 Sol/JEV 语义、生产部署/重启：默认 NOT_EXECUTED，待授权后另行报告。
4. 快照对照：修改前后同一冻结数据快照回放 P1/P2/R01–R04/N04–N05 型用例。

——以上为只读基线。以下进入实施。
