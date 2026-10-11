# estómago 聊天与统一前端：GLM 执行包

规范标识：ESTOMAGO_CHAT_EXEC_V1
冻结时间：2026-10-11，Asia/Shanghai
用户：user；主模型身份：char；架构整理：林石见
源码基线：Asccccyn/estomago / main / 4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1
本包性质：可执行架构与施工合同；不是已实现代码，不包含生产凭据、聊天正文或历史源码副本。

## 给 GLM 的任务

在现有 estómago 上分批落地本包。保持一个统一前端、一个精简聊天后端；已有外部项目继续独立。新增的相册、纪念作品和私密朋友圈集中在一个可选内容后端，不能把每个功能再拆一个服务。

先读 01、02，再按 07 的工作包推进。每批先核当前 HEAD 与本包基线的差异，复用已经实现的代码，不用旧架构包的 source 快照覆盖当前文件。遇到外部合同未核实的项，完成本仓可完成的接线和测试，记录精确阻塞；不得编造接口、伪造成功或把整个任务停在一句“待接入”。

## 已冻结的关键口径

1. est 内置：聊天与历史、附件消息、模型与上下文、工具接入、基础设置/用量、轻量调度。
2. 日历是统一前端内的聚合页面。聊天数据由 est 提供，桶/正式计划由 Mariposa 提供，星星重要日期由 Superposition 提供。日历不另存可独立编辑的桶、计划或星星正本。
3. 桶按事件真实发生日期；聊天按北京时间自然日；星星仅按其重要日进入日历，读取日历不拆星。
4. 新私密朋友圈与扎西德勒分开；user、char均能看、发帖、评论。letter 是同一内容模型的展示形式。
5. 自动唤醒有明确总开关；自主活动、缓存保温、普通定时投递分别控制。关闭自主唤醒后，不再偷偷启动自主模型活动。
6. Claude 缓存 TTL=1h，空闲保温目标=50 分钟；自主活动滚动 60 分钟最多开始一轮。普通聊天不受这个后台限频。
7. 保持 64k 受控换窗与人工原文选集，允许零选；不自动摘要替代历史，不因缓存过期删原文。hold 自愿。
8. 系统异常红点独立于换窗提示、聊天未读和朋友圈未读。已读不等于已恢复。
9. 单条消息预计 token、整次请求预计输入、整轮实际用量分别显示，不相互冒充。
10. 纪念作品完全自愿；无作品不生成欠账任务。情绪完整模型及具体游戏没有被本包凭空定义。

## 文件顺序与唯一正本

| 文件 | 用途 |
| --- | --- |
| 00_GLM_PROMPT.txt | 可直接交给GLM的任务提示，指向全包合同 |
| 01_REQUIREMENTS_AND_BOUNDARIES.md | 用户语义、完整功能矩阵、数据所有权与范围 |
| 02_BASELINE_AND_IMPLEMENTATION_MAP.md | 当前源码证据、复用/改造/新增/待核实落点 |
| 03_CHAT_MEDIA_AND_INTEGRATIONS.md | 附件、看图、上传、语音、外部工具与归档 |
| 04_CONTEXT_CACHE_WAKE.md | 上下文、缓存、唤醒、调度与后台预算 |
| 05_SYSTEM_ALERTS_AND_TOKEN_ESTIMATES.md | 系统红点、消费异常、单条与整轮 token 计量 |
| 06_CALENDAR_FEED_AND_CREATIONS.md | 日历、双方朋友圈、相册、纪念空间、未来留言 |
| 07_WORK_PACKAGES.md | 施工顺序、每批入口/出口、迁移、验证、交付 |
| 08_ACCEPTANCE_MATRIX.md | 从验收 JSON 生成的人工可读清单 |
| 09_SOURCES_AND_LIMITS.md | 源码与官方来源、核验日期、能力未核实项 |
| contracts/requirements.json | 全部需求 ID 与验收覆盖索引 |
| contracts/policy-defaults.json | 本包新增配置的唯一默认值表 |
| contracts/api-index.json | 拟议端点/模型工具索引，既有与新增明确区分 |
| contracts/acceptance.json | 场景与预期；初始状态全部 NOT_EXECUTED |
| fixtures/semantic-cases.json | 可重放语义反例，全部为虚构数据 |
| tools/verify_package.py | 无第三方依赖的包完整性与覆盖校验 |
| tools/preflight.py | 只读核对目标仓库 HEAD、文件哈希与脏工作树 |
| PACKAGE_MANIFEST.json | 文件哈希与基线摘要 |

优先级：用户后续明确裁定 > 01 的语义边界 > 对应 03–06 专章 > 07 的批次安排。数字默认值以 policy-defaults.json 为唯一机器正本；正文表格是该版本的可读摘录，不是另一套配置来源。api-index.json 是路由索引，不替代专章的字段和事务语义。

现有仓库中没有被本包改变的硬约束继续有效。本包明确替代旧文档里“所有生活功能写进聊天核心”“没有夜间保温能力”“只char能用私密朋友圈”等旧口径。旧报告、历史快照只作证据，不作并行规范。

## 最先做什么

~~~bash
python3 tools/verify_package.py .
python3 tools/preflight.py --repo /实际路径/estomago --package .
~~~

这些命令只校验执行包和源码基线，不安装依赖、不启动服务、不调用任何模型。

第一批是 WP0 基线收口；然后优先 WP1 用量/系统提醒和 WP2 缓存策略。附加后台任务必须在可观测、可计量、可停止之后再接通。完整范围按工作包完成，不为了“先基础”永远遗漏日历和双方朋友圈。

## 施工与交付纪律

- 只在任务分支/隔离工作树改动；不清空用户未提交修改，不重置生产数据。
- 本仓沿用 Node/TypeScript、SQLite、原生 HTML/JS，不为本包引入 Redis、消息队列平台、第二套代理框架或前端框架大迁移。
- 本包不授权实际付费模型/生图调用、外部发帖或生产网络/凭据变更。代码、隔离测试和本地联调可先完成；真实使用按用户已有授权和仓库规则执行。
- 所有测试用独立临时 ESTOMAGO_HOME；不指向生产数据。按 AGENTS.md 前台、串行、分批运行。
- 未执行的验收维持 NOT_EXECUTED；外部缺口记 BLOCKED_DEPENDENCY，不能写 PASS。
- 每批交付变更文件、提交 SHA、实际测试命令/结果、未完成项；最终提供 FINAL_REPORT.md、TEST_EVIDENCE.md、CONTRACT_MATRIX.md、DEPLOYMENT_NOTES.md。报告就地放入仓库报告目录，不把源代码 zip 当当前正本。
- 本包只给执行方案，不夹带会自动修改生产的脚本。

