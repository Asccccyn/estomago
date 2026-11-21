# WP0 · IMPLEMENTATION_MAP（ESTOMAGO_CHAT_EXEC_V1）

产出日期：2026-10-11（Asia/Shanghai）　执行：程知行（GLM）　规范：`ESTOMAGO_CHAT_EXEC_V1`（本目录，2026-10-11 冻结）
施工工作树：`~/Projects/glm1011-estomago`　分支：`glm/chat-exec-v1-20261011`
前代实施图（OR_SELF_HOLD 轮）已加横幅移作历史快照：`../IMPLEMENTATION_MAP.md`。

## 11 月 19 日开窗映射与工具地图裁定

本节记录 2026-11-19 的裁定。早期包 4 与下方 WP0 表保留当时的证据，当前实现以本节的正本归属和调用边界为准。

- Profile 位于 estómago 经审批的身份材料。身份清单以 `approved_source_ref`、`approved_source_hash` 和 `identity_version` 指向它。「我们的记忆锚点」沿用原长期里程碑内容，由同一清单的 `memory_anchors_ref` 和 `memory_anchors_hash` 指向独立的版本文件。里程碑工具沿用原调用路径，已拆分的环境中只读写、回滚独立锚点。旧合并材料沿原接口兼容。2026-11-19 已在生产按批准版本切换两份独立身份材料，并核对 Mariposa I 正本 v11。迁移保留当时的活动窗和冻结工具目录。
- Mariposa 是 I 的唯一当前数据来源。estómago 通过 bootstrap 映射当前 I，`memory_i_write` 调用 M 的条目版本接口。已确认的新本文按原五项映射，保留条目 ID、修订和既有关联。开窗装配依次放 Profile、I、锚点、近三天记忆和计划，再放运行规则与工具。锚点按审批稿顺序展示，预览辅助日期标题无需注入。三天桶按事件日期升序，同日保留服务顺序。原话有独立保存记录时随桶显示，聊天原文另走读取入口。
- 55 项业务定义含 12 项常驻、41 项按需和 2 项随真实任务交付的能力。常驻是 `memory_hold`、`memory_recall`、`memory_read_full`、`memory_update`、`image_generate`、`media_view`、`wake_manage`、`wishstar_write_star`、`wishstar_request_star`、`content_album_entry_write`、`content_albums_read`、`content_post_create`。开窗给可直接调用的简明参数和一条自然提醒。索引复用 `tool_catalog`，查询当前窗口目录并返回冻结的执行合同；`tool_define` 仍可精确读取。全量目录仅按需返回。
- I 和原话的入口分别放在相应开窗资料旁。已实际到期的自主预约把主动文字消息的用法放在当轮宿主提示中。任务工具由真实任务提供，目录枚举、意图查询和定义读取均核对当前活动任务；调用仍按现有权限和冻结版本校验。旧窗已发轨迹与缓存保持冻结。退出的来源绑定不再从旧目录重新发出，后台可信绑定仍走原路径。
- 存档搜索给出 `archive_id`，通过 `conversation_read` 从 Content 同一会话的存档读取固定修订，并使用原文覆盖账本和页游标。聊天定位按原发布日过滤，候选摘要和游标绑定实际命中的修订。候选不会被视为全文，续读的语音转写会明确标注来源。消息行序号留在宿主；旧编号过滤只用于冻结定义仍支持序号的窗口。事件关闭和纠错的单点依据按 Mariposa 的单条来源引用合同映射。
- Claude SDK 将宿主的选集引导装入系统提示，历史消息保持原有说话人和正文。旧 SDK 轨迹中重复嵌入的引导由出站投影去重。API/DS 的选集引导仍位于对应原文旁。

## 11 月 20 日常驻工具补充裁定

- 宿主用户确认，char主动发语音和主动打电话的用法随新窗常驻。新增常驻项为 `chat_send_voice` 和 `call_control`，主动打电话用 `action: invite`。新窗默认的 55 项业务定义分为 14 项常驻、39 项按需、2 项随任务。完整定义仍由工具地图按需交付，旧窗口和已发送历史沿用各自冻结版本。

## 11 月 20 日原生工具调用与中文正文裁定

- 新窗口默认 `runtime.tool_schema_mode=direct`。现行常规工具按各自的业务名称和完整参数定义发布，模型直接填写 `text`、`body`、`caption` 等字段。工具目录和精确查定义继续使用 `tool_catalog`、`tool_define`。常驻提示保留使用说明，完整业务约束可通过 `tool_define` 核对，执行按当窗冻结定义校验。
- 所有由模型撰写的文字字段使用中文，中文直接填汉字。引语以可核对的原文为准，专名和代码使用实际字符。宿主可核验原始 JSON 时，写入前拒绝这些字段里的汉字 Unicode 转义，并明确指出应重交的字段。
- 普通会话与心跳使用同一冻结工具列表，心跳沿用自然收尾。自主活动和换窗评审在当前任务请求中各发布相应的完成工具，执行仍核对可信的活动任务。旧窗口继续依照自己的冻结目录执行，已有的工具调用历史沿原协议读取。

## 11 月 21 日新窗常驻与按需原生调用

新直接调用窗口首轮公布 14 项常驻业务工具和两个地图入口。`tool_catalog` 不带查询时仅列简目，按意图或名称查询唯一命中时启用该项；多个候选仅列名称和简述。`tool_define` 按准确名称启用该项，并可核对冻结参数。新启用的工具在同一用户回合的下一笔模型请求中按业务名接收中文字段。冻结的常驻清单、目录和窗口内按发现顺序追加的工具名各有明确用途；换窗从新清单开始，已有冻结窗口沿用原协议。任务范围、执行校验和中文写入仍由既有业务入口负责。

## 11 月 21 日「我们的话」命中后的自动浮现

est 在当轮校验请求中指定 `words_view=memory_with_words`。Mariposa 按命中的保存引语定位所属记忆，复核可见性和外发权限后返回当前完整事件正文及按保存顺序排列的全部「我们的话」。同一记忆命中多句只投递一份。发送前复核版本，整份放不下时不截断。已读范围只在实际投递后生效；有新增内容时保持整份呈现。模型输入与网页使用相同的正文、引语与身份署名。已冻结的历史浮现包仍可原样回读。独立的绑定原文入口沿用其权限与来源语义。

## 11 月 21 日中途想起的往事

新校验通过的记忆桶在本轮真实输入前单独呈现，以「你想起了一件事——标题，日期。」起笔，接正本的完整事件正文、正式心情标签和有署名的逐字原话。缺失的标题、日期或心情省略，只有原文片段的来源保留真实说话人。Claude SDK、OpenRouter 和 DeepSeek 均用普通上下文承载这段文字。界面以「char想起了一段往事」展示同一笔交付。只有缺口时单独说明核实结果。短引用供深读，来源、版本和已读范围保留在宿主账本。旧轨迹和既有冻结包按原格式回放。

## 新窗工具的能力说明与完整参数

开窗清单按「我可以…… → 工具名」列出常用及按需能力，14 项常用工具与两个地图入口另随原名提供类型、枚举、必填项和对象、数组结构。`tool_catalog` 浏览或搜索只返回名称和一句用途，唯一命中也只列出该项。`tool_define` 按准确名称返回当窗的完整定义，并使按需工具可在同一回合按原名填写中文。执行侧用完整冻结合同校验字段和组合条件。老窗口保留原协议和已发送的资料。

## 0. 现场快照

| 项 | 值 |
|---|---|
| 基线 SHA | `4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1`（preflight `BASELINE_MATCH`：42 文件哈希一致、工作树干净、无脏文件） |
| 执行包自检 | `verify_package.py` PASS：1839 checks / 40 需求 / 114 验收 / 48 路由 / 32 模型工具 / 18 fixtures |
| 运行时 | Node ≥22.18（engines）；运行依赖仅 `@anthropic-ai/claude-agent-sdk@0.3.283`（锁定安装，OR 模式不加载） |
| DB 迁移起点 | 接包时 v20；本轮已推进至 **v26**（v21 system_alerts / v22 usage 归属 / v23 修订快照 / v24 provider 派发证据，全部 additive；后续仍由集成者顺序分配 |
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
| WP1 消耗可见与 token | **已交付（0615877）** | v21 系统告警三表+服务+3 路由；v22 usage 归属列+字段级 fields+按日汇总+USAGE_MISSING 宽限 sweep；v23 修订快照列；estimator 纯函数+token-estimates 路由+web 三层显示；验收 21/21 PASS |
| WP2 上下文与缓存 | **已交付（ab787bc）** | v24 派发账本前移（每次 transport 前准入/逐尝试行/wire_v1 证据）；cache-observation 证据链（计时基准=读写证据请求的 dispatch_started_at；保温目标+50min 滚动；到期恒标估计）；CACHE_UNEXPECTED_MISS 活接线；compact 专项识别+上游冲突别名；records 证据化到期+backgroundPolicy。验收 9 PASS + 3 NOT_EXECUTED（CACHE-04/05/06 依赖 WP4 调度器） |
| WP3 聊天媒体底座 | **已交付 M1+M2（540ef56+c9b7a86）** | v25 三表+媒体服务（魔数/白名单/受控导入/引用守卫）+资产 API+消息附件事务+If-Match；投影器（内部引用形态零 Base64+发送边界确定性物化+wire 脱敏）+视觉门（未核实=MODEL_VISION_UNAVAILABLE 零请求）+选集媒体+归档分列+媒体工具+前端附件。验收 12 PASS + 3 NOT_EXECUTED（语音真实链/作品工具/CSP 预览——归 WP7/内容批） |
| WP4 有界后台 | **已交付（2f4fe04→f6e38f2）** | v26 三表+策略纯函数+原子设置+调度器（默认全关）；HTTP 面八路由（422 门=预算未配置/价格未核验）；提醒零模型投递；模型回路执行器（自主=唤醒尾+工具循环+预算逐派发+chat_send_text/background_complete；保温=单请求+工具拒执行+不推进轨迹）+逐笔派发结算。验收 17 PASS+3 归后续批（付费工具 WP7/幂等回执 WP5/大轨迹 WP8）+CACHE-04/05/06 全补 |
| WP5 内容与朋友圈 | **已交付（0c57778→45ea7e1）** | apps/content 独立进程+est 薄代理+模型工具；朋友圈/三相册/作品/留言。验收 16 PASS+9 归后续批 |
| WP6 日历与关联 | 待做 | 聚合页面 + 分源分页 + 事件日/北京日界 |
| WP7 外部合同连接 | 待做 | MCP 薄层 + 逐能力 expected/observed |
| WP8 联合审计交付 | 待做 | fresh/upgrade 验收 + 四份报告 |

迁移纪律：本轮新迁移自 v21 起顺序分配（集成者=GLM 本轮）；est 与 content 两库 schema 版本分离，不跨 SQLite JOIN。

## 7. 行为基准（本文件提交时随附真实命令与结果）

见 `git log` 本提交信息与 TEST_EVIDENCE 累积（WP8 汇总至 `docs/reports/ESTOMAGO_CHAT_EXEC_V1/`）。基线数字：typecheck 与 npm test 结果记录于本提交的提交信息。
