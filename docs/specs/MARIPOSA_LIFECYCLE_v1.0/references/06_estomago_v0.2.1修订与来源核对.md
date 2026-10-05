# estómago v0.2.1 · 修订记录与来源核对

日期：2026-09-24。基线：本对话原始 `estomago_architecture_v0.1.zip`。原 ZIP SHA-256：`1f217e83f1c747e747e48ee8a5e9cf2384fe3ec0cba5d27fc84ca352ae0e159b`。

## 1. 完成了什么，没有完成什么

完成：在旧完整文档上增量更新主架构、执行路径、Word、应用配置、身份模板、验收矩阵；新增 04 给周家明说明、05 专项实现细则、Bootstrap Receipt 模板和本修订记录。旧 v0.1 文件不覆盖，新包可独立阅读，不是只发补丁。

**v0.2.1 小修订：** 增加输入框交互硬规则——Enter 只换行，发送只由独立发送键触发；IME 候选确认不得误发送；多行正文作为一条消息完整保存、编辑和归档。此改动不影响 SDK 思考流、路由、换窗或 Mariposa 语义。

没有完成：应用代码、SDK安装、Mac写入/远程操作、真正的模型调用、真实思考流、身份正本装载、订阅/计费验证、现有服务联调、Telegram发送。文件包校验与 Word 排版检查不是产品验收。

原 115 个验收 ID 全部保留，v0.2 的 46 项（CFG 12、BOOT 4、THINK 30）继续保留；v0.2.1 再新增 5 项 INPUT，合计 166；全部 NOT_EXECUTED。每个旧项的前后原句在 JSON revision_log，未伪造历史通过。

## 2. 对话中容易误传的说法，按本版替换

| 旧说法/误解 | 本版实际要求 |
|---|---|
| 有业务能力就不能 tools:[] | 可以清空内置 tools，同时显式注册业务 MCP；免审批列表不是工具目录。 |
| settingSources:[] 就隔离全部来源 | 仅是一部分；另查全局配置、自动记忆、连接器、环境和托管策略。 |
| 把时间放到动态 SP 边界即可不断更新 | 边界是缓存优化；每轮状态动态注入，恢复时系统提示快照另验。 |
| 完整 ThinkingBlock 一到就是实时逐片流 | 开启 partial events 接 thinking_delta；完整块做核对而非重复追加。 |
| Stop 后读 transcript 一定能取得本轮完整思考 | 可能滞后，仅作事后诊断；主路径是 SDK 增量与完整块。 |
| signature 可解出思维链／空摘要等于没思考 | 不还原签名；只展示官方可读摘要，空/删隐/缺失分别说明。 |
| Bootstrap Receipt 自己写 PASS 就验到了 | 区分目标、装配、观测、probe；未知不伪装false。 |
| 所有 text/reasoning 共用正文流 | 单独类型、存储、权限和投影；摘要不入原文/TTS/默认交接。 |
| 参考图的桥下、人物、Telegram必须照做 | 只取实现参考；标签待定，不添加Telegram产品依赖。 |
| 教程用 Python，所以要多开 Python 服务 | 沿用原 TypeScript 和 apps/host；不新建 apps/server 并行后端。 |

## 3. 来源 A：用户教程支持到哪里

PDF p2：自建前端通常直接在后端装配 SDK，不必额外转接服务。p3–5：systemPrompt、来源与工具目录/审批分开。p6：内置空目录与自定义 MCP 可共存。p7：工具说明含使用时机、返回与副作用。p11：以装配与事件证据验收，不凭模型自述。这些是教程陈述；其“本仓实测”原仓库没有随 PDF 提供，不能冒充我们核验过作者源码。

首张截图提供 Python thinking adaptive/summarized 与 ThinkingBlock/TextBlock 分流思路；效果截图说明可折叠显示。最后截图提供 showThinkingSummaries、Stop hook、transcript 与 Telegram 事后发送路线；它本身没有证明 Mac 上版本、异常路径、实时增量或我们的前端已经可用。

原始材料逐字节随包保存，不把其中人物/身份/路径作为 estómago 的产品配置。文件校验如下：

| 文件 | 用途 | SHA-256 |
|---|---|---|
| `给机看的教程.pdf` | 用户11页PDF；版本锚0.3.234/0.144.5，2026-08-21 | `c9fa84f84b51633be01f2e70c12cae27663b3e9cda97836745c4b44609696225` |
| `IMG_3428.jpeg` | 用户：thinking参数与块分流教程 | `efc9b62d4a40c60db9d8f65cc4cb0edc17f174f7a045b0079f794242c10a9b0e` |
| `IMG_3429.jpeg` | 用户：思考展示效果参考 | `3c7bb475be39216c6ca8a7d721f7106207311fcb149a4afb78105896885e8fc6` |
| `IMG_3435.jpeg` | 用户：Stop hook/Telegram转发截图 | `3ef3d70fcdd374a4a184b57a177218504fd445e075515546cc07b1b723bb513c` |

## 4. 来源 B：本轮官方复核（2026-09-24）

以下是公开说明，仍非 Mac 实测。原 v0.1 的 Apple/SQLite/其他业务来源保留在 01，不因本次 SDK 修订声称全部重验。

| 编号 | 官方来源 | 本轮核对点 |
|---|---|---|
| T1 | https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts | 最小/自定义/preset；缓存边界；恢复提示记录与动态上下文路径。 |
| T3 | https://code.claude.com/docs/en/agent-sdk/claude-code-features | settingSources范围；自动记忆、连接器、全局配置与托管来源。 |
| T6 | https://code.claude.com/docs/en/hooks | transcript异步写入、Stop/异常/加载事件，不依赖文件收齐。 |
| T8 | https://code.claude.com/docs/en/model-config | showThinkingSummaries与模型配置；路由设置的作用范围沿用并待实机核对。 |
| T9 | https://code.claude.com/docs/en/agent-sdk/streaming-output | includePartialMessages；部分事件+完整块；块/消息/整轮边界；子代理流限制。 |
| T16 | https://platform.claude.com/docs/en/build-with-claude/thinking | summarized/omitted/redacted、签名保留、空摘要、用量口径。 |
| T17 | https://code.claude.com/docs/en/agent-sdk/python | Python教程参数对照，不代表选用Python服务。 |
| T18 | https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview | 实验V2接口已移除；用受支持query方式。 |
| T19 | https://code.claude.com/docs/en/agent-sdk/overview | SDK仍有agent loop/上下文等；认证使用与第三方产品限制。 |

本轮 TypeScript 巨型参考页直接抓取失败，未伪装已读完整类型；具体字段组合仍应由锁定安装包类型与真实 fixture 核验。对照文档、Python类型和用户示例只能支持装配方向，不能代替 TypeScript 编译或 Mac 运行结果。未知模型、SDK版本、effort与容量未填默认成功值。

## 5. 来源 C：本项目设计，不冒充教程/SDK自带

采用独立 reasoning_blocks 与持久 stream sequence；正常界面默认折叠；SDK实时流主采集、完整块核对；摘要不入正式原文/自动hold/TTS/默认交接；统一中断fence和路由gate；Receipt 四层证据；沿用 apps/host、Mac私有运行目录与旧业务服务边界。这些是上轮复核后整理成的实现约定，可由后续明确业务决定调整，不能反过来覆盖用户需求。

## 6. 旧验收项修订索引

| ID | 新期望 |
|---|---|
| EST-ID-04 | 审计 managed/global/env/auto memory/MCP；明确关闭自动记忆与未选连接器，不能把 settingSources:[] 当全部隔离；受管策略不可绕过。 |
| EST-ID-06 | 合成会话验证身份、参与者与规则；对照装配证据和可观察加载信息，不以模型自报身份或自填 receipt 代替证据；不写正式记忆。 |
| EST-MSG-06 | 未发布正文不入正式原文；已发布内容中断后保留。用户可展开的官方思考摘要另存为运行材料，不冒充聊天原文、我们的话或正式 hold。 |
| EST-WIN-05 | 正式 hold 与临时 handoff 分开；只以获准对话和已核实工具结果为交接材料，不自动回灌 UI 思考摘要或事后补造当时心情。 |
| EST-TIME-01 | 每轮实际执行前刷新 Time Context；恢复会话和长工具之后仍可刷新，不依赖首轮 systemPrompt 或缓存边界自动更新时间。 |
| EST-USE-04 | 使用 SDK 可取得的最终输出统计并标 scope；不按思考摘要字数当真实思考消耗，不重复加进已含思考的 output_tokens。 |
| EST-ROUTE-07 | 路由待决时普通输入/唤醒不继续模型生成；未发布气泡/TTS/思考增量受 fence 管理，已经可见的本 attempt 内容保留并标状态；新 attempt 不续接旧摘要。 |
| EST-OUT-01 | partial delta 与随后完整块按 attempt/message/block 关联；完整块核对定稿而非重复追加。text 与 thinking 独立，不能把 content[0] 永远当 SDK block 0。 |

## 7. 交付内容校验

本包另附 `PACKAGE_CHECKS.json`，记录只涉及文件的结构检查与 Word 渲染检查。它不修改 03 的运行状态，不可计入 166 项产品验收结果。`MANIFEST.sha256` 为本包除自身外全部交付文件校验。
