# 记忆接口与自主工具包施工记录

本文件记录实施证据；唯一业务裁定为宿主用户本轮 2026-11-04 执行稿。P0–P5 代码与离线验收完成，已部署 E 8bbb246 / M db3669f。预约唤醒和心跳已开启、自由活动关闭；生产证据与剩余限制见末节。没有发起真实模型试用。

## P0 基线与链路

- E 原分支 unified-main-20261102，HEAD 0bd12eb212153f86159a885102bf6c0c357e05b5；原工作区 apps/web/dist/chat-app.js、index.html 已修改，均保留。
- M 原分支 main，HEAD cefc80a000cb70e82219dbfdbfbeafa0adfb0030；未跟踪 docs/drafts/ 保留。
- 两仓隔离 worktree 分支 fix/autonomous-tools-20261104；复用原依赖、既有测试入口，无生产数据库或真实外发。
- LaunchAgent 指向原仓工作目录；E/M 实际程序由现有 start.sh 启动，最终加载版本尚待只读核验。content 直接加载原仓 apps/content/src/main.ts。
- 原基线经真实 Host.create（不 start）完整装配 49 项，含 chat_send_voice。JSON 43904 B；假设全部预载时 initial 44424 B；三个发现入口 877 B。UTF-8、JSON.stringify 口径，无 tokenizer 计量。

| 路径 | 现行实现 |
| --- | --- |
| 模型入口/窗口 | runtime/supervisor.ts → runtime/tool-discovery.ts 的 window_toolsets |
| 解析/执行 | ModelToolBridge → executeRegisteredCapability → descriptor.parse/run/toModel |
| 记忆 descriptor | modules/memory/module.ts，服务 modules/memory/service.ts |
| E→M | integrations/mariposa/client.ts；POST /api/capability/<name>，arguments 信封；默认 legacy HTTP data（没有 compact_v1） |
| M | capabilities/input_schemas.py → registry.invoke → 各领域服务；HTTP 返回与 compact MCP 分开 |
| 模型结果 | modules/memory/projection.ts；失败 runtime/model-results.ts |
| 出站 | API supervisor 工具循环；SDK sdk-mcp.ts / sdk-host-query.ts / sdk-history.ts（P3 已补真实图块和回放） |

P1 动作链：emotion → emotion.context.get；trace → memory.relations.trace；plans_read(include_links) → plan.get；plan_link → plan.memory.correct；item_history → i.item.history → i.item.relations.correct；分类 → memory.hold；里程碑 → IdentityMilestoneService → IdentityService。

## P1 改动与验证

补通 emotion/schema/结果、trace 默认 5 与 1–10 公开边界及主体、计划 links 查询/纠错回执；I 关系定位说明指向 item_history。解除普通分类单选。整版里程碑覆盖在文件/manifest/成功审计之前比较条目多重集，只忽略编号，必须真实 boolean true 确认遗漏。复用现有 Ajv 校验 frozen schema，不强转/填默认/删除字段；未知 hold 恢复信息放入保留的 detail。

- A01–A04：既有 scripts/verify-mariposa-bootstrap.py 增加 --case memory-tools，使用合成领域数据和隔离 loopback HTTP，经过冻结定义、tool_define 已发送事实、ModelToolBridge、真实 E HTTP 客户端、M 领域服务和最终投影。计划与 I 关系均读定位 ID → 纠错 → 读回。命令退出 0。
- A05/A06：npm test 定向 milestone-self-maintain、frozen-schema-validation、tool-discovery、wp3-i-plans-read、wp5-correct-deletion。首次 4/5 文件通过，新校验夹具缺必填字段导致错误优先级不符；修正夹具后仅复跑该文件，退出 0。未为旧错误预期改变生产行为。
- M pytest 指定 TestTraceSemantics、分类隔离及已有分支/环场景，38 passed，20 deselected，退出 0。拒绝隔离类混选后确认没有记忆或来源绑定。
- 类型检查尚有基线错误（浮现、oído、voice、SDK、supervisor），未改宽类型或隐藏失败；日志在本轮工作目录 evidence。
- 测试均前台有界，无真实 Claude/OR/JEV/TTS；真实模型可读性尚未实测。

共享契约生成、媒体/新窗包/自主闭环尚未验收；不得将上述 P1 结果扩称 A01–A23 完成。


## P2 正文、详情和续查

候选以自身 content_version 从 version_body 解析正式正文。分词增加原文位置映射，不改 token 序列、索引或评分；句末收口不会截掉已定位的文末命中。_row.event_text 与 _matched.event_text 都携带原文，JEV 既有投影缓存身份自然变化。关闭判断时复用同一正文解析，不再自行判 event_text/hold_text。

recall_receipts 新增 detail_json（M runtime 19）记录窄资源和版本事实，不复制正文。引用计入预算后，只提交最终出站候选的回执；分页尚未交付的引用不可读。E 从本房间/窗口的已发送工具结果核验 memory_ref，再用原 detail reader；words 只读自己的话语及获许可来源，不授权任意父桶。首读新版标 changed_since_surface，中途变版 stale；没有明确打开、回温或新检索副作用。

M 在同一提交事务内按真实首轮事实与既有 gate 决定深查理由；E 生成结构化 next，引用当前冻结 schema 校验。新增可选 deep_continue_ref 适配 M 既有 continuation_token，区分冻结结果集翻页和同一 raw 轮续页，不改变会话/权限/预算门。此为参数结构变更，不是文案缩短。

- M 定向回归 65 项退出 0；增加预算裁卡与原文连续分页案例后，本批专用 6 项退出 0。实际外部 JEV 为 HTTP fake，真实解析/投影/缓存运行，无真实付费请求。
- E 4 个相关回归文件首次暴露旧 continuation_note 预期；更新为真实结构化结果，合并重复文案测试，失败的 3 文件复跑退出 0。通过的 recall-next 不重复扩大复跑。
- 既有隔离 HTTP runner 最终退出 0：冻结入口→真实 M→投影→已发送事实→详情；未发送拒绝，全文不再 recall/open；普通 next、结果集分页、raw 深查/续页的 next 原样调用，25 条来源无重无漏。
- 生产正文/索引/旧窗口/配置未写；迁移仅在临时库执行。真实模型可读性尚未实测。


## P3 内容分页与图片发送

朋友圈按 published_at/id 倒序向后取；相册应用 created_at/id 游标；游标绑定相册/查询。新增同一 content 服务的只读相册索引，MediaToolsService 结合当前房间已发布附件、可读相册和现有 oído 来源授权，作为 SDK/API 共用图片 resolver；保存资产本身不构成可读资格。

SDK MCP 返回真实 image 块，成功/失败投递结果同轨迹；轨迹只保留 asset_image 引用。SDK 历史及 API 在发送处物化并重新核验当前权限；通道不支持时明确未交付。没有 base64 写入普通工具 JSON/历史。

- album-image-delivery.integration：真实临时 ContentServer、MCP 内存协议、实际 MediaService，7 条同时间记录多页、插入新项、错作用域游标、草稿/跨房间拒读、SDK/API 图块与撤销后回放拒绝；2 项退出 0。
- 既有 b1-view-native-image、exec-v1-wp3-model、sdk-host-continuity、exec-v1-wp5-content，4 文件退出 0。
- 类型检查本批未新增错误；SDK 媒体相关旧类型错误已随真实图片块类型收口。剩余浮现/oído/voice 与 supervisor 的基线类型问题仍记录，不称类型检查通过。
- 新模型入口在 P4 注册；本批没有真实模型调用、发图或生产相册变更。


## P4 目录、冻结和共享契约

真实 registry 现有 49 个新窗工具：40 C、7 D、2 T。额外注册的 6 个旧只读名仅供持久旧窗，直接复用同一领域服务；旧 memory_correct 日常动作仍由同一业务函数处理，新 schema 只留纠错。没有二次 ModelToolBridge、重复计费或双写。

E migration 53 扩展既有 window_toolsets（groups_json、initial_text）和 provider_requests（tool_context_json）。初始包独立于 M bootstrap；冻结 schema/分组/文本只在新窗解析。旧字段只能由已有真实交付恢复。任务定义追加到既有宿主任务尾部，可信来源与 sent_at 共同参与 invoke/define 的同一已见判定。普通聊天复制完整定义或仅提 ID、未发送的 define，都不能建立资格。

M 正本提交 `c52739d`，制品提交 `db3669f`；原 export_contracts.py 现导出实际 input_schema、QueryPlan 字段/默认/限制及来源提交/文件指纹。分类/隔离类、心情、关系类型和 trace 深度来自领域正本；E 构建时显式同步制品，运行时仅新窗沿现有 vocab 链刷新动态词表。宿主 seq/句区间、事件范围、说话人、来源哈希与操作身份适配保留。旧源码正则对照及无实际边界覆盖的历史测试已移除，改用生成制品过期检测及两仓 HTTP 验收；独立序列化字节验证保留。

新增可执行前门已贯通：memory_words_write、memory_relations、content_albums_read、media_view、episode_read、wishstar_read。hold 绑定成功回包保留已核实 source_selections，供 episode_apply 使用；全文 words 保留 word_id/source_binding_version；I restore 透传其已声明的 relations，空关系列表和单计划显式空正文保留。核对还发现 emotion 的文字数量原来把仅有标签的行算入，现只计确有文字的行。

许愿星读取按用户后续明确裁定增加 what=requests：原四分支外接入现有 GET /api/requests，不增加工具名。实际领域合成 DTO 验证拆星/收星正文、请求定位和状态字段；已提交但回包缺正文或网络结果未知时不宣称未执行。字数上限从实际领域源码生成；没有改第三仓。保留原状态、主体、通话资格和原费用键。

验证：

- 完整 Host.create + fake SDK + 实际 MCP/桥接：40 C 均从真实请求直接 invoke；D 执行 define 但未发送时拒绝，实际进入下一请求后可调用；bootstrap 故障仍包含本地包；热配置及重启不改旧窗。
- 任务定义单测通过正式 invoke 完成真实隔离 review；无活动 review 仍拒绝；后台 T 的调度贯穿留在 P5 验证。
- 旧窗 6 名/旧 trace 动作逐个调用一次原服务；新窗不重复列旧名，原始快照字节不变。
- M 共享契约/现有查询/详情/计划合同 30 项通过；新增心情计数与有效负分 rank_only 案例分别通过。E 共享制品过期检测、许愿星各分支、媒体前门及相关回归通过；9 个相关旧回归文件通过。类型检查退出 0。
- 既有浮现恢复分支读了 SurfaceItem 不存在的 text 字段，类型检查暴露此错配；改为复用 projectSurfacedMemory，未新增调度门。语音目标改为只解析一次，其余 SQLite/Pick 类型与实际实现一致。

当前生成包：C 定义文本 39,400 B，D 索引 607 B，三个发现入口 877 B，集中宿主规则增量 105 B，共 40,989 UTF-8 B（约 40.0 KiB）。高于执行稿设计样稿；实际合同补充了条件、真实定位/恢复路径与新增参数，未为凑体积删除能力或提高窗口预算。最终值会在 P5 后重新生成。没有 tokenizer 实测。

纯 description 差异与参数结构变化由 scripts/export-tool-package.mjs 分开生成；当前生成的模型材料和差异见本轮 evidence/p4-package。工程合同已验证，实际模型可读性尚未实测。

## 后续明确裁定

用户要求启用自设预约唤醒与心跳、关闭额外自由活动；明确选择“只关闭额外自主任务，预约和心跳仍可自主行动”，其余能力/行为不变。若共用开关应解耦。费用此前指示暂不设日上限，将以明确 unlimited 状态表达，保留 null=未配置及既有次数、时长、报价和权限门。生产设置尚未修改；不创建测试预约、不执行真实模型实验。


## P5：只关闭额外自由活动

保留 `autonomous` 既有接口含义（`origin=self_schedule` 的预约），增加 `free_activity` 控制其余自主任务，`keepwarm` 保持独立。选择由现有任务 `kind/origin` 派生，同一调度器、执行器、账本和运行限制；无新任务类型或数据库表。关闭自由活动不会取消正在执行的预约。醒来后的工具资格、正式发言出口、心跳睡眠时段、提醒、同会话排队均保持原规则。

按用户“暂时不设置上限”，费用字段新增明确字符串 `unlimited`；`null` 仍表示未配置。报价、权限、每轮模型/工具次数、运行时限照旧。页面只增加对应控制和无日上限选项，按原流程构建 dist。正式修改仍使用设置 HTTP 服务、If-Match 与幂等键，未直接写生产数据库。

离线闭环使用现有 `verify-mariposa-bootstrap.py --case autonomy-loop` 与 `scripts/audit/background-product.ts`：普通回合经完整 C 定义预约→受控时钟到期→真实临时 M 的 recall/hold→领域生成的星回包发送桩→正式 chat_send_text→Siren 邀请发送桩→再次预约→background_complete→重启→第二次 noop。第一轮 7 次工具、2 次模型请求，未提高生产单轮限制；结束当前任务不删除下一任务，没有无限循环。全部 C 定义和 T 定义由真实 API 请求投影记录已发送证据。发送桩不证明真实模型选择或外部消息投递。

收尾补修两个既有出口：M 长事件分页用 `fragment` 交付正文，E 原投影漏掉该结构；现保留片段、来源版本及不完整标识，真实 HTTP 长正文逐字拼回。oído 图块链路已接通，成功回包改为图片引用，删除误称“ui_only”的文案，字节仍仅在出站物化。

最终包（完整 Host.create 装配）：40 C、7 D、2 T，新目录 49 项，另保留 6 个旧窗薄别名。C 定义文本 39,539 B，D 索引 607 B，发现入口 877 B，集中规则增量 105 B，总计 **41,128 UTF-8 B**，约 40.2 KiB。基线 49 定义 compact JSON 43,904 B；新完整目录 compact JSON 45,273 B。前者不是原本实际预载体积；不与 initial 文本重复相加。没有可信 tokenizer/费用实测。

生成材料在本轮 `evidence/final-package/`：完整 `tool-package.json`、`initial-tools.txt`、`tool-matrix.md`、逐字段 `copy-and-schema-diff.json` 与 `copy-review.md`。M 共用合同源提交 c52739d，生成提交 db3669f；E 消费固定副本，--check 检出过期。共享字段、引用选择与宿主身份适配的范围见 P4，未复制整份 M schema 充当 E 参数。

### A01–A23 证据索引

证据均为本轮 workspace/evidence 下的合成数据；含真实临时领域 HTTP，不含真实私密正文。路径是实验结果，不是供应商网络抓包。

| 编号 | 实施后证据与范围 |
| --- | --- |
| A01 | final-http-fragments-verified：emotion 经 frozen schema/bridge/实际 HTTP/toModel，词表、0、false 保留 |
| A02 | 同上 trace 默认 5/上界 10/越界拒绝；M p1-mariposa.log 的分支/环/深度测试 |
| A03 | 同上从 plan.get links、I item_history 取真实 ID，纠错后读回 |
| A04 | 同上普通多选和 diary 通过，隔离混选拒绝；P1 M 验证无半条写入 |
| A05 | p1-unit.log / p1-schema.log：覆盖比较、重复项、严格布尔、版本未改 |
| A06 | frozen-schema-validation、shared-tool-contract；p4-regression.log / p4-contract-and-surface.log，实际动作分支与恢复投影 |
| A07 | p2-mariposa-first.log / p2-regression.log；final-http-fragments-verified 长正文分页逐字拼回 |
| A08 | M test_memory_delivery_20261104.py：真实证据进入 JEV 边界（fake HTTP），旧证据缓存不复用 |
| A09 | final-http-fragments-verified：已发送 recall 引用→原 detail reader；仅一次 detail HTTP，无新 recall/JEV/open |
| A10 | E 仅执行未发送拒绝；M 未翻页/预算裁掉/伪造/主体来源门，p2-regression.log |
| A11 | M test_memory_delivery_20261104.py：首读变化标记、分页 stale、word/source 授权层级 |
| A12 | final-http-fragments-verified 的 next 原样调用，raw 25 来源页；M 零命中理由/门/低负分 rank_only |
| A13 | p3-media.log / final-p5-regression.log：多页、同时间 ID、新插入、scope 游标 |
| A14 | final-p5-regression.log：真实 MCP image 块、API image、SDK 历史 tool_result image；草稿与撤销拒读，日志仅类型/字节计数 |
| A15 | p4-package-final.log：真实 Host fake SDK 直接调用全部 40 C、D 实际发送后可用；P5 T 经正式 invoke 完成 |
| A16 | p4-window-unit.log / frozen-tool-package / p5-autonomy-loop-final：热配置、重启、旧动作单次薄映射 |
| A17 | frozen-tool-package：M bootstrap 503 不吞 C；后端不可用如实返回 |
| A18 | p5-autonomy-loop-final、p5-http-product.log：真实宿主/临时 M、发送桩、再次预约/重启/noop；用户可见发言只经正式工具 |
| A19 | p4-wishstar-final.log：领域源码生成 DTO；5 读分支、request_id、打开星正文/状态/不确定回包 |
| A20 | final-package.log + final-package/：完整生产装配、49 名称、40/7/2、41,128 B；tokenizer 未实测 |
| A21 | p4-window-unit.log / final-http-fragments-verified：新合并分支各调用原服务一次，旧名仍可用；原价格键/通话资格保留 |
| A22 | p4-m-contract.log / shared-tool-contract / --check；final-http-fragments-verified 的 quotes/source_ranges/mood 与 recall 阶段适配 |
| A23 | final-package/copy-review.md + copy-and-schema-diff.json；下述隔离场景。实际模型可读性尚未实测 |

### 运行命令与未解决项

每条测试前台串行、临时 ESTOMAGO_HOME。测试命令/输出保存在日志；失败后先核对实际合同：旧 SQL 夹具缺真实 task/origin、启用心跳后多一条系统任务、长事件载体实际为 evidence_snippet。这些夹具已修正并针对性复跑，未改业务去迎合错误预期。

- `npm test -- --unit --file=tests/unit/wake-keepwarm.test.ts --file=tests/unit/exec-v1-wp4-background.test.ts` → p5-controls-unit.log，退出 0。
- `npm test` 指定 keepwarm-sleep、full-audit-background-ledger、full-audit-background-failures → p5-existing-unit.log 中这三文件退出 0；同批旧夹具失败由前项复核。
- `npm test` 指定 background-product-chain → p5-http-product.log，该文件退出 0；HTTP management 首次预期未计心跳系统任务，后在 p5-final-targeted.log 退出 0。
- `npm test` 指定 oído façade / recall projection / background management → p5-final-targeted.log，退出 0。
- `npm test` 指定 executor / wake-wire / wake / background-controls-model / catalog golden / album-image-delivery 六文件 → final-p5-regression.log，退出 0。
- `python3 scripts/verify-mariposa-bootstrap.py --mariposa-repo ../mariposa --python <M .venv/bin/python> --case autonomy-loop --port 18884 --output ../evidence/p5-autonomy-loop-final` → 退出 0。
- 同一命令 `--case memory-tools --output ../evidence/final-http-fragments-verified` → 退出 0。
- `npm run typecheck`、`npm run typecheck:web` → 退出 0；`npm run build:web` 初次 Vite 临时缓存写权限拒绝，获工具沙箱授权后按原命令成功（p5-web-build-verified.log），没有改变构建流程。

旧窗兼容只在该窗冻结目录允许时使用：memory_correct 旧日常动作和 episode_list/get、许愿星四旧读名直接调用同一业务函数，不二次 bridge/计费/双写。只有没有未结束窗口再引用旧名/旧动作后才能清理；审计历史不删除。覆盖安全修复立即生效，旧 schema 不能以无 confirm_overwrite 绕过保护。

工程合同已验证，实际模型可读性尚未实测。没有向char发消息、没有真实 Claude/OR/JEV/TTS 试验。普通召回 rank_only、原文第二轮 gate、详情不等于明确打开、通话期 memory_only、原预算和权限/来源策略均未放宽。


## 生产发布与核验（2026-11-04，Asia/Shanghai）

已按原固定发布目录 + LaunchAgent 流程部署，未改网络/隧道/凭据。设置通过正式 HTTP PUT、If-Match=0、专用幂等键提交，回执 revision=1。备份目录为 `/Users/owner/Backups/pre-memory-autonomy-20261104-8bbb246`，包含 5 个 SQLite 快照、原启动脚本、plist 和 E config。系统 Python 读取 M SQLite 失败后，使用实际 M venv 的 SQLite 3.53.4 完成有时限备份；未借此改库格式或覆盖正式文件。

| 核对项 | 实测 |
| --- | --- |
| E/Content 进程 cwd | `/Users/owner/Projects/estomago-releases/memory-autonomy-20261104-8bbb246` |
| E 代码提交 | `8bbb2469b1f84dbe6f8874f64d969d5c3e51ca86`，schema 53 |
| M 进程 cwd | `/Users/owner/Projects/mariposa-releases/memory-autonomy-20261104-db3669f` |
| M 代码提交 | `db3669f215e3ed417a3cdd75fe42d899c624c4ba`，runtime schema 19 |
| 健康 | E ready=true / degraded=[]；M health 200；Content 实际只读 albums 返回三种现有相册 |
| 预约 | autonomous.enabled=true，daily_cost_cap_usd=unlimited，executor_ready=true |
| 心跳 | keepwarm.enabled=true，daily_cost_cap_usd=unlimited，executor_ready=true |
| 自由活动 | free_activity.enabled=false，未配置的费用字段仍为 null |
| 保持原值 | reminders.enabled=true；睡眠 23:00–08:00 Asia/Shanghai；原单轮次数/运行时限、报价、通话和权限门 |
| 当前旧窗 | 42 项冻结目录；SHA-256 `01474414caec077f8dc75835c9b0a061163f131f8d95dc6388522d9908002d6a` |
| 历史不改 | messages / revisions / windows / trajectories / 原 toolsets 列 / provider_requests 的发布前后指纹一致，模型请求仍 923 条 |
| 正式记忆不改 | 16 个相关正式表与发布前备份比较一致，含正文版本、词句、来源绑定、关系和向量；无全库重写 |

生产证据：本轮 `evidence/deployment-verified.json`、`deployment-domain-readback.json`、`deployment-cutover.json`。真实业务夹具写入为 0；没有为了验收发消息、拨号、写星、hold 或建立预约。开启心跳后的正常到期执行属于用户授权功能，不是本轮人为推理试验。

代码、窗口和开关分别核验：当前旧窗没有新字段冻结资料，其旧目录/历史保留不动；正常新窗才解析新的 40/7/2。尚未取得生产新窗已发送的完整定义请求，不能称为“生产新窗自主工具包已实测可用”。隔离请求经过真实 SDK/API 适配，但不宣称是供应商逐字节网络证据。

生产 `background_tool_prices` 未配置。按“其他什么都不变”保留已有报价门，因此受该门约束的后台记忆/许愿星/通话等调用可能返回 BUDGET_ESTIMATE_UNAVAILABLE。没有擅自编造费用、标记免费或用 unlimited 绕过它。预约通道与心跳开关已实际可用；完整后台业务动作的真实效果仍依赖既有运行条件和正常使用反馈。

补充字节对照：用原仓真实 renderInitialVisibleText 和完整基线目录测得，旧默认单项里程碑文本 1,884 B，加发现入口 877 B 为 2,761 B，且只在原 bootstrap 成功注入条件成立时存在；不能把这个条件值当当前旧窗已经收到的包。新离线完整快照为 41,128 B。动态心情词表在新窗实际解析时冻结，最终生产请求仍需按该窗快照核算，未虚报目标 tokenizer 数字。

实现提交：E P1 `69364ad`、P2 `f76d13f`、P3 `a6b915d`、P4 `ae95541`、P5 `8bbb246`；M P1 `223e087`、P2 `0d684d0`、P4 `c52739d` 与生成制品 `db3669f`。实现保存在两仓 worktree 的 `fix/autonomous-tools-20261104`，并按后续“维护基线”要求快进同步到 E `unified-main-20261102` 与 M `main`；没有 push。本次基线维护只补现行文档索引，不再次发布或改运行设置。原 E 工作树的两份未提交 dist 和 M 的 docs/drafts 均原样保留，发布不依赖或覆盖它们。

回退沿原流程：先经当前正式设置接口恢复保存的开关/预算（用当时最新 revision；不要把 unlimited 留给不认识它的旧预算代码），再恢复备份启动脚本/content plist 并重启对应 LaunchAgent。保留增量迁移与新业务记录，不用旧库快照覆盖运行数据。恢复点和发布路径已提供，不新增长期路由或版本分发系统。

隔离评审材料：`evidence/final-package/review-scenarios.md`，配套同目录完整定义、矩阵、文案与 schema 差异。**工程合同已验证，实际模型可读性尚未实测。**
