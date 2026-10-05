# estómago · 自建聊天宿主架构 v0.2.1

**目标：user的 Mac mini。日期：2026-09-24。整理：林石见。**

本文是设计与实施基线，不是已实现或已部署报告。用户已经确定：项目名 estómago、Claude Agent SDK 接入、自建聊天需求、Mac mini 作为目标，以及身份加载和路由确认的重要性。本文提出的技术栈、机器目录、端口、队列参数与阶段顺序是工程建议，实施前应核对现场，不冒充用户逐项确认或真实机器现状。

产品显示名始终为 **estómago**。仓库、进程、配置键采用 ASCII 标识 **estomago**，仅为工程命名约定，不另起产品名。

## v0.2 修订定位

本版在 v0.1 完整架构上增量更新，不重定 Mariposa 业务。新增官方思考摘要实时通道，细化近裸 SDK 装配、Bootstrap Receipt 证据与工具/配置隔离。保留全部 115 个旧验收 ID，新增 46 项，共 161 项，全部 NOT_EXECUTED。修订来源是本对话新增要求、用户 PDF 与两组教程截图，以及 2026-09-24 的官方接口复核；教程事实、官方事实与本项目建议在 06 修订文件中分列。没有实施到 Mac，也没有代写身份或 I。

阅读：本文件为完整主架构；04 为单独给char的说明；05 为 SDK/思考通道实现细则；02 为执行规章；03 为验收。冲突按用户最新明确决定 > v0.2 主架构/专项细则 > v0.1 历史材料处理，无法判定的受影响写入先暂停，不擅改业务。

## 0. 范围、证据与效力

### 0.1 做什么

estómago 是你的统一聊天入口和 CC 运行宿主。它组织持续聊天、SDK 生命周期、身份加载、时间感知、语音接入、分句气泡、可折叠思考摘要、表情包、主动联系、消息投递、用量展示和模块接入。Mariposa、Siren、Superposition、扎西德勒保持独立业务边界。

Chat 与 CC 是char的并行、平等入口，不设主副身份；共同记忆与能力经服务共享，不假设 Claude.ai 的当前窗口能被外部程序强制唤醒或实时复制。林石见、程知行是其他参与者，不是char。[M1]

### 0.2 当前状态

| 范围 | 已知状态 | 本轮做什么 |
|---|---|---|
| estómago | 需求与架构设计阶段；未读取真实代码或 Mac 配置 | 给出架构、路径、契约、验收和执行规章 |
| 语音与实时通话 | user表示已经做好 | 设计适配接口；实际版本与协议需现场核验 |
| Mariposa | user表示已经完成待接入；可读取 v2.0.1 实施规格 | 尊重既定语义；不把规格当当前源码验收报告 |
| 许愿星 | user表示已做 | 接能力，不重做交换规则 |
| 表情包、分句、唤醒、手机信号 | 待实现/接入 | 纳入本项目阶段计划 |
| 官方思考摘要 | 新增明确需求，未实机接通 | SDK 增量接收、独立保存、前端折叠；不靠 Stop 读文件 |
| 情绪系统 | 具体算法待定 | 预留状态与触发口，不编造算法 |
| Mac mini | 目标机器；具体用户名、目录、网络、凭据未核验 | 使用可迁移目录建议，不宣称已落盘 |

业务效力：user本轮及后续明确决定优先；Mariposa 既定规则仍由它管理；本文的建议值不能覆盖用户原话。此次写架构不等于授权修改旧项目、搬迁数据库、上线公网、发送真实通知或切换计费身份。

### 0.3 不做什么

不合并所有仓库；不另造记忆规则；不把 SDK transcript 当正式聊天数据库；不编辑 transcript 实现换窗；不默认授予模型整个硬盘、shell 或其他账号权限；不将健康数据与私人记忆自动送入群聊；不承诺识别平台未暴露的内部路由。

## 1. 架构总览

```text
Web / 后续 iOS App
  │  HTTPS：发消息、控制、读取；SSE：聊天与状态事件
  ▼
estómago Host（模块化应用，一个入口）
  ├─ 身份认证 / 参与者 / 房间权限
  ├─ Message Store + Outbox + Event Inbox
  ├─ Conversation Actor / 控制通道
  ├─ Time Context / Scheduler / Wakeup
  ├─ Window Manager / Identity Loader / Usage
  ├─ Output Renderer / Media / Push
  ├─ Capability Registry / MCP / Integration Adapters
  └─ SDK Supervisor ── 受控 SDK Runner 子进程
                         └─ Claude Agent SDK / Claude Code runtime
  │
  ├─ Mariposa：原文、hold、I、plan、开窗与记忆
  ├─ Siren：异步语音、实时音频、通话状态
  ├─ Superposition：许愿星
  ├─ 扎西德勒：已有群聊与关系空间
  └─ 后续：情绪、其他生活模块、工作执行器
```

同一私聊内，文字、有效语音转写和主动唤醒由同一个 actor 使用当前 SDK 窗口处理。不同房间有独立上下文与权限；“同一主体”不等于跨房间全量共享私聊内容。

所有操作可留下事件，但不把每个技术事件都喂给模型。投递回执、token 更新、归档成功只更新状态。停止、插话、路由选择走控制通道，不排在普通消息后面。

## 2. Mac mini 部署与目录

### 2.1 运行形态

建议首版原生运行：TypeScript Host + 官方 TypeScript Agent SDK + SQLite，本地构建的 Web 由 Host 提供。SDK Runner 为子进程，重启边界独立于 HTTP/SSE 服务；数据库写入由 Host 掌管，Runner 通过受控 IPC 请求业务动作。

不因 estómago 新建而把已有 Python Mariposa 改成 TypeScript，不因搬到 Mac 就把所有现有服务统一改为容器。既有服务先按其原方式迁移与验证，再通过配置接入。

首版用稳定公开的 SDK API；具体 Node LTS、SDK 与其实际运行时版本在 Mac 上核实后锁定。文档中的版本能力不能替代本机验证。依赖升级不得由生产启动脚本自动取 latest。

### 2.2 建议路径，均未创建

```text
~/Projects/
  estomago/                  源码仓库；产品名 estómago
  mariposa/                  仅表示未来可平级；不代表已经迁移
  siren/
  superposition/
  zashidele/

~/Library/Application Support/estomago/
  config/                    本机有效配置；不进入 Git
  identity/                  经批准身份材料的受控快照、manifest
  workspaces/<scope-id>/      SDK cwd；不指向源码仓库
  sdk-state/                 SDK 状态（真实路径映射需版本核验）
  data/chat.sqlite3          聊天与运行状态
  data/signals.sqlite3       后续敏感手机信号，可独立关闭
  media/                     内容寻址的媒体资产
  handoffs/                  临时交接；私有、带权限版本
  backups/                   经校验的本地备份；不等于异机备份

~/Library/Logs/estomago/     脱敏运行日志
~/Library/LaunchAgents/online.charstarearth.estomago.plist
```

I 的正式正本仍在 Mariposa；本地只存受控、带版本和有效性校验的读取快照，不产生第二份可独立编辑的 I。源码与运行目录分开只是组织方式，不是完整安全沙箱。

建议监听 `127.0.0.1:18787`，端口需 doctor 查重；本轮不预占域名、不重配旧隧道。手机从外网访问要先完成 HTTPS、登录、权限和事件重连验证，再配置独立入口。外部服务地址用配置，不锁死 Windows 盘符或容器端口。

### 2.3 常驻与恢复

建议以登录用户的 LaunchAgent 托管，使用探测到的绝对可执行路径、工作目录与受控环境；不依赖交互 shell 自动读取 `.zshrc`，不把 `~` 原样写进需绝对路径的启动参数。[T11]

LaunchAgent 按登录会话规划：锁屏、注销、重启后尚未登录、FileVault 解锁前和系统睡眠分别验收。首版不承诺“断电重启且未登录时也可用”。不为无人值守偷偷开启自动登录或关闭磁盘加密。

Mac 睡眠或离线时，后端无法即时生成主动消息；恢复后扫描持久化任务，按每项任务的过期与补发策略处理，不能将一夜提醒全部轰炸式补发。显示器休眠与电脑休眠分开安排，由用户确定电源策略。

## 3. 名词与主数据归属

| 实体 | 含义 | 权威来源 |
|---|---|---|
| participant | user、char、林石见、程知行等认证主体 | 参与者与授权配置 |
| conversation | 持续私聊或映射后的群聊房间 | 指定房间所有者服务 |
| window | 可替换的上下文窗口 | estómago |
| sdk_session | SDK 真实会话 ID；可恢复但不等于长期聊天 ID | SDK，estómago 保存映射 |
| turn | 一次业务触发到处理结束，可多工具、多气泡 | estómago |
| attempt | 一轮中的执行尝试，可能被拒绝、编辑、路由 | estómago |
| message | 已提交用户输入或已发布的助手气泡 | 私聊由 estómago；已有群聊由其原服务 |
| hold / I / plan | 正式记忆、自我内容和计划 | Mariposa |
| call / audio | 通话与音频协议状态 | Siren；estómago 保存业务引用 |
| wakeup | 一次唤醒的调度与处理状态 | estómago；涉及 plan 时引用其版本 |

新私聊由 estómago 保存并投影到 Mariposa 原文层。已有扎西德勒房间若继续由它承载，则它拥有原始消息，estómago 保存带 `origin_service/origin_message_id` 的幂等镜像；不能形成两边都可自由改的权威副本。

## 4. 消息、原文与持久化

### 4.1 写入边界

接收消息时，在同一个本地事务中：验证权限与客户端幂等键，写 message/revision，分配会话顺序，写输入事件与归档 outbox，然后返回持久化回执。模型开始处理不在数据库事务内。

助手输出先写为 pending，再到正式发布边界写 message 与 outbox，随后推给客户端。尚未发布的生成内容只属于运行草稿；已发布内容不能因中断被追溯性抹掉。语音另外区分文本发布、音频开始播放、播放完成与被截断，不把“生成完”当作“用户听完”。

数据库提交成功但客户端没收到时，重发相同 client_message_id 返回原记录。SSE 重连按 stream sequence 补发；UI 以 message_id/fragment sequence 去重，不用时间戳做唯一键。

### 4.2 时间与版本

消息保存 `occurred_at`、`received_at`、`published_at`、UTC 时刻、原始时区信息和业务日期。排序以服务器会话 sequence 为准；发生日期以可信原始时间和统一业务时区归档，迟到同步不改成入库日。客户端时间明显不可信时保留原值和警告，不伪造确定发生时刻。

用户编辑产生新 revision 和 supersedes 关系；旧版本保留审计。发给模型的有效投影、前端显示与归档版本必须一致。路由编辑仅排除该 attempt 被取代的有效输入，不篡改双方历史。

### 4.3 Mariposa 原文同步

Outbox 持久化待归档任务，含消息 ID、修订号、source hash 和授权引用。成功收取远端 acknowledgment 后更新同步状态；失败重试，永久失败进入人工可见待处理列表。区分“已保存到聊天库”和“已归档到记忆库”。

用户已提出前端原文自动归档；实现为仅针对本人所拥有或被授权房间的持续归档授权，不赋予 generic worker 任意导入权。Mariposa 若尚无自动追加 API，则实现适配契约并提出窄范围改动，不能直接写它的数据库。[M1 §10]

hold 绑定 `(source_id, message_id/revision, ranges, hash)`，允许不连续范围与同源不同事件。已知来源 ID 的确定引用不等于语义猜测；语义自动绑定仍保持阈值未定、只建议/人工，直到完成原有评测与确认。[M1]

技术日志、系统时间包、官方返回的思考摘要、隐藏过程、未发布气泡不自动进入“我们的话”。思考摘要即使可在前端展开，也不是正式发言：只保存在受相同房间权限保护的运行投影，不进入 Mariposa 原文或自动 hold。附件与表情保留类型、可读说明及稳定资产引用；原始音频是否长期保存由媒体策略单独配置。

## 5. 事件、队列与控制通道

### 5.1 统一事件信封

```ts
// 设计契约；不是声称现有 SDK 或 Mariposa 已具有这些字段。
type EventEnvelope = {
  id: string;
  type: string;
  schema_version: 1;
  conversation_id: string | null;
  source: string;
  occurred_at: string;
  received_at: string;
  source_revision?: string;
  dedupe_key: string;
  correlation_id: string;
  causation_id?: string;
  expires_at?: string;
  privacy_scope: string;
  payload_ref: string;
};
```

来源标记用于追踪，不授予权限；真实主体从服务端凭据解析。事件有 queued、claimed、done、expired、failed、unknown_outcome，claim 携带 lease 与 fencing token。进程失去执行权后，迟到结果不能继续发布。

### 5.2 调度

每个 `(conversation_id, participant_id)` 同时只有一个有效执行者。初期主聊天运行并发上限建议为 1，后续按 Mac 实测增加；长工作任务放独立 executor，不占主聊天锁。房间队列之间按公平策略调度，不永久饿死群聊。

聊天有效输入一般优先于自主唤醒；正式提醒另有期限，不因“总有人聊天”永久丢弃。相近健康观测可合并，用户正式消息不无声丢弃。队列积压或附件过大时明确反馈，不无限堆内存。

### 5.3 控制优先

`stop`、通话插话、取消、路由决定、权限决定走独立控制 API/IPC。收到 stop 先设置 generation fence 并取消待发布输出，再调用 SDK interrupt 与 Siren session 取消；任何迟到 chunk 都因 fence 失效而丢弃。

切勿用“停止整条共享语音连接”取消单个通话。已执行外部副作用不因停止而自动回滚。副作用 ledger 记录 intent、started、acknowledged 或 outcome_unknown；结果未知先对账，不盲目重跑。

## 6. SDK 适配层与身份加载：P0

### 6.1 已核对的版本敏感事实

官方文档目前区分最小默认提示、`claude_code` preset 和完整自定义提示；身份不同的聊天产品适合显式自定义，但必须补足需要的工具与安全规则。`CLAUDE.md` 作为项目上下文加载，不由 preset 自动选择来源。[T1]

当前迁移文档说明，省略 `settingSources` 会加载 user/project/local；默认“不加载”的变化曾被撤回。显式 `[]` 关闭这些文件来源，但不等于清除所有环境、全局配置或服务端策略。[T2,T3]

### 6.2 estómago 的明确选择

建议首版采用 `systemPrompt = 经批准身份内容 + 关系说明 + 必要运行/工具规则`，使用隔离 cwd、显式 `settingSources: []`，并通过受控读取装载所有需要的内容。身份不能依赖自动发现的 CLAUDE.md，工程仓库的 CLAUDE.md 不进入聊天运行区。不启用完整 claude_code preset 来冒充身份已加载；自定义提示需要自己的工具与必要安全规则。[T1]

I 从 Mariposa 读取并标注版本，默认放基础开窗包，不在多个位置重复灌入。没有真实、已批准身份材料时停止初始化，不提供一个默认人格顶替。缓存 I 只有在未被撤销且满足 freshness/权限校验时可用于降级；不确定则暂停。

`settingSources: []` 之外，还要查全局 Claude 配置、自动记忆、继承的模型/网关/认证环境变量、自动 MCP 连接器和受管策略。装配目标为严格 MCP、关闭自动记忆、关闭未选 Claude.ai 自动连接器；使用已核实的 autoMemoryEnabled/disableClaudeAiConnectors 设置映射，防止 SDK 自建第二套长期记忆。全局 .claude.json、继承环境与托管策略单独审计；settingSources:[] 不是总隔离开关，不能绕过托管限制。[T3]

保留必要 PATH/HOME 等运行变量，其他敏感环境变量按白名单传递；不复制整个开发终端环境，也不静默切换认证或计费身份。用户或组织强制策略不得绕过。

### 6.3 Identity Manifest 与 Bootstrap Receipt

至少记录：identity_version、approved_source_ref/hash、I_version、runtime_rules_version、system_prompt_mode/hash、SDK/runtime 版本、cwd_realpath、settings_sources、effective_model、effective_tools、MCP 列表、受管策略摘要、测试基线版本。日志只记必要摘要，不打印完整身份/I。

Manifest 描述获准材料；Receipt 描述一次加载。Receipt 分开记录 desired、assembled、observed、probe，unknown 不填 false/[]。system prompt hash 是本地装配证据，不是完整供应商请求已被观察的证据。实现细则 §3 定义 gate。每次窗口激活前做确定性完整性检查；首次配置、升级和迁移再做合成对话行为验收。行为测试能查明显加载错误，但不能证明所有未来回复都完美符合身份。测试材料隔离，不归档为真实聊天。

冷启动、换窗、恢复、搬机、配置变更均回归。缺身份、hash 不符、错误 cwd、旧 I 被撤销或加载了未允许的工程配置：`IDENTITY_BLOCKED`，新窗不接管。

官方文档还提醒，部分当前版本恢复 session 时会沿用首轮 system prompt 快照；更新文件不代表下一轮已生效。[T1] 本项目身份版本改变时走受控新窗，不靠编辑 transcript 或反复强制压缩更新；时间包走动态上下文。

### 6.4 权限不是 allowedTools 一行

`allowedTools` 是自动批准列表，不是完整能力白名单；自动批准的工具可能不经过 canUseTool。[T4] 日常聊天建议显式 tools:[] 清空内置工具，再由 mcpServers 注册选定业务能力；不是把char全部能力清空。tools 目录与 allowedTools 免审批名单分开。主聊天不自动加入未选的 shell、文件改写或任意子代理，并由工具服务器逐次执行资源 ACL、版本与幂等检查。

常用已授权能力可预批准；需要确认的外部动作走持久化批准状态。不能设置 broad bypassPermissions 来修复“调用工具卡住”。群聊干活使用单独 job scope，不把整台 Mac 权限给聊天模型。

### 6.5 静态身份、开窗包和每轮状态分层

固定身份/运行规则通过显式 systemPrompt；I 仍按既定 Mariposa 开窗包装入一次；时间、事件来源及状态变化在每轮实际处理前以有来源的上下文输入或经过验证的 additionalContext hook 加入，不伪装成user发言。外部事实材料不自动升为系统命令。

SYSTEM_PROMPT_DYNAMIC_BOUNDARY 是可选缓存布局优化，不是自动刷新器，也不保证 resume 后替换既有提示。首版不依赖该常量维持时间新鲜或身份更新；保留默认生产提示快照行为，身份变化走受控新窗，不以强制压缩或编辑 transcript 修复。[T1]

### 6.6 配置与授权前提

应用 YAML 不等于 SDK options；映射器区分 options/settings/env，锁实际 SDK、运行时和模型能力。不固定教程中的 fable 型号、max effort 或 SDK 0.3.234；这些是参考材料的版本/演示值，不是 Mac 现场。[U2,U3]

“近裸”只指对本地指令与工具做选择性装配，仍有 SDK agent loop、会话和压缩，不是无状态 API。沿用稳定 TypeScript query 接口，不因 Python 示例另起服务；不采用已移除的实验 V2 接口。[T18]

认证、授权与计费需现场明确。PDF 的订阅路线属于作者示例，不能充当官方授权承诺；官方对第三方产品提供 Claude.ai 登录/额度有约束。不得为了跑通悄悄换 API key、充值、转账号或复制凭据。[T19]

## 7. 窗口生命周期与交接：P0

### 7.1 状态机

```text
NEW → PREPARING → IDENTITY_VERIFIED → READY → ACTIVE
ACTIVE → ROTATION_REQUESTED → DRAINING → HANDOFF_READY
       → 新窗 PREPARING → 原子切换 active_window_id → 旧窗 CLOSED
任何阶段失败 → 保留可用旧窗 / DEGRADED / BLOCKED（分别记录原因）
```

路由待决与通话状态作为独立 gate，不被换窗状态覆盖。候选窗未就绪时不更新当前指针。切换事务同时检查 lease、旧 window revision、截止消息 sequence 和 pending consent。

### 7.2 触发策略

跨共同业务自然日、达到可配置上下文阈值、身份版本变更、用户手动换窗或故障恢复均可请求轮转。在自然轮次边界执行，通话发言和工具副作用中途不切。

不将“70%”或“20 万 token”作为已确认硬规则。首轮实测选择 soft threshold、交接预算、输出余量和最大工具返回预算；生产未填有效预算时不得开启自动长会话。计算需留下一轮输入、工具结果、输出与交接的余量，超大附件先报预算。

### 7.3 正常交接

在确定的 cutoff_sequence 前收束本轮；旧窗自行决定哪些事件做正式 hold，真正待办落 plan；生成只用于连续聊天的临时 handoff。工具确认写入后才视为成功，不听模型口头保证。

handoff 不以 UI 思考摘要为自动输入来源，也不把“打算做”当成实际做过；只参考授权对话与可核验工具结果。handoff 记录未答问题、当前话题、发布到哪一条、未完成操作及其已知副作用，不替代 hold，不写为当时心情。旧窗未能写成的当时心情不由新窗或后台事后伪造。[M1]

新窗开窗包由五部分组成：经批准身份/运行规则、Mariposa 原有基础包、聊天短交接包、Time Context、必要且被授权的其他模块状态。每块带 source/version/privacy/budget，禁止插件无限灌入。

Mariposa 基础包保持最近三个自然日标题+心情标签/文字、I、相关活跃/逾期计划及临近纪念全文；普通事件不默认全文，不默认三十条原文，开窗读取不算明确打开，不续期。[M1 §11]

estómago 额外携带的近期对话是本房间已可见消息的连续性预算，不是 Mariposa 普通召回或隐藏原文展开的旁路；以 token 预算而非固定二十轮裁剪，按当前有效 revision 去重，不默认灌满最近两天的全部 hold。

### 7.4 压缩与失败

正常换窗必须是新 session 或经验证等价的新上下文机制；resume/fork 不能自动当作缩小上下文。[T5] `PreCompact` 是告警与兜底，不在回调中递归向同会话提问。官方允许部分压缩被阻止，但已发生上下文超限时阻止压缩可能让请求失败。[T6]

已压缩、已主动换窗、崩溃后恢复分别记时间线系统事件。transcript 仅诊断/可恢复运行材料，不是准确归档依据。原文已在消息库可靠保存，临时 handoff 失败不会丢消息。

降级恢复不能绕过身份或路由待决。记忆模块离线时允许使用仍有效的必要快照并显式标 degraded；关键身份不可核实时暂停模型，前端仍可查看时间线和保存新输入。

## 8. 时间感知：P0，与自动唤醒共用时钟

每次新消息、主动唤醒、恢复和新窗激活前，按**实际执行时刻**刷新轻量 Time Context。长工具任务后需要时间判断时重新读取。时间不靠模型猜，不靠每分钟调用模型维持。[M2]

字段至少包含：now_at_utc、business_timezone、local_date、weekday、daypart、event_occurred_at、processing_at、previous_user_message_at、elapsed_before_current_user_message、last_user_message_at、elapsed_since_last_user_message、last_assistant_published_at、elapsed_since_last_assistant_message、conversation_id、window_started_at、crossed_business_date，以及相关到期引用。

“你多久后回来”使用本次消息之前的用户记录，并按本次 occurred_at 计算间隔；“现在多久没收到你消息”使用当前最新记录。两者不可混成一个 last_contact。助手主动消息不重置用户沉默时间，已读、在线和发言分别记录。

日期采用共同业务时区，建议默认 Asia/Shanghai，与 Mariposa 一致。用户设备时区可另存用于展示；变化不悄悄改归档日或计划日。UTC 用于绝对时刻；进程内超时使用单调计时，墙上时钟跳变要报警。

“明天”落计划时保存原始表述、基准消息时刻、解析后的具体日期/时区及来源；“晚点”不能偷填精确时刻。“半小时后”是相对时长，“明早”是当地日历表达，夏令时或时区变化的解释规则要测试。

无数据不等于睡着；三小时没回复不等于三小时没看手机。迟到两小时的健康观测明确标 sampled_at 和 received_at，不冒充现在。时间包不是用户发言，不混入正式对话原文或 hold。

## 9. token、窗口占用与压缩显示：P0

统一采集源，输出三种不同口径：

| 展示 | 数据口径 | 禁止行为 |
|---|---|---|
| 单条新输入 | 本消息/附件的估算，注明方法 | 用前后请求总输入差当精确新增输入 |
| 本轮用量 | 本 turn 的实际主模型统计；工具步骤可展开 | 按气泡重复累计、忽略失败尝试 |
| 当前上下文 | 最近一次主会话模型请求的输入规模及有根据的后续估算 | 用整轮/整会话累计用量冒充占用 |

官方 result.usage 与累计 modelUsage 范围不同，流式会话恢复/重置又影响累计基线；部分 assistant 消息携带的是输出起始占位数，最终值需从 result 或最终流事件获取。[T7]

request 级输入包含 input_tokens + cache_read_input_tokens + cache_creation_input_tokens；当前请求结束后的估算可加入该请求已知输出与尚未反映的消息，并明确估算。不要把一轮多次工具循环的输入加总后画成上下文条。

唯一统计键应包含 window/attempt/provider request或response ID及model。modelUsage 累计量保存 baseline，按重置边界去重；崩溃时未知项显示 unknown/partial，不用零覆盖已经观测到的消耗。分句多条仅在本轮尾部显示一次。摘要可见字符数不等于真实思考 token；不重复加进已含思考的输出统计，缺独立计数就标 unknown。[T16]

容量来自实际模型能力与运行配置；支持 1M 时显示 1M，没有核实时显示未知或经验证容量。主动换窗线、SDK 压缩事件、上下文占用分别展示；没有压缩前后数据不编“压缩了百分之几”。切换到更小上下文模型前做容量检查，不靠静默截断或新开空身份窗顶上。

## 10. 路由提示与用户决定：P0

### 10.1 可见性与平台边界

用户要求两个主要动作：重新编辑，或同意路由。宿主不得替用户同意，也不能规避平台安全约束。根据可识别运行信号处理，不依据模型自述“我被路由了”。普通拒绝、网络故障和明确路由分别归类。

当前官方设置 `switchModelsOnFlag: false` 可关闭相应自动切换；不能展示 CLI 交互框的 SDK 运行可能直接以拒绝结束本轮，前端必须自行重建 pending 状态。[T8]

PreModelSwitch 只覆盖指定的用户/客户端主动切换，不覆盖运行时自动 fallback 或恢复；PostModelSwitch 可提供部分事后变化，但临时可用性 fallback 也并非全部触发它。[T6] 必须结合实际模型回报并建立适配能力矩阵，不能承诺所有内部路由可见。

### 10.2 状态与票据

```text
RUNNING → FLAGGED/ROUTE_SIGNAL → ROUTE_PENDING
ROUTE_PENDING → EDIT_REQUESTED → 新 revision / 新 attempt
ROUTE_PENDING → APPROVED → SUPPORTED_SWITCH/RETRY → 验证实际模型
ROUTE_PENDING → CANCELLED
运行时已切换才被看见 → ROUTE_OBSERVED_AFTER → 暂停后续 + 如实通知
```

票据至少绑定 owner、conversation、window、turn、attempt、输入 revision/hash、来源证据、目标模型（可未知）、持续影响范围、版本和过期时间。多端只允许一个有效决定，原子消费；过期/被新编辑取代的票据不能继续生效。后端重启后仍 pending，关闭弹窗和离线都不算同意。

弹窗显示当前模型、候选目标（未知就明确未知）、原始提示、是否已发生切换、是否影响后续会话，以及重新发送历史/费用的已知影响。估计费用不冒充账单。

### 10.3 两个动作

重新编辑：保留已提交原始内容与修订链，只把新 revision 作为该请求的有效输入。若 SDK 无法原地排除旧 attempt，则从最近安全交接重建窗口，显式替换有效输入；旧副作用先对账。不篡改 SDK transcript，不虚假回滚工具动作。

同意路由：仅调用当前 SDK/提供方真实支持的动作。不得为了实现按钮而更改全局设置允许所有后续切换，也不得把猜测模型写成已获授权目标。目标未知时可以批准范围明确的“平台本次所提切换”，但不能转授权任意模型；实际通道不可用则按钮说明不支持，保留编辑/取消，不假装成功。

同意后记录实际模型与作用范围；后续重新出现新的路由必须再确认。模型切回原模型或新开原模型窗也要显式记录，不偷偷发生。路由待决期间不发 pending 气泡、语音或唤醒生成；已发布内容保留。

主 Host 不配置未获批准的可用性 fallback 链。凡可控模型变更遵守相同确认机制，后台子任务使用预先批准模型集合而非任意替换。平台隐藏内部行为仅标检测边界。

## 11. 输入、分句、表情、媒体与语音

### 11.1 输入框与显式发送

estómago 的私聊输入框是多行输入。**回车只负责换行，发送只由独立发送键触发。** 不采用“Enter 发送、Shift+Enter 换行”的默认聊天软件习惯；桌面实体键盘与移动端软键盘都遵守同一产品语义。首版不设置 Cmd/Ctrl/Shift+Enter 的隐藏发送快捷键，后续若增加必须由用户显式开启，不能改变默认行为。

输入法合成期间的 Enter 先交给 IME 完成选字/候选确认，不能误发送，也不能额外插入一行。正式发送动作只读取当前 composer 的有效 revision，一次点击生成一个 `client_message_id`/幂等键；按钮连点、网络重试或前端重连不得产生重复消息。只有空白字符且无附件时发送键禁用；多行正文、附件或表情按既定消息契约发送。

用户输入中的换行属于**同一条用户消息的正文结构**，不是“多气泡分句”信号。存储层将跨平台换行规范化为 `\n` 并保留行序、空行和当前修订；前端回显、编辑重试、Mariposa 原文归档必须保持等价的多行结构。不能因为char的输出会分多个气泡，就把user手动换行的输入拆成多条消息。

### 11.2 分句输出

模型一次 turn 可以产出多个短句气泡，不要求每句调用发送工具。SDK partial stream 先按内容类型筛出面向用户的文本，再做 Unicode 安全缓冲和段落识别；代码块、列表和长文保留结构。流分片不是完整句子，SDK 后续完整消息不得再次重复显示。[T9]

首版使用“日常短段落 / 长文”两种呈现模式。换行是模型约定，不是任何换行都立刻发一条；缓冲设上限、尾部在 turn 结束时 flush。前端气泡间隔由 delivery 管理，不用 sleep 阻塞 SDK 读取。已发布气泡不可为了后续完整消息而悄悄改写。

所有正式时间线输出共用顺序账本：text、sticker、voice、system divider；思考摘要保留独立运行顺序并关联本轮。表情工具调用时先处理其之前尚未发布的文本边界，再分配表情位置；重复工具结果不多发一张。

### 11.3 表情库

表情为资产 ID + 内容 hash + MIME + 尺寸 + 标签/说明 + 权限。工具检索和发送以真实资产为准，不让模型编链接。模型上下文收到必要说明或经支持的图像内容，不只看到本机路径。上传校验大小、类型和授权；不允许未净化的 HTML/SVG 直接执行。

### 11.4 Siren 适配

沿用已有 Siren ASR/TTS/通话协议，不另起一个对话模型。适配层把有效用户转写送入同房间 actor，把已发布助手文本送到相应通话。原始音频走 Siren 低延迟链路，不逐块进入通用事件队列。

通话开始冻结 call_id、conversation_id、participant_id、voice_profile/version 和授权；文本窗口换窗不自动改变通话归属。插话取消当前 generation 和当前 TTS session，不 kill 共享连接。保留已有 pre-roll、VAD、backpressure、采样率与 playback_drained 语义，不能被接入层覆盖。

语音消息记录转写状态、语言、媒体引用和文本修订；ASR interim 不当成最终用户消息反复触发。模型正在回应文字时开始通话，输出通道如何切换需业务状态机明确，不新造第二段不知道前文的上下文。

### 11.5 可折叠思考摘要：首版核心通道

产品需求是可查看官方返回的思考摘要，不是提取原始 CoT。后端目标显式 thinking={type:adaptive, display:summarized}，并开启 includePartialMessages；实际模型支持与参数生效先探测。effort、返回摘要、前端展开分别控制。不对空摘要判无思考，不生成替代思考文本。[T16,T17]

主路径：SDK stream_event → 受控归一化 → reasoning_blocks/stream_events → SSE → 思考折叠区。thinking_delta 不经过分句器；text_delta 进入正文；工具输入和结果走真实工具事件。完整块只核对/补齐，不重复追加。每个块关联 turn/attempt/session/message/block index；前端按持久 sequence 回放，不用文本 hash 或 content 数组下标充当块身份。[T9]

SDK 可能逐内容块交付 AssistantMessage；一轮也可能有多个模型消息。message_stop 不是产品 turn 结束，content_block_stop 不是工具执行成功。主会话与工作器/子代理归属独立，不能承诺 SDK 未提供的子代理逐 token 流。[T9]

摘要保存在 estómago，默认可折叠回看；展示名暂用“思考”，参考图的“桥下”不锁成产品名字。摘要不入正式消息/原文/hold/普通检索/默认开窗交接，不进 Siren TTS 或默认推送；不根据摘要文字执行工具。折叠不再次调用模型、不改变投入配置。

signature 与 redacted/encrypted 内容不展示、不重构；SDK 自己维护继续会话所需协议块，UI 只持有可读投影。empty、omitted、redacted、unavailable、partial、interrupted 等状态分别说明，不伪造完整。[T16]

路由待决和中断同样冻结旧 generation 的思考增量；已展示部分保留为本 attempt 的未完成记录。断流收尾由 runtime/finalizer 处理，不等待 Stop 永远到达。Stop/transcript 仅供有界诊断或可选事后转发；transcript 写入可能滞后，不是实时原文/摘要权威。[T6]

Telegram 截图只作为方案比较，不新增 Telegram 依赖、凭据或外发。完整数据契约、故障策略和用例见 05 实现细则。

## 12. 自动唤醒、计划与推送

### 12.1 任务类型

- 约定提醒：用户明确要求的提醒，按约定执行；失败可见，不由自主联系策略悄悄取消。
- 自主联系：时间/事件触发的考虑机会，char决定开口、暂不说或改下一次考虑。
- 模块事件：计划更新、任务完成或经筛选的手机观测，不必每条都叫模型。

Wakeup 保存 trigger、reason、source_ref/revision、due_at、timezone、expiry/catch-up policy、conversation、dedupe_key、state、last_attempt、notification_policy。重复调度、服务重启、时钟回拨都不重复生成同一条正式消息。

执行前刷新 Time Context 与相关状态。用户已经回来，原“很久没回来”的触发可失效；plan 已完成、撤销或日期变更，旧 occurrence 不再执行。情绪系统先不填假状态，也不替代已约定提醒。

### 12.2 先存消息，再投递

正式消息提交与 notification outbox 同事务；在线页面通过 SSE 读取，离线按可用推送通道提示。一个 turn 多气泡默认聚合为一个通知；音频和表情同理。通知 payload 只带必要内容/ID，私人和健康详情默认不放锁屏正文。

Web 首版可用在线投递；离线 Web Push 需设备、浏览器、安装方式和授权实测，不能把开着网页的演示当手机后台推送已完成。后续原生 iOS App 走 APNs 适配；APNs token 与消息库分开管理，失效 token 停用。客户端打开后按 cursor 补消息，不把 push 当唯一消息传输。

通知供应商成功接收不等于设备已展示，更不等于用户已读。可使用 provider 去重标识减重复，但不承诺端到端 exactly-once；通过消息 ID 实现应用内不重复。提醒过期补发策略不能默认全部补发。

## 13. 手机信号与健康数据：独立隐私边界

首版后端先保留接收与规则接口；读取 HealthKit 需要手机原生层或其他获授权的真实数据桥，不把 PWA 当原生 HealthKit 客户端。Apple 的 HealthKit 要求按数据类型管理授权；后台执行也不保证任意定时、持续运行。[T12,T13]

范围分三类：用户批准的健康观测、本应用状态、以后逐项授权的系统能力。不能将“手机后台”解释为任意读取其他 App 内容或全手机监控。

观测使用 `(device_id, source_sample_id, revision)` 去重，包含 sampled_at、received_at、单位、数据来源、撤回/删除状态和授权版本。先以独立信号库保存必要数据，再用规则形成最小事件；高频信号合并，不整批进入模型上下文。

向模型提供健康摘要属于独立数据披露边界，需明确开启并标注目的、字段与提供方；设备授权不自动等于授权所有外部模型处理。默认不写 hold，不传群聊，不向工作执行器开放。撤销后停止采集和未来披露，清理未处理事件/缓存，按用户操作处理已存数据；已经发送给外部服务的数据不能谎称可从其系统完全收回。

采样空白、权限被拒、同步延迟、设备离线分别显示。模型只能描述有证据的状态；不基于“无新数据”断言睡眠、运动或身体状况，不把这个系统做成急救监护或医疗诊断。

## 14. 模块注册与统一能力

### 14.1 三个可选接口

```ts
interface EstomagoModule {
  id: string;
  contractVersion: string;
  capabilities?: CapabilitySpec[];
  eventSchemas?: EventSchema[];
  contextProvider?: ContextProvider;
}
```

工具接口给主体主动调用，事件接口给模块报告变化，contextProvider 给开窗提供有限内容。模块可只实现一项。输入输出严格校验；所有内容带来源、权限域、版本与大小限制。核心注册能力不等于每个新模块完全零代码；认证、映射与 UI 接入仍需实现。

共享 ContextProvider 请求包含 participant、conversation/scope、业务日期、budget、权限版本；返回 fragments、citations、freshness、continuation 和 errors。核心按优先级装包，不把未知/空响应伪装成“没有记忆”。关键身份失败阻断；可选模块失败可降级。

### 14.2 业务正本与传输

API、MCP 和前端调用共用经过校验的业务服务，不写三套规则。外部已有 API/MCP 按实际版本适配，不猜现有端点；本规格下列路径仅指 estómago 拟新增接口。

| 能力组 | estómago 职责 | 原服务保持负责 |
|---|---|---|
| Mariposa | 归档、授权读取、基础包与版本适配 | 记忆、I、plan、检索、打开、遗忘 |
| 日历 | 按日期组合视图和导航 | plan/纪念和记忆仍在 Mariposa |
| 许愿星 | 展示入口、调用已授权工具 | 隐私、交换额度、拆阅、足迹规则 |
| Siren | 会话绑定、转写/文字桥、输出取消 | 音频协议、语音资源与通话状态 |
| 扎西德勒 | 连接已有房间、映射消息和 @ 事件 | 原房间权限与消息正本 |
| 情绪 | 提供当前状态引用、唤醒参考入口 | 算法/状态解释后续另定 |

计划完成/放弃后固定二十自然日，打开不续期；浏览日历和开窗也不能旁路触发记忆明确打开。Mariposa 搜索字段白名单、隐藏原文额外展开确认、worker 工作区隔离继续适用。[M1]

### 14.3 MCP 对 Chat 的边界

为 Chat 入口提供同一能力目录与 time.context 等接口，按认证主体和 scope 授权。MCP 是工具访问，不是自动启动一个聊天参与者；被 @ 后自动执行需要对应真实宿主或已授权 job executor。

禁止提供不受限的“调用任意服务/任意 URL/任意 shell”超级工具。代理外部服务不能成为身份混淆的中转站；scope 只能收窄。用户名称或工具参数中的 actor_id 不构成身份凭据。

## 15. 群聊与让林石见、程知行干活

保留群聊、私聊分开的 conversation 与上下文。群里 @ 到谁，产生该参与者的事件；不自动广播私人基础包、I、健康数据或不可见记忆。可共享的信息由原服务权限与明确授权决定。

工作任务 Job 保存 requester、room、assignee、scope、授权动作、工作目录白名单、deadline、状态、结果引用和审计证据。只有真实连接的执行器才能声称执行；Chat 端可经 MCP 领取/回报，但不能把未运行的窗口当在线代理。

长工作任务独立运行并回传房间，不占主私聊 actor。任务取消与聊天 stop 区分；已执行文件修改/远端动作不可假撤销。缺少执行入口则显示 pending/unavailable，不声称“林石见已开始干活”。

既有林石见对特定遗忘项的有限审查权继续按原授权，不因为本项目重构变成“所有工具人一律禁止”，也不扩成全库改写权。[M1]

## 16. 最小数据表与索引

建议首版使用一个 Host 写入的 SQLite 业务库；WAL 置于 Mac 本地磁盘，不放网络共享或同步盘。WAL 支持读写并行但仍存在单写者约束；事务短小，不在持锁期间调用模型或远端服务。[T14]

| 表/集合 | 核心字段与唯一性 | 备注 |
|---|---|---|
| conversations / members | id、owner_service、origin_room_id、scope、revision | 群聊镜像唯一来源映射 |
| messages | id、conversation、sequence、speaker、turn、kind、current_revision | unique(conversation, sequence) |
| message_revisions | message_id、revision、content_ref/hash、supersedes、timestamps | 不覆盖旧版 |
| turns / attempts | event_id、window_id、attempt_no、input_revision、state | 一轮可多次尝试 |
| windows | sdk_session_id、status、cutoff_seq、active_generation、manifest_ref | 当前指针受事务保护 |
| handoffs / context_snapshots | window、source_versions、budget、hash、permission_revision | 失效快照不再装包 |
| events / leases | event_id、dedupe_key、state、lease_owner、fence、expiry | unique(source, dedupe_key) |
| outbox / projection_acks | operation_key、revision、target、attempt、ack | 幂等重放，未知结果对账 |
| reasoning_blocks | attempt、sdk_message_id、block_index、revision、visibility、text_ref、state | unique(attempt, sdk_message_id, block_index)；独立于正式消息 |
| runtime_stream_events | stream_id、sequence、event_id、block_ref、revision、scope | 持久回放；日志不复制摘要正文 |
| bootstrap_receipts | window、manifest_ref、desired/assembled/observed/probe、gate_state | unknown 不伪装通过 |
| usage_observations | request_id、attempt、model、scope、tokens、source、completeness | 主会话/子任务分开 |
| route_decisions / approvals | decision_id、bound_hash、version、choice、consumed_at | 原子一次消费 |
| wakeups / occurrences | task_id、occurrence_id、due_at、source_revision、expiry、state | 每次发生项有唯一键 |
| effects | effect_id、idempotency_key、state、external_ref | side effect 对账 |
| assets / delivery_receipts | hash、ACL、size、MIME；message/device/provider receipt | 发送不等于阅读 |
| device_bindings | device、公钥/凭据引用、scope、consent_version | 密钥不进普通日志 |
| audit_events | who、what、scope、result、trace_id | 不记完整私人正文 |
| schema_migrations | version、applied_at、code_hash | 备份后才升正式库 |

健康原始观测可落独立 signals.sqlite3；它不是第二套聊天库。不同服务各自数据库，不跨服务 SQLite 连接做写事务。

## 17. 拟新增 API 与流协议

所有 `/api/v1/...` 为 estómago 建议接口，非已实现端点。登录可复用经评估的现有身份体系，也可首版单拥有者设备配对；不能把公网部署做成无鉴权。web session 使用受保护 cookie，并验证 Origin/CSRF；移动端使用受限 token，传输全程 TLS。

| 方法 / 路径 | 用途 | 必要约束 |
|---|---|---|
| POST /api/v1/conversations/{id}/messages | 提交文本/媒体/编辑 revision | Idempotency-Key + 房间权限 |
| GET /api/v1/conversations/{id}/messages | 分页时间线 | cursor、revision、ACL |
| GET /api/v1/events?cursor=... | SSE 消息/状态回放 | 认证、scope、断线去重 |
| GET /api/v1/turns/{id}/reasoning | 当前有效授权下读取该 turn/attempt 的摘要块 | cursor/revision/ACL；不返回签名 |
| POST /api/v1/turns/{id}/stop | 停止当前代 | generation/version；优先通道 |
| POST /api/v1/windows/{id}/rotate | 手动换窗 | 当前指针版本与身份 gate |
| GET /api/v1/conversations/{id}/runtime | 状态、token、模型、身份 manifest 摘要 | 私有信息脱敏 |
| POST /api/v1/route-decisions/{id} | edit / approve / cancel | 单次票据+输入hash+版本 |
| POST /api/v1/wakeups | 创建/更新调度 | task 类型、reason、scope、时间来源 |
| POST /api/v1/calls | 调用 Siren 适配创建通话 | 固定 conversation + profile |
| POST /api/v1/device-signals/batches | 授权设备上报 | device、consent version、幂等 |
| GET /api/v1/time/context | 同一时间口径 | 按 room/主体授权 |
| GET /api/v1/calendar | 日期视图 | 不触发明确打开或续期 |
| POST /api/v1/jobs | 群聊工作委托 | assignee/scope/approval |
| /mcp | 对 Chat/代理开放能力 | 协商协议版本；不绕过授权 |
| GET /health/live ; /health/ready | 进程活性/可接模型任务状态 | 公网不返回敏感配置 |

SSE 事件另加 reasoning.started/delta/snapshot/completed/status_changed、tool.status；reasoning 事件是本项目协议名，不冒称 SDK 原生名称。每条需 turn/attempt/block/revision/sequence 和权限。SSE 事件建议有 message.persisted、message.published、turn.started/completed/interrupted、usage.updated、window.changed、route.pending/resolved、archive.status、call.state、module.degraded；每项带 stream sequence、entity revision、conversation 和 privacy scope。

官方返回的可读思考摘要通过独立受权 reasoning 通道显示，不作为聊天正文、原文或 TTS 流出；签名、不可读内容和未被官方返回的过程不展示。工具调用状态显示实际、脱敏的执行进度。页面暂停播放或用户后台返回都从持久化状态恢复，不能仅靠内存播放器状态。

## 18. 运维、备份与安全

### 18.1 故障隔离

Host 活着不代表 SDK 可用，/ready 分项报告 identity、runtime、archive、push 与 module 状态。SDK 崩溃仅重启自己的进程树，不停止 Mariposa/Siren/cloudflared。日志关联 event/turn/attempt/window/request，方便找出哪一步未完成。

测试与生产根目录必须不同。测试默认拒绝连接正式服务、发送真实推送或使用真实记忆；外部服务由显式测试开关和独立凭据解锁。首次实机烟测前开启 CPU/内存/子进程数/执行时限保护，禁止递归 subagent 和无上限并行测试。

后台重新调度不等于保证 exactly-once。消息呈现用 ID 去重，业务写入靠幂等键，外部不可幂等副作用用核对和人工处理，unknown 不当失败后直接重跑。

### 18.2 备份与恢复

正式数据库采用 SQLite Online Backup 等一致性方式，不直接复制运行中的单个 db 文件忽略 WAL。[T15] 备份 manifest 包含 schema 版本、数据快照时间、消息水位、媒体 hash、身份/权限版本和恢复说明；秘密凭据单独受控备份。

本地 backups 只是恢复点；异机/外置盘备份另行配置并加密。正式聊天、身份、健康数据与 token 不进 Git，不放公共库；任何云同步目的地需单独授权。恢复测试使用独立路径并关闭模型、推送和副作用，验证后才允许切换。

升级先保存已知可用代码/锁文件和数据快照。不可逆 schema 变更不能只 git checkout 旧代码宣称回滚；必须验证兼容性或恢复匹配快照。Windows 旧服务在 Mac 验收之前保留，不自动删除；同一业务主动任务不得双机同时拥有调度权。

## 19. 分阶段交付与退出条件

| 阶段 | 交付 | 必须先通过 |
|---|---|---|
| A：现场与契约 | Mac doctor、路径、依赖锁、SDK 能力矩阵、身份 manifest | 无副作用检查；不碰旧生产 |
| B：聊天底座 | 持久消息、队列、SDK、思考摘要流、停止、时间、用量、基本前端 | 冷启动身份、流/完整块核对、摘要隔离、断线去重、崩溃恢复 |
| C：连续性 | 换窗、原文归档、Mariposa 开窗包、路由弹窗、Siren 桥 | 轮转交接、路由双端/重启、音频取消 |
| D：主动能力 | 表情、唤醒、在线/离线投递、日历/plan、许愿星入口 | 定时持久化、过期策略、真实设备推送 |
| E：扩展 | 健康原生桥、情绪接口、群聊执行器、其他模块 | 授权撤销、房间隔离、真实执行证据 |

身份、时间、token、路由状态结构和独立思考通道从 B 阶段就存在；不能到 E 再追补。健康/情绪算法不阻塞基础聊天，但接口和隐私域从首版保留。

交付状态只用 NOT_EXECUTED、PASS、FAIL、BLOCKED、NOT_APPLICABLE 等明确枚举。mock 全绿不是 Mac 真机、SDK 实际路由、Siren 通话或 APNs 真投递已通过。无法安全制造平台标记时，可测协议/录制脱敏夹具并标真实触发未执行，不为验收故意制作危险内容。

## 20. 实施前仍待测/待绑定，不影响现在写骨架

Mac 用户名与已存在目录；端口是否占用；Node/SDK/runtime 实际版本；已授权认证与计费方式；身份材料与 I 的有效版本；真实模型与容量；Mariposa/Siren/许愿星的接口和凭据；路由事件/继续动作覆盖范围；阈值与各上下文预算；手机授权、推送与 HealthKit 桥；公网域名与隧道启用时间。

这些项目先以 null、disabled 或 capability=unknown 表达。不得以“先跑起来”为由假设可用、偷偷改旧项目、发送真实消息或编造验收证据。

## 21. 来源与查证索引

v0.1 原技术核对日期为 2026-09-23；本次 SDK/思考/配置关键接口复核为 2026-09-24，继承业务未重新审计源码。在线文档会变化，实施应保存实际安装版本与查证摘要。以下只引用影响接口/运行行为的事实；本规格的表结构、状态机和部署路径均为本项目设计。

### 既有业务来源

- **[M1]** 《mariposa_v2.0.1_GLM实现路径与执行规章.md》，2026-09-22，重点 §0、§3、§10、§11。已从用户文件库读取相关原文；它是实施规格，不代表此刻 Mac/Windows 源码已通过 v2 验收。
- **[M2]** 《char双入口统一记忆与能力架构_工程版.md》，v0.3 时间感知补充版，2026-09-19，§11/§12。时间事实由程序提供，两个入口共用时间口径。
- **[U1]** 本对话：SDK 模式、功能清单、上下文与原文、token/1M 显示、时间感知、身份/settingSources 验收、路由弹窗、项目命名与 Mac mini 目标。其明确新要求优先于旧文档的宿主组织建议。

- **[U2]** 用户上传《给机看的教程.pdf》，11 页；自述版本锚为 Claude Agent SDK 0.3.234 / Codex app-server 0.144.5、2026-08-21。用于直接 SDK 装配、工具与提示分层；不将作者未提供仓库的“实测”冒充本机证据。
- **[U3]** 用户上传 IMG_3428.jpeg（摘要参数/ThinkingBlock 教程）、IMG_3429.jpeg（显示效果）、IMG_3435.jpeg（Stop hook / Telegram 方案）。参考用，不继承其中人物名、文件名、“桥下”标题或 Telegram 功能为新业务。
- **[U4]** 本对话后续：要求可见思考并核对教程，确认升级原 ZIP，新增单独给char的 MD。上轮复核意见作为本次修订依据；官方事实与设计选择分列于 06。

### 官方技术来源

- **[T1]** Claude Code / Agent SDK — Modifying system prompts：默认提示、CLAUDE.md、恢复时提示快照。
  https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- **[T2]** Agent SDK — Migration guide：settingSources 默认行为的撤回说明。
  https://code.claude.com/docs/en/agent-sdk/migration-guide
- **[T3]** Agent SDK — Use Claude Code features / Configure your agent：不受 settingSources 控制的输入、显式 settings 与环境。
  https://code.claude.com/docs/en/agent-sdk/claude-code-features
  https://code.claude.com/docs/en/agent-sdk/configuration
- **[T4]** Agent SDK — Configure permissions：allowedTools、审批和权限边界。
  https://code.claude.com/docs/en/agent-sdk/permissions
- **[T5]** Agent SDK — Work with sessions：恢复、分叉和会话标识。
  https://code.claude.com/docs/en/agent-sdk/sessions
- **[T6]** Claude Code — Hooks reference：PreCompact/PostCompact、PreModelSwitch/PostModelSwitch 的范围与限制。
  https://code.claude.com/docs/en/hooks
- **[T7]** Agent SDK — Track cost and usage：turn、累计和流式用量口径。
  https://code.claude.com/docs/en/agent-sdk/cost-tracking
- **[T8]** Claude Code — Model configuration：switchModelsOnFlag 与非交互运行的差异。
  https://code.claude.com/docs/en/model-config
- **[T9]** Agent SDK — Stream responses in real-time：部分消息与完整消息。
  https://code.claude.com/docs/en/agent-sdk/streaming-output
- **[T11]** Apple — Creating Launch Daemons and Agents：launchd 托管与启动配置。
  https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- **[T12]** Apple DTS — iOS Background Execution Limits：后台运行不保证任意实时/定时执行。
  https://developer.apple.com/forums/thread/685525
- **[T13]** Apple — Getting started with HealthKit：原生能力与授权。
  https://developer.apple.com/la/videos/play/wwdc2020/10664/
- **[T14]** SQLite — Write-Ahead Logging。
  https://www.sqlite.org/wal.html
- **[T15]** SQLite — Online Backup API。
  https://www.sqlite.org/backup.html

- **[T16]** Claude Platform — Thinking：display、可读摘要、空/删隐、签名、流及用量。
  https://platform.claude.com/docs/en/build-with-claude/thinking
- **[T17]** Agent SDK — Python reference：教程参数的官方类型对照；不是 estómago 改用 Python 的要求。
  https://code.claude.com/docs/en/agent-sdk/python
- **[T18]** Agent SDK — TypeScript V2 session API (removed)。
  https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview
- **[T19]** Agent SDK — Overview：本地 harness 范围及认证使用前提。
  https://code.claude.com/docs/en/agent-sdk/overview

**本稿完成的是设计，不是部署。所有新增文件、接口和验收用例在真实项目中仍需实现与执行。**
