# estómago · Mac mini 完整架构包 v0.2.1

日期：2026-09-24。整理：林石见。**这是 v0.2 的小功能修订版，同时保留 v0.1/v0.2 的完整架构；旧包不覆盖。**

本包保留 v0.2 的可折叠思考摘要、SDK 显式装配、身份/配置隔离与给char的独立 MD；v0.2.1 新增输入框规则：回车只换行，发送只由独立发送键触发，多行正文保持为一条消息。仍是设计/交接包，不是应用源码、安装包、远程部署或测试通过报告。

## 先看哪份

| 文件 | 给谁／用途 |
|---|---|
| `00_estomago_给宿主用户看的架构_v0.2.1.docx` | 宿主用户：完整体验和边界，保留原章节并补上思考与修订。 |
| `04_estomago_给char看的架构_v0.2.1.md` | char：独立可读的架构，不是身份正文，不要整份当 systemPrompt。 |
| `01_estomago_架构与接口_v0.2.1.md` | 完整主架构，保留原消息/时间/换窗/路由/语音/模块等设计。 |
| `05_estomago_SDK装配与思考流实现细则_v0.2.1.md` | SDK 参数映射、Receipt、增量与完整块核对、回放/中断/隔离。 |
| `02_estomago_实现路径与执行规章_v0.2.1.md` | 实现者：沿用 apps/host 与 Mac 路径，现场探测及执行边界。 |
| `03_estomago_需求与验收矩阵_v0.2.1.json` | 166 项全部 NOT_EXECUTED；原 115 ID 与 v0.2 新增 46 项保留，v0.2.1 新增 5 项 INPUT。 |
| `06_estomago_v0.2.1修订与来源核对.md` | 新旧差异、教程/官方/设计三种来源与未核实事项。 |
| `estomago.example.yaml` | 应用配置草案，不能直接作为 SDK options；未知现场值为 null。 |
| `identity-manifest.example.json` | 批准身份材料与版本模板；不含真实身份/I。 |
| `bootstrap-receipt.example.json` | desired/assembled/observed/probe 的加载证据模板。 |
| `references/user/` | 用户原 PDF 与三张参考图，供实现者核对，不套用其中人物和文案。 |
| `PACKAGE_CHECKS.json`、`MANIFEST.sha256` | 只针对交付文件的检查和校验，不是应用验收。 |

## Mac 放置

建议把本包完整目录放到 `~/Projects/estomago/docs/architecture/v0.2.1/`；这是建议位置，本轮未写入 Mac。项目源码仍建议 `~/Projects/estomago/`；私有数据/配置/运行区在 `~/Library/Application Support/estomago/`，日志在 `~/Library/Logs/estomago/`。

不要以解压为理由覆盖正在开发的代码、复制登录凭据或改旧项目。真正开发前先读 doctor 和执行规章。Mariposa/Siren/许愿星/扎西德勒保持独立，接口与认证需核现场。

## 四个已写入的关键点

身份由批准材料显式加载，Receipt 不能自填假 PASS。摘要走 SDK 实时事件，不用 Stop 扫文件做主通道。摘要可回看但不混成正式原文、hold、TTS 或默认交接。时间每轮刷新，路由仍由宿主用户选择，不被新通道绕过。 输入框 Enter 只换行，独立发送键才提交；用户多行正文不拆消息。

参考图中的“桥下”是候选文案，初始使用“思考”；Telegram 外发不在本版范围。参数、effort、模型容量、Mac依赖与计费来源都待核实，不能以教程版本冒充现场。

## 状态

完成：本架构包文件升级和单独给char的说明。未完成：应用代码、Mac部署、SDK实测、模型调用及正式模块联调。166 项产品验收全部待执行；文件结构/排版检查不得计入其中。
