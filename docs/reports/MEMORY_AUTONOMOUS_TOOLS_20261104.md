# 记忆接口与自主工具包施工记录

本文件记录实施证据；唯一业务裁定为宿主用户本轮 2026-11-04 执行稿。当前仅完成 P0/P1，P2–P5 未完成，未部署、未调用真实模型。

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

共享契约生成、正文/详情/媒体/新窗包/自主闭环尚未验收；不得将上述 P1 结果扩称 A01–A23 完成。
