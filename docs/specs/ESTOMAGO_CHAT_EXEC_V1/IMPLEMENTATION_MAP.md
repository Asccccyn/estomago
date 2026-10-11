# WP0 · IMPLEMENTATION_MAP（ESTOMAGO_CHAT_EXEC_V1）

产出日期：2026-10-11（Asia/Shanghai）　执行：程知行（GLM）　规范：`ESTOMAGO_CHAT_EXEC_V1`（本目录，2026-10-11 冻结）
施工工作树：`~/Projects/glm1011-estomago`　分支：`glm/chat-exec-v1-20261011`
前代实施图（OR_SELF_HOLD 轮）已加横幅移作历史快照：`../IMPLEMENTATION_MAP.md`。

## 0. 现场快照

| 项 | 值 |
|---|---|
| 基线 SHA | `4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1`（preflight `BASELINE_MATCH`：42 文件哈希一致、工作树干净、无脏文件） |
| 执行包自检 | `verify_package.py` PASS：1839 checks / 40 需求 / 114 验收 / 48 路由 / 32 模型工具 / 18 fixtures |
| 运行时 | Node ≥22.18（engines）；运行依赖仅 `@anthropic-ai/claude-agent-sdk@0.3.283`（锁定安装，OR 模式不加载） |
| DB 迁移起点 | 现最高 **v20**；本轮所有新迁移从 **v21** 起由集成者（GLM 本轮）顺序分配，各工作包不抢号 |
| 测试入口 | 根 `package.json`：`npm run typecheck`、`npm test`（runner 内置临时 `ESTOMAGO_HOME` + `ESTOMAGO_TEST_MODE` + 逐文件串行；79 个测试文件） |
| 生产实例 | `~/Library/Application Support/estomago` **存在**（本轮只 ls 顶层确认存在性）——本轮全部改动在工作树+隔离临时根进行，不触碰生产；部署类动作单列待她批准 |
| OR/DS 配置 | 现行配置默认 `runtime.provider=claude-agent-sdk`、OR/DS `model=null`（未配置即阻断，不猜默认型号——沿用前代口径） |

## 1. 02 落点表核对（基线可信性）

02_BASELINE_AND_IMPLEMENTATION_MAP §2 列出的 31 个关键源码文件**全部存在于当前 HEAD**（逐一路径核验，含 app-context/http/schema/migrations/api.ts/messages/supervisor/runner×4/sdk-event-normalizer/or-payload/cache-plan/window-trajectory/manual-selection/review-policy/rotation-review/host-tools/mariposa client/archive-sync/collector/or-contract/records/events/service + web 四件 + example.yaml）。02 的"已实现与缺口"表按当前代码采信，作为本轮复用/改造/新增的判定基础。

## 2. api-index 逐项核对（48 路由 / 32 模型工具）

- **extend_existing ×4：全部在基线存在** —— `POST|PUT|GET /api/v1/conversations/{id}/messages(/{id})`、`GET /api/v1/turns/{id}/usage`。扩展方向：消息附件 DTO（additive，文本路径兼容）、usage 字段级已知/未知分列。
- **new ×44：全部待建** —— assets 6、system-alerts/token-estimates 4、background 8、content 21（经 est 薄代理）、calendar 3。基线另有 23 个既有端点不在本包改动面（health/auth/events/stop/rotate/runtime-settings/context-selection/route-decisions/time/context-records/turns 等），全部保留复用。
- **模型工具 32：均为新增面**（background_task×4、content_*×15、calendar/future-notes/媒体等）；现有 host-tools 工具面（memory_open/correct 等 15 个，4971ebc 落地）**保留不动**，新增工具按 07 §5 规则（expected_revision/idempotency_key 由 host adapter 映射，模型不可自传 actor）。

## 3. policy-defaults 接线映射（WP0 已落）

默认值唯一机器正本 = `contracts/policy-defaults.json`。按 validation_rules 最后一条（"不得将所有表项盲目变成可用户修改的 schema 字段"）分三档接线：

| 档 | 键 | 落点 |
|---|---|---|
| **YAML 可调**（adjustable=true，25 键） | `background.autonomous.*`（enabled/max_model_requests/max_output_tokens/max_tool_calls/max_run_ms/paid_tools_enabled/daily_cost_cap_usd）、`background.keepwarm.*`（enabled/max_output_tokens/max_run_ms/daily_cost_cap_usd）、`background.reminders.*`（enabled/delivery_grace_ms/default_local_time）、`content.enabled/port`、`system_alerts.usage_settlement_grace_ms/summary_refresh_debounce_ms`、`token_estimates.debounce_ms/max_body_bytes`、`media.*`（8 键） | `apps/host/src/config/schema.ts` 新增六段（类型+默认+SHAPE+硬规则：正整数/正数/HH:MM/端口 1..65535/费用上限 null-或-正数）+ `config/estomago.example.yaml` 同步 |
| **策略常量**（adjustable=false，9 键） | `background.keepwarm.idle_after_cache_ms(50min)/max_model_requests_per_run(1)/max_tool_calls_per_run(0)/paid_tools_enabled(false)/allow_cold_start(false)`、`background.autonomous.min_interval_ms(60min)`、`pagination.default_limit(20)/max_limit(100)`、`system_alerts.read_batch_max(100)`、`content.bind_host(127.0.0.1)` | `apps/host/src/config/policy-constants.ts`（新模块，唯一正本） |
| **映射既有键**（4 键，不重复定义） | `cache.anthropic.requested_ttl`→`openrouter.cache_ttl`（硬规则 '1h'）、`windows.soft_limit_tokens`→`windows.soft_limit_tokens`(64000)、`runtime.max_active_primary_runners`→既有键(1)、`calendar.timezone`→`time.business_timezone`(Asia/Shanghai) | 沿用现有配置，不造第二正本 |

**旧配置升级行为**：未写新段的旧配置文件经 deepMerge 得到新段默认值——`background.autonomous.enabled=false`、`background.keepwarm.enabled=false`（**关闭即交付状态**）；`daily_cost_cap_usd=null` 显示"未配置"，禁止该用途后台付费，不是无限。不重置用户现有模型/身份/路径/密钥设置。

## 4. 已核 / 待核能力表（WP7 前保持此状态）

| 服务 | transport | 现状 | 说明 |
|---|---|---|---|
| Mariposa | http | **client 在仓可用**（`integrations/mariposa/client.ts` 实调 `/api/capability/{capability}`） | 保留现路径；附件 schema/月历批量分页/our_words 稳定 ID 待核（BLOCKED_DEPENDENCY 前不杜撰） |
| Siren | http 或 mcp | config_only | 语音外置；实时流接口按真实合同核对 |
| oído | mcp | 本机部分、不在仓 | 她指定 MCP；频谱/听觉业务在其后端 |
| 扎西德勒 | mcp | config_only | 她指定 MCP；与新私密朋友圈完全独立 |
| Antinomy/Superposition/X/小红书 | 既有架构 | config_only / 复用 | 不在 est 重写浏览器/爬虫；星星只读重要日 |
| SDK（CC） | - | 0.3.283 锁定 | 公开 TTL/压缩控制与最终参数在 WP2 核验；`autoMemoryEnabled=false` ≠ 禁压缩证明 |

其余待核（02 §5 全表有效）：用户 Mac 运行时 provider 实况、Mariposa 附件/聚合接口、目标模型图像输入与图片 token 估计、实时语音通道、手机离线推送、情绪数值维度、具体游戏需求。未知不成为猜测接口的理由。

## 5. 规范装订与入口（WP0 已落）

- 本包 19 文件已导入本目录（`docs/specs/ESTOMAGO_CHAT_EXEC_V1/`），含 contracts 正本与只读校验脚本。
- `AGENTS.md` 规范入口已改为本包；OR_SELF_HOLD 与 v0.2.1 的未替代条款继续有效（三代硬约束同列）。
- 前代规范 `01_执行架构.md` 与前代 `../IMPLEMENTATION_MAP.md` 已加"部分替代/历史快照"横幅——保留审计证据，不删除。
- 验收执行副本 `ACCEPTANCE_EXECUTION.json`：114 条全 NOT_EXECUTED，逐项带 implementation_commit/command/environment/observed/evidence_path/blocked_dependency 字段；`contracts/acceptance.json` 正本不动、不改期望值。
- 本轮替代的旧口径（README §53 式披露）：生活功能全写进聊天核心→可选 `apps/content`；无夜间保温→三开关有界后台（默认关）；朋友圈仅char→双方可看/发/评。

## 6. 施工批次状态

| 批次 | 状态 | 出口要点（07 §4） |
|---|---|---|
| WP0 基线与合同 | **本轮交付** | 本文件 + 配置接线 + 迁移登记 + 行为基准（见下） |
| WP1 消耗可见与 token | 待做 | 系统红点四件一条链；字段级 actual；纯估计器；后台归属预留 |
| WP2 上下文与缓存 | 待做 | transport 前 admission/dispatch 起点；TTL 三态；SDK 核验；64k/手选/hold 不动 |
| WP3 聊天媒体底座 | 待做 | 一条垂直链（上传→asset→revision→UI→模型→重启重取） |
| WP4 有界后台 | 待做 | 三开关/账本/50min/60min/聊天抢占/重启恢复 |
| WP5 内容与朋友圈 | 待做 | content 进程 + 双 actor + 三相册/作品/留言 |
| WP6 日历与关联 | 待做 | 聚合页面 + 分源分页 + 事件日/北京日界 |
| WP7 外部合同连接 | 待做 | MCP 薄层 + 逐能力 expected/observed |
| WP8 联合审计交付 | 待做 | fresh/upgrade 验收 + 四份报告 |

迁移纪律：本轮新迁移自 v21 起顺序分配（集成者=GLM 本轮）；est 与 content 两库 schema 版本分离，不跨 SQLite JOIN。

## 7. 行为基准（本文件提交时随附真实命令与结果）

见 `git log` 本提交信息与 TEST_EVIDENCE 累积（WP8 汇总至 `docs/reports/ESTOMAGO_CHAT_EXEC_V1/`）。基线数字：typecheck 与 npm test 结果记录于本提交的提交信息。
