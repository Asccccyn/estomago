> **历史快照（2026-10-11 起为前代规范的实施图）**：本文件是 `ESTOMAGO_OR_SELF_HOLD` 轮（2026-10-05）的 WP0 现场映射，所述进度反映当时状态。当前施工正本 = `ESTOMAGO_CHAT_EXEC_V1/IMPLEMENTATION_MAP.md`（2026-10-11 起）。本文件保留为审计证据，不删除。

# WP0 · 现场映射与实施落点报告（IMPLEMENTATION_MAP）

产出日期：2026-10-05　执行：程知行（GLM）　规范：`ESTOMAGO_OR_SELF_HOLD`（冻结核 2026-10-05）

> 规范指定输出路径为 `reports/IMPLEMENTATION_MAP.md`；为满足基线统一与审计需要，正本移入 git 跟踪的 `docs/specs/`（`reports/` 是 gitignore 的运行证据区）。实施进度以本文件 §5 + README「当前基线」为准，后续每个工作包完成时更新。

## 0. 现场快照

| 项 | 值 |
|---|---|
| estómago HEAD | `72de719b5a07fe6f2bf87c3488871ad632664`（工作树干净，与 02 映射核对时一致） |
| 规范装订 | `docs/specs/ESTOMAGO_OR_SELF_HOLD/`（27 文件，SHA256SUMS 复验 0 fail；自检 `package_integrity=PASS`，应用验收 76 项全 `NOT_EXECUTED`） |
| 规章 | `AGENTS.md` 硬约束全部有效（不造假/测试隔离/只改本仓/隐私/输入语义/命名）；本报告不违反任何一条 |
| 生产状态根 | `~/Library/Application Support/estomago` 不存在——本机未部署生产实例，无生产数据可碰 |
| 运行时 | Node ≥22.18；唯一依赖 `@anthropic-ai/claude-agent-sdk@0.3.283`（保留） |
| OR 模型配置 | 无既有明确 OR model ID（`runtime.model=null` 默认）——**设置页待她指定，不猜**（01 §6.1） |

## 1. 复用判定总表

判定档位：**复用**（架构不动）/ **接线**（骨架已备、填真实现）/ **最小新增**（挂进现有模块树）/ **退役**（删或改掉，防第二套架构）。

| 现场模块 | 判定 | 说明 |
|---|---|---|
| `app-context.ts` Host 组合根 | 复用 | 同一 host 注册 OR driver 与新领域服务；不开第二个后端/端口（01 §1.1） |
| `runtime/supervisor.ts` TurnSupervisor | 复用 | 会话串行链、route gate、generation fence、确定性终态、恢复扫描全保留；OR 请求走同一 `enqueue→runTurn` 管线 |
| `windows/manager.ts` WindowManager | 复用 | `rotate` 的 CAS 切换、running/pending 拒绝、失败保旧窗保留；review 流程接在 rotate 之前（01 §4.3） |
| `runtime/runner.ts` AgentRunner | 接线 | `kind` 联合加 `'openrouter'`；`RunnerRunRequest` 改为 provider 判别联合（对齐 `contracts/runtime.ts` 的 `DriverRequest`），SDK 分支形状不变 |
| `runtime/runner-claude-sdk.ts` / `runner-mock.ts` | 复用 | SDK 驱动按规范保留；mock 仍限 `ESTOMAGO_TEST_MODE=1` |
| `runtime/build-options.ts` AssembledSdkOptions | 复用 | 仅 SDK 分支使用；OR 不压成单条 prompt（01 §6.3） |
| `config/schema.ts` 严格 schema | 接线 | 加 `openrouter` 段与 `windows` 预算字段（56k/64k/6h/12k/32k/T8k/R8k/S4k 初值）；严格校验/未知键拒绝框架不动 |
| `context/assembler.ts` + `context/policy.ts` | 接线 | `CONTEXT_POLICY_VERSION=null` 正是"等批准"占位；本规范即批准依据——实现 §5 启动装配（I 分页/Mariposa bootstrap/约 12k 近期原话）后发 v1，**不是只翻 approved 标志** |
| `messages/service.ts` + outbox 表 | 复用+接线 | 生产者（用户消息/修订/助手发布 → `mariposa.archive` outbox）已存在；补消费者、scope、重试与来源确认（WP2） |
| `usage/collector.ts` + usage_observations | 复用+接线 | 幂等键与"unknown 不补零"口径保留；加 OR 字段语义（`prompt_tokens_details.cached/cache_write` 分类、provider 列、cost 分栏），不加二次重复计数（01 §9.3） |
| `server/http.ts` | 复用+接线 | 鉴权/CSRF/SSE/静态全复用；新增 records 两个只读端点（`contracts/records-api.md`）；手动 rotate 路由走同一安全管线 |
| `apps/web/src`（原生 JS 前端） | 复用+接线 | 原框架加"记录"侧栏/底部面板与模型配置状态；**不新建 React 平台**（01 §11.2） |
| `identity/service.ts` + bootstrap_receipts | 复用 | gate/manifest/材料校验保留；I 分页完整装载在 WP3 接（01 §5.1） |
| `events/service.ts` + runtime_stream_events | 复用 | 记录面板事件与 SSE 重放走现有游标机制；事件元数据不含正文（隐私纪律） |
| reasoning 隔离合同（`ReasoningProjection` 不可转换） | 复用 | 保持；OR `reasoning_details` 作为 opaque 协议字段走新轨迹层，不进 UI 思考/上下文/TTS（01 §10） |

## 2. 最小新增清单（全部挂现有树，无平行架构）

| 新增 | 落点 | 依据 |
|---|---|---|
| OR 驱动 `runtime/runner-openrouter.ts`（含 SSE 帧解析、终态/usage 归一） | 移植 `reference/or-stream.mjs`；注入 fake transport 测试 | 01 §6、§9.1 |
| OR payload 构造（型号/session_id/provider.only/1h cache_control/关压缩插件/A/B/G 标记、append-only 断言） | 移植 `reference/or-payload.mjs` 进 `runtime/` 或 `context/cache-plan.ts` | 01 §6.2、§7 |
| 换窗评审状态机 `context/review.ts`（RotationReview + `context_review_complete` 工具） | `review-complete.schema.json`；工具 schema 开窗即固定 | 01 §3.3、§4.3 |
| 成功书签与精确提醒范围 `memory/bookmarks.ts` | 移植 `reference/policy.mjs` 的 selectReviewRange/advanceBookmark/completeReview/rotationPlan/normalizeOrUsage | 01 §3 |
| Mariposa 客户端 `memory/mariposa-client.ts`（hold/source.bind/在线原文追加消费 outbox、幂等回执） | 契约 `contracts/mariposa-integration.json`；直连数据库禁止 | 01 §8.3 |
| 协议轨迹与请求表（ProviderRequest、append-only 轨迹、HoldReceiptLink） | `db/migrations.ts` 小范围加列/小表；复用现有表优先 | 01 §2.2–2.3 |
| records 只读端点 + web"记录"面板 | http.ts + apps/web/src | 01 §11.2 |
| 换窗触发器（56k 预警/64k 软线/6h 入站恢复/身份变化） | supervisor P1 处 + windows 状态机扩展 | 01 §4.1–4.2 |

**P1/P2/P3 函数落点**：P1＝`supervisor.runTurn` 运行时 gate 之后、runner 序列化之前（现 `L173–186` gate 块扩展）；P2＝OR 驱动内 payload 构造完成至 `fetch` 发送前（append-only 断言后）；P3＝OR 最终 usage/终态帧处理处回填 usage/缓存观测/书签（01 §11.1）。

## 3. 退役清单（防两套架构的明确处置）

1. **`windows.rotate_on_business_date_change` 默认值 true → false**（01 §4.1"零点不单独触发换窗"；`config/implementation-target.json` 同值）。现场核查：该配置当前只有默认值与 schema 声明，**无自动换窗代码**，`time/context.ts` 的 `crossed_business_date` 是纯事实字段保留——所以退役动作＝改默认值+示例配置同步，无代码可删。
2. **`reference/*.mjs` 不原样进 `apps/`**：移植为 TS 后，参考原件只留在 `docs/specs/` 包内；不出现两份实现。
3. **不引入第二套记忆/摘要**：无 rolling_summary、无小模型、无 keeper、无第二事实索引；`Construction` 的 20 轮 Session/小本本、`LLM缓存` 材料的 Rolling Summary 均不进代码（04 已划界，现场核实代码中亦无残留）。
4. **`docs/architecture/v0.2.1/` 保持历史版本不动**，AGENTS.md 硬约束继续有效；本任务唯一规范正文＝`docs/specs/ESTOMAGO_OR_SELF_HOLD/`（WP1 落地时 AGENTS.md 加一行指针）。规范单一来源，不复制 docx 进仓当第二份施工文件。
5. MockRunner 不扩展、不冒充 OR；OR 与 SDK 各自凭据/握手互不前置（01 §2.1）。

## 4. 外部依赖与授权缺口（不绕过）

| # | 缺口 | 状态 |
|---|---|---|
| A1 | `OPENROUTER_API_KEY` 与明确 OR model ID | 待她经设置页/受保护凭据配置；GLM 不猜型号、不碰 key 值 |
| A2 | 真实 OR smoke 预算（WP6） | `real_model_smoke.enabled=false`；无预算授权一律 `NOT_EXECUTED` |
| A3 | Mariposa 在线原文追加/跨请求幂等回执 | hold 拒非空 raw_refs、source.bind 存在已核对；在线单条追加协议**未证实**——WP2 现场核对，缺则出最小补丁（跨仓库写入须她授权），不直连数据库 |
| A4 | OR `reasoning_details` 协议续传 vs 既有"思考不回灌"合同 | 若严格合同禁协议字段 → 标 `REASONING_PROTOCOL_BLOCKED` 上报，不自行豁免（01 §10） |
| A5 | 生产部署/launchagent 切换 | 不属于本地测试隐含动作；需现有部署授权与回退方案 |

## 5. 施工顺序（03 号工作包 → 现场落点）

WP1 配置+OR 驱动（fake transport 离线测试）→ WP2 原文同步/MCP/收据（A3 门）→ WP3 启动装配/轨迹/书签/一次提醒/自动换窗 → WP4 缓存与工具续请求集成 → WP5 前台记录与设置 → WP6 真实验收（A1/A2 门）。每步按 `ACCEPTANCE.json` 逐项留证，未执行标 `NOT_EXECUTED`。

### 进度记录

- **2026-10-05 23:0x Codex 审计修复批完成（审 3655d60 报告 28 项=9P1/18P2/1P3 → 修复 909bd99，50/51 文件→51/51 绿）**：D14（UTF16/码点 offset）为送审前自审已修项（0422aeb），其余 27 项全修，逐项对照报告证据核过无误判：
  - **P1**：D01 DS thinking 工具续轮回传 reasoning_content（同轮 opaque、落轨迹前剥除）/ D02 手动换窗接指纹门（失效身份零外发、按新材料 CAS 换窗）/ D03 重启恢复收口 active 评审+running 写（hold→unknown 可探测）/ D12 published_kind→chat_message / D13 引用按实际已见 (id,revision) 清单钉修订核对 / D17 弱回执严形状（unknown 不推书签）/ D20 前驱修订可达性解析（不闭锁）/ D22 5xx 一律传输层分类（unknown+有界重试）。
  - **P2/P3**：D04 OR 计量抢救补 import+全断流路径 / D05 轨迹追赶投影（按真实 chat 派发证据收，防未发送大输入注回）/ D06 硬门拆分（大输入先换窗）/ D07 重试终态归实际派发行 / D08 近期原话按完整回合组 / D09 SDK 型号入指纹 / D10 评审费用 windowId typo / D11 重建清单锚定匹配 / D15 mood 缺 note 省 text / D16 同消息多片段+倒序引用 / D18 坏 ACK 吃预算 / D19 码点长度门 / D21 信封实际字节切批 / D23 面板 effectiveWarning+DS TTL=auto / D24 restore WAL 收拢快照 / D25 缺 usage 费用未知 / D26 SSE 只计未 flush 字节 / D27 冒烟不变量（hold committed+书签+工具续轮才 PASS）/ D28 发送前熔断。
  - 新增 tests/unit/audit-d-fixes.test.ts（14 用例）；F25 断言按 D06 新语义更新；SSE 契约测试按 D26 语义翻转；ds-smoke dry-run SMOKE_PASS（含新不变量）。审计简报遗留清单项维持（payload_json 重复/事件保留/循环依赖/manual 假 ID——D10 已修窗口归属）。

- **2026-10-05 21:0x 自审批（0422aeb，程知行）**：送审前对自家 f65f716..ba41c18 改动做同火力自审。**发现并修复 1 个 P2**：quotes 的 start/end_char_offset 原按 JS UTF-16 单位计算，mariposa 契约是 Unicode 码点半开区间（source/query.py CB-029）——消息内片段之前出现 emoji 等增补平面字符即错位；已改 `utf16IndexToCodepoints` 换算 + `[...frag]` 码点长度，emoji 回归锁定（start=3≠UTF-16 的 4）。顺手：QUOTE_CANDIDATE_LIMIT 命名常量（超 60 条已见消息的引用如实拒绝，不扩大扫描）；参数门补 items.minLength（quotes/plan_ids 空串条目门口拒，mariposa schema 对齐）。自审其余面（收据修订配对/评审上限绕过路径含 manual force 与 skipped_empty/停止键竞态/DS payload 不变式在续轮/参数门等价性）逐一核过未见问题，论据见简报攻击面更新。50/50 绿；ds-smoke dry-run PASS。审计简报同步到 0422aeb 口径（Codex 验证修复而非重发现）。

- **2026-10-05 深夜 memory_hold 契约对齐批（mariposa@d14a24e 起步、mood 随 75378ab 终版由并行批补齐；她的三项裁定落地）**：mariposa 侧接口核对（ingest/status/回执全兼容，断点=hold 入参）后，按她裁定修 estómago 工具面：
  - **新契约直传**：`original_title`（必填 ≤30 字）/`categories`（数组·九分类枚举）/`text`；可选 `plan_ids`/`creation_mode`（contemporaneous|retrospective 枚举）/`memory_date`/`date_confidence`。旧字段（category/mood_tags/our_words 自由串/backfill_date）退役，宿主参数门扩展 enum/minLength/maxLength/minItems/maxItems。
  - **引用=模型指认**（她选）：模型只给 `quotes`（想逐字引用的片段，≤10 条）；网关在"发起请求实际看见的原话"里**逐字核对**（按序消费候选，失配=QUOTE_MATCH_FAILED 整单拒绝·零副作用·不替模型圆谎）；说话人按来源自动映射 owner=qiaosheng / assistant=jiaming；引用按 mariposa 现成机制钉住——`our_words`（verbatim+source_ref）+ `source_selections`（source_message_id+内容 hash 来自 source_sync_receipts；句内片段带 char offset，整句=消息边界）；被引消息缺收据 → 先 drainOnce 再核，仍缺=QUOTE_NOT_SYNCED 如实拒绝。
  - **mood 整块未做**（她明示"八大类还要改，先不要动手做心情"）——工具面无 mood 参数；等词表定稿后经 `memory.mood.vocab`（mariposa 已开，owners-only，接口规定动态拉取不许硬编码）接入。
  - 新增 tests/unit/hold-quote.test.ts（4 用例：片段引用+说话人+收据钉住+offset / 整句=消息边界+jiaming / 失配零副作用 / 未同步拒绝）；batch7 参数门断言重写；6 个旧测试文件的 hold 参数与全部 HostToolExecutor 构造点（+db+archiveSync 接线）更新；ds-smoke 假桩参数同步。全量 **50/50 文件 0 失败**；ds-smoke dry-run SMOKE_PASS。
  - **待办**：mariposa 侧"内置绑定"（长期服务身份，她的"内置感觉"裁定——那边 debug 中不踩）；mood 接入等词表定稿；estómago↔真 mariposa 端到端联调（等凭据+archive.enabled）。

- **2026-10-06 接口根因适配批（36fd6df，mariposa-1005B 并行批；程知行）**：上接 86 行批的"mood 待词表定稿"与"内置绑定待办"——两件都已闭环。mariposa 侧（91aead4/479a16d）：词表终版 7 大类+vocab 接口加 version、内置绑定白名单=[hold, hold.status, vocab]（生产库同步更新）、带心情的 hold 须显式 creation_mode（宁拒不猜）。estómago 侧（本批）：classifyError 增 httpStatus 优先分类——修 mariposa 结构化 429=RATE_LIMITED 只认合成码 HTTP_429 的真根因（一次限流曾把归档整批判永久 dead，estómago 单侧看不出来，两仓对测才现形）；mood 组装前置拦截（漏 creation_mode 本地拒 HOLD_MOOD_WINDOW_REQUIRED，省一次远端调用，模型可自纠）；心情词表改 `memory.mood.vocab` 动态拉取（refreshMoodCategories 60s 节流/失败保快照，buildHostTools 缓存随正本失效——不再硬编码第二份）。回归 tests/unit/audit-1005b-root-cause.test.ts（码表/词表/形状门三组）；52/52 绿。

- **2026-10-05 第三方审计修复批完成（审 f65f716 → 本批；程知行审→修同轮）**：全量审计结论=测试 47/47 绿但 DS 放 key 前有 2 个 P1+2 个 P2；她裁定"DS 单独开接口、不走 OR、身份映射隔离"。已修：
  - **DS 官方直连驱动（新）**：`runtime/runner-deepseek.ts`（DeepSeekRunner/buildDeepSeekPayload/dsSessionId/deepSeekSelection）+ `config.deepseek` 配置段（base_url 默认 api.deepseek.com、DEEPSEEK_API_KEY、单段型号门 dsModelIdIssue、无缓存/路由参数）+ selectRunner/信封类型分发。DS 请求**绝不携带** session_id/provider/plugins/cache_control（content 块拍平、reasoning_details 剥除、断点忽略）；SSE 解析复用 OrStreamAccumulator（注入 normalizeDsUsage：prompt_cache_hit_tokens→cache_read、费用缺失不降级 token 完整度、命中超总量标 anomaly 不 clamp）。
  - **身份映射隔离**：dsSessionId 独立命名空间（estomago:ds:session:*，仅宿主内部关联不发送）；contextFingerprint 纳入 deepseek 段 → OR↔DS 切换/DS 型号变化=CONTEXT_STALE 强制换窗；gate driver 三值（SDK 专属前提仍只约束 SDK）。
  - **P1-1（块级 cache_control 泄漏）**：or-payload 断点循环按 isAnthropicFamily 注入（非 anthropic 族断点仍规划但不落标记）；非 anthropic 族型号错误码改 EXACT_MODEL_REQUIRED。此前 commit 883a891 声称的族判断只覆盖了顶层——本批补齐并有断言锁死（batch7 + ds-driver 测试）。
  - **P2-1（评审失败无界重试）**：MAX_WINDOW_REVIEW_ATTEMPTS=3（按窗）——同窗 3 次失败评审后不再自动付费评审（ROTATION_REVIEW_RETRY_EXHAUSTED，输入保存待恢复）；换新窗或人工处理后重置。
  - **P2-2（评审请求停不下来）**：评审 AbortController 登记 active 表（自动换窗=stopKey turnId，手动=合成键 stopAll 兜底）——停止键可中断换窗评审，abort 送达 transport。
  - **顺手项**：MARIPOSA_CLIENT_UNAVAILABLE 拼写修正；中文估算系数 estimate_chars_per_token（OR 2.5/DS 1.5，替代硬编码 2.5）；records 快照 driver=deepseek、TTL=auto、不画 1h 估计线；http runtime 端点报 dsStatus；SDK/mock runner 信封守卫两值化。
  - **ds-smoke 重写**：provider=deepseek 直连；live 门=ESTOMAGO_DS_SMOKE=1+DEEPSEEK_API_KEY（提示语钉死"官方平台 key、直连不经 OR"）；四道熔断保留（retry=0/输出 256/step1 失败即停/全局 10 次）；**真/假 transport 层字段自检**——OR/Anthropic 字段泄漏在 dry-run 即失败，不等 live 400。dry-run 实测 SMOKE_PASS（三步含工具往返）。
  - 新增 tests/unit/ds-driver.test.ts（11 用例）+ tests/unit/ds-supervisor.test.ts（3 用例：DS 端到端+记录快照/评审重试上限/评审停止键）；全量 **49/49 文件 0 失败**。
  - **遗留（审计已列、本批未动）**：provider_requests.payload_json 平方级重复（下一批：改轨迹版本引用+hash）；runtime_stream_events 无保留策略；app-context↔http 循环依赖；手动换窗评审费用落 'manual-rotate' 假 ID（靠 window_id 可见，未改语义）；A016 source_selections 等 BLOCKED 项不变。

- **2026-10-05 复审整改完成（审 967b899 → 4 commits：05fbaf9/4b6d8a8/005665b 前三批 + D-tail）**：复审报告 `~/Documents/Codex/2026-10-05/1-readme-md-2-docs-specs/outputs/estomago-reaudit-967b899.zip`（结论不通过：F01-22 中 10 CLOSED/12 PARTIAL + 新增 F23-F31）。已修全部 21 项可实现项：
  - **批次 A（P1）**05fbaf9：F05 manualRotate 上房间串行链（评审中 chat 排队）、F06 manifest 从 buildOrEnvelope 实选子集生成（索引错配根除）、F23 冻结批恢复按会话按源序+未决阻断同流含新批、F24 坏行单行隔离+rawSync json_valid 防护、F25 容量估算改用轨迹正本（被拒大输入不再污染短输入）、F27 NULL manifest 按正文重建/不可重建如实阻断（不签 skipped_empty）。
  - **批次 B**：F08 恢复只认真回执或结构化 completed=false（损坏 200/错配/throw 全保持 unknown 阻断）、F10 ACK 三件套+committed_at 缺一不可、F15 HTTP500 入可重试+throw/invalid-ACK 吃 attempts 上限、F16 信封字节（+166 开销实测常量）、F11 归档凭据回退仅限 TEST_MODE。
  - **批次 C（v13）**：F13 reasoning 续传展平一维、F17 onDispatch 每次真实发送逐笔留证（sent_at/attempt_no，重试行单列）、F18 TTL 锚 sent_at、F20 断流计量抢救（finish 抛出用已观察原始帧）、F28 完整度对照已发送请求集合、F31 usage 落 window_id（手动评审费用可见）。
  - **批次 D**：F26 before= 严格前移翻页+事件委托绑定+records-api 旧断言修正、F29 状态端点按驱动判别 gate、F22 快照/前台补书签位置/范围条数/费用/TTL、F30 ACCEPTANCE 重判（49 PASS/14 BLOCKED/13 NOT_EXECUTED；A076 自评 NOT_EXECUTED 留独立复审）。
  - 新增 tests/unit/remediation-batch5/6.test.ts（10 用例）+ 3 处旧断言修正（batch2 F13 形状、or-cache F18 语义、records-api F21 重复页）；全量 **46/46 文件 0 失败**。
  - **未修/待授权**：A016 source_selections 工具入口、A034 MCP 大结果分页（等 registry）、A040/041 Mariposa profile、A049 能力快照、A061/062 真实缓存、A067/068 SDK 实机——维持 BLOCKED；F30 中 9 项收窄 NOT_EXECUTED 待补断言。

- **2026-10-05 审计整改批次①完成**（针对 estomago-audit-18a1f1f 的 P1 副作用安全组 + 同路径 P2，基线 2adf8b0）：
  - **F04**：同批工具强制重排——全部写操作先执行并核实，`context_review_complete` 最后验证（§3.3）；`completeReview` 前置**窗口级**未决写检查。
  - **F05**：手动换窗 HTTP 入口改走 `supervisor.manualRotate` 同一评审管线（无直转旁路）；活跃评审互斥（`ROTATION_ALREADY_IN_PROGRESS`/`REVIEW_IN_PROGRESS`）；`doRotate` 校验活动窗=评审目标窗，迟到评审不叠加轮转（`ROTATION_SUPERSEDED`）。
  - **F07**：工具分派前检查取消——停止后同批后续工具不再分派（`STOPPED_DURING_TOOLS`）。
  - **F08**：unknown 写按原 operation_id 有界恢复探测（`memory.hold.status`）：有真实回执→committed+迟到书签（只补原窗）；服务端明确无提交证据→failed_resolved；探测失败→保持 unknown 并阻断换窗。账本记录 seen_sequence。
  - **F09+F16**：迁移 v10 `ingest_batches`（首次发送前冻结规范化 payload/成员键/op）+ `outbox.batch_id`；崩溃/重试按**字节一致**原 payload 重放（新消息只进新批、前驱版本不再重读）；切批按消息对象 JSON 的 UTF-8 字节（转义/元数据计入）。
  - **F10**：ACK 逐条校验（op 匹配+每条 origin/revision 有回执+hash 相符；空回执=`ACK_INCOMPLETE`→unknown，不冒充已同步；hash 不符→dead）；hold 回执 operation_id 必须匹配宿主派生值（错配→unknown 不推书签）；`RECEIPT_SHAPE_INVALID`→unknown 不再 failed_resolved。
  - **F15**：429/502/503/504 归可重试，批次 attempts 有界（≤10 后 `TRANSIENT_EXHAUSTED`）。
  - **F11**：`integrations.*.archive_credential_ref` 独立归档凭据配置（null=回退共用，仅开发；生产必须受限 stream token——联合契约 §8/LC-050）；app-context 拆分 archive/model 两个客户端。
  - 新增 `tests/unit/remediation-batch1.test.ts` 9 用例（审计反例翻成正向断言）；全量 42/42 文件 0 失败。
  - **未动**：F01/F02/F03(部分—blocked_hard 已拦，工具续请求预算重算未做)/F06/F13/F14/F17-F22 留批次②③④。
- **2026-10-05 整改批次②完成**（fcd7969，输入真实性与容量）：F01 gate 驱动判别（SDK 专属前提只约束 SDK；共有身份校验两驱动强制）；F02 当前 I 完整进固定 A 前缀、缺 I 阻断；F03 尾=工具续请求每轮重算容量硬门（CAPACITY_BLOCKED_HARD_TOOL_ROUND）；F06 近期原话从最新向前装预算+评审范围取轨迹已见清单（迁移 v11 manifest_json）；F13 续请求保留已发布正文+opaque reasoning 透传（真实端点兼容=WP6 项）；F14 书签视野含当前输入；F17 provider_requests 存不可变 payload 投影+generation/outcome 回填（迁移 v11）。7 新用例；44 文件。
- **2026-10-05 整改批次③完成**（83c04aa，计量与缓存证据）：F12 每请求身份记账（同 turn 多请求分行保留，审计复现 220 不再被覆成 120）+评审 usage 归属真实 turn；F18 G 候选=实际已发送末块（未发送的最终 assistant 不作边界）+TTL 锚定请求开始时刻；F19（迁移 v12）cost/reasoning/anomalies/raw 帧落库、快照读已存费用；F20 停止后仍吸收已到计量帧（流完整则补记账）。4 新用例+or-cache 断言更新为 F18 语义；44/44 文件。
- **2026-10-05 整改批次④代码完成**（本次提交，前台与收尾）：F21 事件端点 last=1 最近页语义+前端消费 prevCursor"加载更早"+eventId 去重；F22 快照按房间保留最近检查结果（isCurrentWindow 如实标注）+事件渲染带关键事实（hold 条数/原因/检查通过）。**仍待**：AUDIT 复审。全部 22 组缺陷的代码整改完成；五类截图已落 reports/screenshots/；ACCEPTANCE.json 离线核验完成（**59 PASS / 14 BLOCKED / 3 NOT_EXECUTED**，逐项证据指针+evidence/offline-pass-2026-10-05.md；顺手修掉记录面板 hidden 属性被 display:flex 覆盖的前端 bug，6fc0032）。

- **2026-10-05 WP1 完成**（离线部分）：`openrouter` 配置段+硬规则、换窗预算初值（56k/64k/6h/12k/32k/T8k/R8k/S4k）、退役旧预算字段（output/handoff_reserve、max_tool_result）与零点换窗默认值（true→false 硬规则）、`runtime/runner-openrouter.ts`（SSE 解析/payload 构造/用量归一移植自参考实现；429/流前网络故障有界重试、401/402/400 不重试、P2 append-only 断言收口为 error）、supervisor 驱动判别分支（OR 信封：system=身份+批准规则+固定运行片段，user=时间上下文程序事实+正文）、指纹纳入 provider/OR 型号（变更→CONTEXT_STALE）、usage `or_stream` 口径、http runtime 状态（只报布尔）。新增 5 个测试文件 31 用例；全量 36 文件 0 失败。**未做**：真实 OR 外网（A1/A2 门）、MCP 工具执行、跨轮轨迹/缓存断点（WP2-4）。
- **2026-10-05 WP2 完成**（estómago 侧，离线）：A3 缺口经她裁定**由林石见在 mariposa 仓库实施对应接口**（联合契约装订 `docs/specs/MARIPOSA_LIFECYCLE_v1.0/`，SHA256 验签全过）；estómago 侧落地 `integrations/mariposa/client.ts`（source.ingest/ingest.status/memory.hold+op/hold.status，transport 注入、错误码沿用契约类别）+ `integrations/mariposa/archive-sync.ts`（outbox→批量 ingest：稳定 operation_id 派生、崩溃 unknown_outcome 同 op 重放、遗留 sent 恢复、SOURCE_NOT_READY 停流不跳过、IDEMPOTENCY_CONFLICT dead+事件披露、50 条/1MiB(UTF-8 字节) 切批、编辑修订链 previous_revision、收据落 `source_sync_receipts`（迁移 v7）、rawSyncState 只读快照）；host 接线（启动/提交后/turn 完成后 drain，未启用 no-op）。restore.mjs schema 门同步 v7。9 新用例；全量 37 文件 0 失败。**端到端 BLOCKED**：真实 Mariposa 接口未上线（mock transport 测试 ≠ 联调通过）；`archive.enabled` 生产开启=她另行决定。
- **2026-10-05 WP3 完成**（estómago 侧，离线）：核心策略移植 `context/review-policy.ts`（selectReviewRange/advanceBookmark/completeReview/rotationPlan——早餐例子/书签不倒退/旧窗收据拒绝/unknown 不可抹掉/56k 仅预警/64k 换窗/6h idle 全部有测试）；迁移 v8（hold_checkpoints/rotation_reviews/tool_side_effects/provider_requests）；`memory/hold-checkpoint.ts`（书签持久化+幂等推进）、`context/rotation-review.ts`（评审创建/完成校验/同范围凭证复用/空范围跳过/副作用账本）、`runtime/host-tools.ts`（memory_hold 经 MariposaClient、context_review_complete 宿主核验，操作幂等 op 由宿主派生）；supervisor：OR 工具循环（≤8 轮、跨轮 previousPayload append-only、评审完成后即收口）、信封 v2（近期原话 12k 预算+已见清单入 provider_requests）、换窗触发（容量已测才参与/6h 用入站前 last_real_user_at/56k 只发事件）、**用户 turn 前同步评审流**（completed/skipped_empty/凭证复用/失败如实阻断不换窗）、跨窗继承（旧窗书签前内容焦点豁免+按房间已检查键）。13 新用例；全量 39 文件 0 失败。**未做**：token 估计为粗估（字符/2.5+上次 usage 校准，已标注精度；真实计数器另接）；Mariposa bootstrap 分页装载 BLOCKED（等接口）；完整协议轨迹持久化与缓存断点归 WP4；评审会话未接 turn 停止键（短生命周期，后续批）。
- **2026-10-05 WP4 完成**（estómago 侧，离线）：迁移 v9 `window_trajectories`（每窗 append-only 协议轨迹正本；成功回合才推进，失败回合不动、provider_requests 仍逐笔留审计）；`runtime/cache-plan.ts`（断点规划：A=system 末块恒定、B 预留 bootstrap、G=上次已发送边界且仍指向真实 text 块才保留否则如实丢弃；≤3 显式）；信封 v3=轨迹正本+本轮尾部（跨轮 append-only，替换会滑窗的按轮重建）；跨轮 previousPayload 断言接通；payload 验证 A 保持 + G 落上轮末 assistant 块（恰 2 显式断点+顶层自动）。restore 门 v9。3 新用例；全量 40 文件 0 失败。**未做**：B 断点 BLOCKED（等 mariposa bootstrap）；真实缓存命中观测=WP6（不冒称命中）。
- **2026-10-05 WP5 完成**（estómago 侧，离线）：records 只读端点 `GET /conversations/:id/context-records`（快照：驱动/明确型号/窗口/输入估计与精度/上次实际/有效软线与硬容量 null 不画百分比/评审与 hold 数/原文同步状态/缓存 TTL-读-写观测+保温 false；费用字段留空不编数）与 `.../context-records/events`（白名单 kind、limit≤100、游标分页；message 类正文事件不外泄）；前台聊天顶栏"记录"按钮 + 桌面右侧栏/窄屏底部面板（原 JS 框架零新依赖；只读、打开不触发生成；相关 SSE 事件到达时轻刷新）；面板文案按 §11.2（未新增 hold 正常显示非红色、unknown 不显示为 0/100%）。2 新用例 + web-vm 回归；全量 41 文件 0 失败。

## 6. 本次 WP0 已做/未做

已做：只读核对（未改任何 `apps/`、`packages/`、`tests/` 代码）；装订规范包；本报告。未做：未写实现代码、未跑项目测试、未连接外部服务、未读取任何凭据/身份正文/私人数据。测试与实现自 WP1 起，遵守 AGENTS.md 测试纪律（临时 `ESTOMAGO_HOME`、前台分批串行、查孤儿进程）。
