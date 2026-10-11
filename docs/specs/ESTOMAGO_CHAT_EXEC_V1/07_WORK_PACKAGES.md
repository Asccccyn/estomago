# 07 · 给 GLM 的施工顺序与交付合同

规范标识：ESTOMAGO_CHAT_EXEC_V1。此文件安排施工，不改变01的产品边界或03–06的行为合同。

## 1. 接包后的第一步

1. 在实际目标仓库外解压执行包，先运行包自检；不要把整个ZIP覆盖到仓库根。
2. 读本包README、01、02及目标仓库当前AGENTS.md。运行只读preflight，记录实际HEAD与脏文件。SHA不同表示需重新定位，并不要求reset，也不意味着需要停下等待批准。
3. 建立本次任务分支或隔离工作树。若已有用户指定工作树则沿用；保留其他代理和用户的未提交内容。
4. 把本包规范导入 `docs/specs/ESTOMAGO_CHAT_EXEC_V1/`，将AGENTS的现行规范入口更新为本包与仍然有效的硬约束。若当时已有更新的用户裁定，先合并裁定；历史规格标记已被替代的条款，不删除审计证据。
5. 创建实际施工的 `IMPLEMENTATION_MAP.md` 与验收执行副本。原包 `contracts/acceptance.json` 保持原始NOT_EXECUTED；执行副本逐项追加证据和状态，不能改期望值来迁就实现。

本包不附带旧源码快照，不运行模型、不部署、不自动改供应商账户。读基线、写代码、隔离测试、修复同仓问题属于可继续完成的工作。

## 2. 最小实施拓扑

- 现有 `apps/host` 是聊天主进程：消息、资产字节、模型、调度、用量、系统告警及薄代理。
- 现有 `apps/web` 继续原生HTML/JS/CSS：同一个入口按页面组织功能，不迁移新框架。
- 新增 `apps/content` 是同仓独立内容进程，拥有一份SQLite；容纳相册、帖子、评论、纪念作品、未来留言内容。
- 现有外部服务通过薄HTTP/MCP适配继续独立。未接通的能力返回明确状态，不加载假数据填满页面。

不要为相册、评论、留言各建服务；不要为告警、定时、用量各加守护进程。content停机时，聊天历史、基本聊天、关闭后台开关和系统中心仍可使用。

## 3. 分批工作表

| 批次 | 依赖 | 要交付的可观察结果 | 主要落点 | 验收组 |
| --- | --- | --- | --- | --- |
| WP0 基线与合同 | 无 | 实际HEAD、配置/DB版本、需求映射、已核/待核能力表；现有行为基准 | AGENTS、spec入口、配置、迁移登记、现有测试入口 | BASE |
| WP1 消耗可见与token | WP0 | 独立持久系统红点；字段级actual归一化；文本单条/整请求只读预估；后台归属合同 | usage、events、records、messages、contracts、web | ALERT、TOKEN、USAGE |
| WP2 上下文与缓存规则 | WP1 | 实际发包参数/发送起点、1h状态真实显示、缓存观测、压缩异常阻断；保持64k/手选/零选/hold自愿 | drivers、or-payload、cache-plan、trajectory、context、SDK观察 | CACHE、CONTEXT |
| WP3 聊天媒体底座 | WP1、WP2 | 上传/导入/授权读取、消息附件、真视觉、稳定投影、媒体手选、持久资产与外部引用；语音按能力接线 | media、message revisions、HTTP、projections、archive-sync、web | CHAT、MEDIA |
| WP4 有界后台 | WP1、WP2、WP3 | 三开关、任务/执行/逐尝试账本、50min保温、60min自主、无模型提醒、聊天抢占、关闭和重启恢复 | scheduler/policy、supervisor、transport前admission、settings、web | BACKGROUND |
| WP5 内容与双方朋友圈 | WP3、WP4 | content进程；可信双actor；双方看/发/评论；三相册、作品、未来留言与资产一致性；关闭content不影响聊天 | apps/content、content adapter/routes、content views | CONTENT、FEED、ALBUM、CREATION |
| WP6 日历与关联入口 | WP4、WP5 | 统一月/日页、各来源真实分页、桶实际发生日、相关原文/当天聊天分开、计划/提醒/星星分责 | calendar routes、Mariposa/Superposition只读适配、web | CALENDAR |
| WP7 外部合同与连接 | WP2、WP3、WP5；可先做只读核验 | 保留M HTTP；实现MCP client薄层；oído/扎西德勒等按真实服务接线；Siren/读书/星星/X/XHS复用；推送能力如实 | integrations、host-tools、配置、合同矩阵 | INTEGRATION |
| WP8 联合审计与交付 | 所有可完成批次 | fresh/upgrade离线验收、关键竞态恢复、隐私/权限、配置/停止/备份说明、精确阻塞清单 | 同仓测试、报告、README索引 | DELIVERY |

WP1的图片估计在WP3补媒体元数据后完成，不能在WP1伪称图像计数已实现。WP5/6是本包明确范围，不因聊天优先而永久跳过。WP7没有真实外部合同的能力保留BLOCKED_DEPENDENCY，同时其余独立功能继续完成。

允许并行只读核验或互不重叠的纯模块实现；迁移编号、共享DTO、supervisor和HTTP入口由一个集成者顺序落地，避免抢编号和同一数据两套定义。

## 4. 各批出口

### WP0：先拿事实，不先造目录

- 核当前provider选择规则、原文/窗口/hold链、资产缺口、usage归一化与真实测试入口。
- `contracts/api-index.json` 的new/extend/index状态逐项核；现有端点复用，新增端点实现，未核外部端点只列能力不杜撰路径。
- 统一DTO及配置命名，确认迁移起点。资产表名 `media_assets`；HTTP路径仍是 `/assets`；Mariposa字段仍是它的实际 `assets`，不能批量字符串替换。
- 将policy-defaults的新增键接进现有schema及示例配置；旧配置升级后auto/keepwarm保持关闭。不要重置用户现有模型/身份/路径/密钥设置。

### WP1：可观测先于后台付费

- 引入每次实际transport的request/attempt来源，扩展existing usage按字段已知小计与未知状态；为WP4预留background关联，但不启动后台。
- 告警persist、SSE、已读版本、恢复四件事一条链。正常取消/正常去重没有critical，真实越界必须可见。
- estimator只有一个纯来源。编辑器、revision、分段回复、整轮actual具有不同标签；历史消息未知值不伪造。
- 预估慢响应、切模型/改图、断网不影响正常发送硬门。读取通知/预估零模型调用。

### WP2：以最终请求与观测为证据

- 每次重试前钩子单独保存dispatch起点；不能靠收到响应后的旧onDispatch计费/续期。
- OR继续独立API；保持1h与禁压缩，验证上游账号规则的能力状态。TTL无法核实、供应商cache字段缺失、明确冷缓存三种状态分开。
- SDK先核公开控制/版本/最终参数和compact事件；未验明的背景能力阻断，不把API key等同直连、不通过删除门禁假装支持。
- 旧原文hash、修订、手选、换窗提醒保持；新工具快照变化通过受控窗口变更处理。

### WP3：从文件到模型再到归档

- 一条垂直链完成后再扩类型：上传真实字节→asset→message revision→UI→模型输入→重启重取。
- 图片不以URL文字冒充视觉；语音转写状态不伪造；代码作品存为隔离资产，不能在聊天主页面执行。
- 当前窗稳定媒体投影、新窗手选媒体、删除引用保护一起验证。
- Mariposa资产合同未核时允许本地完整可用，文字/附件归档状态分列，不能假报全成功。

### WP4：先门控和记账，再启动时钟

- 先实现admission/预算预占/取消fence/未知费用，再接到期领取。
- 自主、保温、普通提醒是独立开关；自动唤醒关闭不影响普通聊天、不隐藏系统错误。
- 50min来自有效缓存读写请求开始；60min来自同主体自主首次实际派发；都不是整点cron。
- 保温不改正式轨迹、原文或hold；后台触发的pre_rotate_review仍扣同run预算。
- no-op一次正常结束。普通模型终答不默认向用户发布；显式发送工具只发一次。
- 首次交付后台付费开关关闭，费用上限null可见；没有把测试运行当作用户启用授权。

### WP5：一个内容服务，双向使用

- 先posts/comments和author权限，再复用资产关联做相册与作品；future-notes复用同服务及est任务。
- 浏览器actor只能从现有登录派生；主模型actor从获准执行上下文派生；不接受body.author提权。
- 私密feed letter只换展示；不连接扎西德勒feed，不恢复Mariposa旧letter。
- asset先保护、content提交、引用确认；失败只会暂时多保留文件，不能误删已用资产。恢复利用既有持久记录，不引入分布式事务平台。
- 创建/修订/删除都有稳定幂等与并发合同。作者删本人帖子不级联删对方评论。

### WP6：日历就是聚合

- 月概要仅计数/标记；日详情按来源各自分页。任一来源故障返回该源状态，其余继续显示。
- 桶按实际事件日期；读取标题/预取/播放作品不触发memory_open/view.confirm；用户显式开桶才走原语义。
- 北京时间日边界采用半开区间，跨多个模型窗口仍是一日聊天。
- 星星special_dates不等于创建日；读取不拆星。正式plan仅M正本，est只引用/调度。

### WP7：真实接入，逐能力完成

- 为每个外部服务填写transport/schema/version/auth配置来源、读写面、费用与幂等能力、timeout/取消边界、已测/未测状态。
- MCP建立真实协议会话及tool调用/结果适配。模型driver、协议和后台业务分别核，不把MCP重命名当实现。
- 对oído频谱/实时音频和Siren实时通话，文本工具只负责控制；已有数据通道按真实合同连接。
- X/小红书仅接现成架构；不在est新造浏览器或爬虫。读取外部资料不能提升身份或取消预算。
- 手机离线系统推送、图检索/生图若缺服务就标能力未核；站内红点不能当已完成手机推送。

### WP8：交付可审计证据

- 针对每个已实现高风险行为运行有意义的隔离测试；已足够证明时停止重复跑，避免为了测试数扩造测试。
- 完成一次跨域实际代码的fake-adapter链：普通聊天→图片→换窗选集→自主发feed→评论→日历关联→关auto→重启。fake只能在测试模式，截图不证明外部已接通。
- 最终报告分别说明代码状态、离线测试状态、供应商/本机实测状态。不能把一个全绿汇总覆盖未知依赖。

## 5. 全包HTTP写入规则

这些规则只作用于本包新增端点与明确扩展字段。旧纯文字POST保留client_message_id兼容；消息PUT新增If-Match条件是03明确的兼容变化，必须同批升级UI并向旧页面返回可见428提示，不静默覆盖或擅改所有旧路由。

- 公共UI仍经过est认证和Origin门。新变更端点使用POST/PUT/DELETE；没有PATCH例外。
- 资源读取返回revision与ETag，建议形如 `"7"`。更新/删除使用 `If-Match: "7"`；缺少必须的条件返回428，修订不匹配返回该领域结构化409。
- 创建、更新、删除及可重试的外部副作用带 `Idempotency-Key`。作用域含真实actor、操作、资源；同key不同body/版本返回409。
- 先鉴权，再找该作用域的合法旧回执。同key同原始请求的成功重放返回原结果，不因第一次已经增加revision而拒绝；没有旧回执才检查当前If-Match并执行。
- 模型工具保留 `expected_revision` / `idempotency_key` 或已约定 `client_operation_id`，由host adapter映射上述头；不可自己传actor。
- token-estimates虽用POST但语义只读，无幂等账本/If-Match；system-alerts/read使用观察sequence做单调幂等，无资源删除/恢复权。
- 对已有消息发送，沿现有client_message_id/operation_id的去重，不再引入第二个不同语义的键。
- 一次执行只用一份业务实现：前端HTTP与模型工具都进入同一service，不把工具当另一个旁路。

响应错误沿既有标准壳扩展稳定code、retryable、operation_id及安全摘要；无需为了统一改全仓历史错误格式。外部原始堆栈、签名URL、正文和密钥不进入可公开状态。

## 6. 迁移、恢复与交付时的开关

1. 在真实施工HEAD之后统一分配迁移编号，不在不同工作包都硬写v21。
2. est原表采用additive迁移；旧消息attachments=[]、token_estimate=null，原text hash和revision不变。已有轨迹读兼容；新增格式明确version，不重写旧证据。
3. content自己的schema version与est分开。两者不能跨SQLite直接JOIN；聚合/引用通过服务接口。
4. fresh install、当前基准DB升级、迁移中断后重启分别验证。备份/恢复复用本仓脚本并覆盖新增DB与媒体；必须暂停写入或用SQLite一致快照，不能直接复制活跃WAL主文件后声称完整备份。
5. content目录及媒体位置遵从真实ESTOMAGO_HOME；如果单独配置需写清备份范围。孤立保护引用只多保留文件，默认不自动物理清理未知资产。
6. 数据库已升级后，旧二进制能否安全读新schema必须明示。回滚优先关新能力；需要旧版本数据则恢复已核备份，禁止默认执行drop新表/删媒体的“回滚”。
7. 只在明确部署任务中安装/修改LaunchAgent、生产端口、隧道或凭据。本包要先完成代码、示例配置、隔离启动方式和可复查差异，不能以最终部署审批为由不施工。

## 7. 验证入口和证据格式

本基准仓库只有根package.json，不是带独立apps/host包的workspace。根脚本真实存在：`npm run typecheck`、`npm test`、`npm test -- --unit`、`npm test -- --integration`。不可编造 `pnpm --filter` 或不存在的应用脚本。

当前测试runner内置临时ESTOMAGO_HOME、ESTOMAGO_TEST_MODE和逐文件串行；先遵守test-guard，不为了跑通移除保险丝。新增针对性测试应进入该纪律；如需批次过滤，先实现和证明最小过滤，不绕过安全环境直接连外部服务。

文档包检查不同于代码验收：本包verify只核哈希、JSON覆盖、脚本结构和引用。它无法证明后端已实现、真实缓存命中或SDK控制有效。

每条验收记录至少包含：

~~~json
{
  "acceptance_id": "BACKGROUND-09",
  "implementation_commit": "真实提交SHA",
  "status": "NOT_EXECUTED",
  "command": null,
  "environment": "isolated_test_home + fake_transport",
  "observed": null,
  "evidence_path": null,
  "blocked_dependency": null
}
~~~

完成后只允许有证据的PASS、明确FAIL、未跑NOT_EXECUTED或外部合同BLOCKED_DEPENDENCY。DEFERRED_DESIGN按01只有情绪数值/具体游戏等未定设计，不能用于隐藏既定朋友圈评论或日历。

## 8. 最终交付给宿主用户的四份报告

放在实际仓库 `docs/reports/ESTOMAGO_CHAT_EXEC_V1/`，附当前分支与提交，不复制完整生产数据。

- `FINAL_REPORT.md`：已完成行为、页面入口、重要设计决策、剩余精确缺口；说明auto/keepwarm交付状态。
- `TEST_EVIDENCE.md`：实际命令/结果、场景ID、失败修复、未执行原因；禁止引用本包自检代替实现测试。
- `CONTRACT_MATRIX.md`：每个外部能力expected/observed/adapter status/实际版本/验收状态；标明是否仅fake。
- `DEPLOYMENT_NOTES.md`：端口/进程、配置迁移、启动停止、备份恢复、新增权限与费用字段；哪些已做、哪些尚待真实环境执行。

不要求宿主用户重新阅读所有源码才能知道功能在哪。报告首先说明她如何开关自动唤醒、从哪里看系统异常、单条token如何标注、日历与双方朋友圈入口在哪里。

