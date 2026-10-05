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

- **2026-10-05 WP1 完成**（离线部分）：`openrouter` 配置段+硬规则、换窗预算初值（56k/64k/6h/12k/32k/T8k/R8k/S4k）、退役旧预算字段（output/handoff_reserve、max_tool_result）与零点换窗默认值（true→false 硬规则）、`runtime/runner-openrouter.ts`（SSE 解析/payload 构造/用量归一移植自参考实现；429/流前网络故障有界重试、401/402/400 不重试、P2 append-only 断言收口为 error）、supervisor 驱动判别分支（OR 信封：system=身份+批准规则+固定运行片段，user=时间上下文程序事实+正文）、指纹纳入 provider/OR 型号（变更→CONTEXT_STALE）、usage `or_stream` 口径、http runtime 状态（只报布尔）。新增 5 个测试文件 31 用例；全量 36 文件 0 失败。**未做**：真实 OR 外网（A1/A2 门）、MCP 工具执行、跨轮轨迹/缓存断点（WP2-4）。

## 6. 本次 WP0 已做/未做

已做：只读核对（未改任何 `apps/`、`packages/`、`tests/` 代码）；装订规范包；本报告。未做：未写实现代码、未跑项目测试、未连接外部服务、未读取任何凭据/身份正文/私人数据。测试与实现自 WP1 起，遵守 AGENTS.md 测试纪律（临时 `ESTOMAGO_HOME`、前台分批串行、查孤儿进程）。
