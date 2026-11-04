# 记忆接口与自主工具包施工记录

本文件记录实施证据；唯一业务裁定为宿主用户本轮 2026-11-04 执行稿。当前已完成 P0–P3 的代码与针对性隔离验证，P4/P5 未完成，未部署、未调用真实模型。

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
| 出站 | API supervisor 工具循环；SDK sdk-mcp.ts / sdk-host-query.ts / sdk-history.ts（P3 待补图像） |

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
