# 04 · 上下文、缓存、保温与自动唤醒执行规格

规范标识：`ESTOMAGO_CHAT_EXEC_V1`；本章：`CONTEXT_CACHE_WAKE`  
核验日期：2026-10-11（Asia/Shanghai）  
源码基准：`Asccccyn/estomago` 默认分支，提交 `4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1`。本文件依据该提交的实际运行代码，不依据旧分支、审计包里的 source 副本或过去的功能说明推断实现状态。

本文件供 GLM 实现与后续审计使用。`REQUIRED` 表示本轮必须落实的行为；`ENGINEERING_DEFAULT` 表示可落地的保守工程初值，不代表用户已经批准任何具体美元费用；`BLOCKED` 表示缺少运行证据或配置，程序必须显示原因并停止相应付费调用。实现后必须分别报告代码完成、离线验证通过、真实供应商尚未验收三种状态。

## 1. 本轮结果与范围

est 保留现有聊天宿主、原文与窗口管理，在现有进程内增加一个轻量调度器，服务三种不同任务：

| 类型 | 用途 | 是否调用主模型 | 归属开关 | 频率或时间规则 |
|---|---|---|---|---|
| `autonomous` | char定时开始一轮自主活动，可以选择不做任何事 | 是 | `background.autonomous.enabled` | 同一主体在滚动 60 分钟内最多开始一轮 |
| `keepwarm` | 尽量延续当前窗口的 1 小时缓存 | 是，最多一次受限请求 | `background.keepwarm.enabled` | 距有缓存读写证据的请求开始时间 50 分钟后到期 |
| `reminder` | 到点投递预先写好的提醒或留言 | 否 | `background.reminders.enabled` 与任务自己的 `enabled` | 按已设置时间投递，不受自主活动 60 分钟限制 |

三个开关、两类模型预算独立。**关闭自动唤醒必须真正阻止新的自主模型调用，并停止活动中后续可取消步骤。**不能只隐藏按钮、停新增定时器或把任务改为未显示。关闭不会退还已经发出的请求费用，也不能撤销已经完成的外部写入。

50 分钟是保温调度间隔，API 的缓存 TTL 仍为 `1h`。不得写成 `ttl: "50m"`。50 分钟也不替换自主活动的 60 分钟冷却。

本轮不增加 Redis、BullMQ、独立 cron 服务、新守护进程、通用工作流引擎或另一个后台人格。调度器使用现有 Node 进程、SQLite、`TurnSupervisor` 和适配器。SSE 的网络心跳仍只是网络心跳。

## 2. 必须保留的上下文合同

### 2.1 原文、窗口与缓存分别承担什么

1. `REQUIRED`：正式聊天原文和修订记录继续保存。未 hold、未绑定桶、未被手选带入新窗、缓存失效、进程重启，都不能自动删除原文。
2. `REQUIRED`：当前窗口的协议轨迹继续以 `window_trajectories` 为依据，发送前继续检查历史前缀只能追加。供应商缓存不成为历史内容的来源。
3. `REQUIRED`：自动换窗仍按当前 64k 工作集软线及容量安全余量判断；保留现有手动换窗。静默、午夜、缓存到期不能新增自动换窗条件。
4. `REQUIRED`：新窗携带的历史只来自用户确认的原文选集。允许明确选 0 条；尚未确认不等于选 0 条。
5. `REQUIRED`：换窗前既有 hold 提醒沿用真实已见清单、最近成功 hold 书签和完成凭证。没有值得记的内容可正常结束；不添加小模型扫描漏记。
6. `REQUIRED`：不恢复 DS 日摘要、滚动摘要、递归摘要、固定 12k 原文注入或第二套记忆。不得把 SDK compact 产物写成原文、桶、开窗摘要或 hold 成功凭证。
7. `REQUIRED`：达到换窗条件但用户尚未确认选集时，后台活动进入 `CONTEXT_SELECTION_REQUIRED`，结束本次调度尝试并等待用户处理。不能为了继续后台活动自动空选或绕开换窗门。

当前落点：`runtime/window-trajectory.ts`、`context/manual-selection.ts`、`context/review-policy.ts`、`runtime/supervisor.ts`、`windows/manager.ts`。本轮复用这些服务，不平行新建一套上下文管理器。

### 2.2 配置只有一条生效路径

静态配置给初值，已确认的运行设置保存在现有 `runtime_settings` 表，由一个 `effectiveBackgroundSettings()` 生效视图统一读取。页面、调度器、派发前预算检查与状态接口必须读取同一视图。不得出现页面已关闭，而 worker 使用启动时缓存的旧 `enabled=true`。

缓存策略仍由 est 的经确认配置决定。上游若不支持或强制覆盖参数，应显示 `BLOCKED`／`UNVERIFIED`；不能悄悄改 TTL、启用摘要、换模型或换 provider 来伪装成功。

## 3. 当前源码事实与准确修改落点

| 源码位置（基准提交） | 已有真实实现 | 本轮要求 |
|---|---|---|
| `apps/host/src/runtime/runner.ts:78-99` | OR、SDK、DS 分开选择；OR 路径不加载 SDK | 保持隔离；背景任务显式传 driver 和 purpose |
| `apps/host/src/runtime/runner-openrouter.ts:30-43` | 直接请求 `/chat/completions` | 继续直接调用，不把 OR 请求绕回 SDK |
| `apps/host/src/runtime/or-payload.ts:8-9,61-90` | Anthropic provider 族使用 1h 缓存；关闭 OR `context-compression` 插件 | 保留最终发包约束；增加维护请求的受限调用方式 |
| `apps/host/src/runtime/or-payload.ts:97-114` | 检查模型、工具与消息前缀稳定 | 正常聊天与自主回合都经过此门；保温不可污染下一轮比较基准 |
| `apps/host/src/runtime/cache-plan.ts` | A/B/G 显式断点规划 | 复用；保温请求保护当前规范轨迹中真实可复用的末端边界 |
| `apps/host/src/runtime/supervisor.ts:106-153` | 房间串行链、停止控制器、generation fence | 新增后台入口，复用同一个互斥与取消机制；聊天优先 |
| `apps/host/src/runtime/supervisor.ts:198-365` | 现有 OR/DS 工具循环 | 在每次模型派发、重试、工具派发前接预算与开关检查 |
| `apps/host/src/runtime/supervisor.ts:69-73` | `MAX_TOOL_ROUNDS=8` | 保留聊天既有上界；后台再受整轮总预算限制，不能以此冒充完整预算 |
| `apps/host/src/runtime/runner-openrouter.ts:121-149`、`runner-deepseek.ts:131-158` | 自动重试在 driver 内；当前 `onDispatch` 在获得响应后才调用 | 新增每次 transport 前的异步准入／预占回调；包括网络失败、429 与首字节前重试 |
| `apps/host/src/runtime/supervisor.ts:775-838,853-925` | 64k、人工选集、hold 提醒 | 背景活动沿用；不改原文及书签口径 |
| `apps/host/src/server/records.ts:85-89,123-135` | 按最近请求推算到期，`keeperEnabled` 固定 false | 改成真实配置、实际缓存观测和估计到期；SDK 未验证不能显示已请求 1h |
| `apps/host/src/app-context.ts:91-218` | 装配宿主、恢复聊天与归档，无唤醒调度器 | 在这里创建、启动、停止唯一的宿主内调度器 |
| `apps/host/src/config/schema.ts:94-98`、`supervisor.ts:853-861` | 现有 `reminders.enabled` 仅是换窗 hold 提醒 | 保留原含义；新增 `background.reminders.enabled` 不得覆盖它 |
| `apps/host/src/db/migrations.ts:647-659` | v20 已删除死 `wakeups` 表 | 不复活旧空表；按本文明确用途增加小表 |
| `apps/host/src/server/http.ts:104-110` | 写入 Origin 门覆盖 POST／PUT／DELETE | 新接口使用 PUT；若全局选择 PATCH，必须同时补写入校验 |

源码中 `proactive_turn`、`cache_keepalive` 目前只存在于 purpose 类型及数据库约束，**不等于自动唤醒或保温已经实现**。现有 SSE 每 15 秒的 `: ping` 也不会调用模型。

### 3.1 最少新增模块

新增两个生产模块即可：

- `apps/host/src/runtime/background-scheduler.ts`：持久任务查询、到期领取、恢复、开关生效、调用 supervisor，不直接实现模型 transport。
- `apps/host/src/runtime/background-policy.ts`：时间计算、滚动冷却、预算验证、准入判定与状态转换纯函数，便于用虚拟时钟验证。

其余修改集中在上表已有文件；前端只增加相关设置与状态。不能为三类任务各建一个调度服务。若代码体量确需把 SQLite 读写抽成第三个文件，必须仍属于同一后台模块，不新增独立进程或业务中心。

## 4. 设置、默认值与启用行为

本节数字和初值表是 `contracts/policy-defaults.json` 的可读摘录。程序与默认配置生成只读取该统一合同，不在 scheduler、UI 或测试中再维护一份不同的默认值。用户既定的 1h／50min／60min／64k 与工程初值的来源标记分别保留。

### 4.1 三个独立开关

| 设置 | 初值 | 作用 |
|---|---|---|
| `background.autonomous.enabled` | `false` | 允许自主模型活动；关闭时即时取消后续可取消步骤 |
| `background.keepwarm.enabled` | `false` | 允许付费缓存维护；关闭时取消尚未发出的维护请求 |
| `background.reminders.enabled` | `true`，`ENGINEERING_DEFAULT` | 允许用户已显式启用的普通提醒投递；无任务时不产生任何投递 |

提醒还必须有任务级 `enabled=true`。用户新建并启用提醒即可按时执行，不因自动唤醒或保温默认关闭而失效。普通提醒开关不控制系统故障红点、权限阻断、原文同步失败等系统告警。

`REQUIRED`：自动唤醒开关至少出现在聊天设置中；同时显示“关闭后不再开始自主活动，正在进行的后续步骤会停止；已经产生的费用和已经完成的动作保留”。无需额外重复确认关闭操作。

模型可以通过业务工具设置、修改、暂停自己的唤醒任务；任务时间不能绕过滚动冷却和总开关。char不能通过创建新任务、修改任务 ID、跨房间设置任务或调用外部后端重新开启被用户关闭的总开关。

### 4.2 预算初值

预算按用途分开保存；每次执行冻结一份预算快照，执行过程中关闭／收紧立即生效，放宽只对后续新执行生效。

| 参数 | `autonomous` | `keepwarm` | 标记 |
|---|---:|---:|---|
| `min_interval_ms` | 3,600,000 | 不适用 | 用户要求的 60 分钟冷却 |
| `idle_after_cache_ms` | 不适用 | 3,000,000 | 用户要求的 50 分钟保温目标 |
| `max_model_requests_per_run` | 4 | 1 | `ENGINEERING_DEFAULT`；包括所有重试和续答 |
| `max_output_tokens_per_run` | 4,096 | 128 | `ENGINEERING_DEFAULT`；包含计费 reasoning 输出 |
| `max_tool_calls_per_run` | 8 | 0 | `ENGINEERING_DEFAULT`；一批内多工具分别计数 |
| `max_run_ms` | 120,000 | 30,000 | `ENGINEERING_DEFAULT`；包括等待与重试 |
| `paid_tools_enabled` | `false` | 固定 `false` | 首版关闭外部付费工具 |
| `allow_cold_start` | 不适用 | 固定 `false` | 保温一期受限值，UI 不提供直接开启入口 |
| `daily_cost_cap_usd` | `null` | `null` | 未配置，不是无限额；不能开始相应用途的付费请求 |

说明：

- 默认的输出、请求数、工具数与时长用于让实现可执行，并不代表最优数值或用户批准了相应费用。前端必须显示生效值。
- 每日美元上限没有用户已确认的数值，保持 `null`。用户填入有效上限并主动启用相应功能后，才具备该范围内的付费运行授权；开发与自动验收不代替这一步。
- `enabled=true` 的写入若缺预算、明确型号、身份、有效凭据或必需能力验证，返回结构化 `422`，不先开功能再等待第一次付费失败。
- 开关已经开启后，若配置变更使条件不再成立，保留用户设置意图但令 `effective_enabled=false`，显示具体阻断原因，不自动补预算。
- 某型号不接受 128 输出上限或当前 reasoning 组合时，保温应显示 `KEEPWARM_MODEL_PARAMETERS_UNSUPPORTED`。不能偷偷提高输出额度或改推理档位来跑通。
- `paid_tools_enabled=false` 仅限制外部收费动作；已经接通的免费日常工具仍按原主体权限提供。维护写面、身份管理、密钥管理等既有权限边界不因自主模式扩大。

业务日为 Asia/Shanghai；存储时间为 UTC。后台预算的日归属按每次派发开始时的北京时间日期固定，跨午夜返回 usage 不能把同一笔预占挪走或重新获得额度。执行中的超时和冷却间隔使用单调时钟，持久化仍使用 UTC。

## 5. 50 分钟滚动保温的确切算法

### 5.1 何时认为有可用的计时基准

1. 请求通过本次 1h 缓存配置发送；当前 provider／型号支持该参数。
2. 返回的用量确实包含非零缓存读取或缓存写入；将该请求的 `dispatch_started_at` 作为候选计时起点。
3. 请求必须对应当前有效窗口与仍可复用的固定前缀。旧窗、旧型号或已失效工具快照不能给新窗续期。
4. `next_keepwarm_at = last_cache_activity_started_at + 50 minutes`。

缓存命中量、写入量和 TTL 请求值分别展示。`last_cache_activity_started_at` 是调度依据，不是“整段上下文 100% 命中”的证明；到期时间始终标为估计。只有开始请求、收到 200、收到普通回复或请求失败，均不足以假定缓存刷新成功。用量缺失时显示未知，不补零，也不无条件重置倒计时。

当前 driver 的 `onDispatch` 在响应头之后触发，不能继续拿这一时间冒充请求开始。本轮为每次 transport 调用记录前置 `dispatch_started_at`，获得用量后再关联它。派发开始记录与“模型已经看过哪些原文”的证据分开；不能把刚写入预占账本的请求当作已见原文，从而提前推进 hold 范围。

### 5.2 到点前重新判定

调度器到点后先读取最新窗口、最新缓存观测、开关和用户待处理消息，再决定是否发送：

- 普通聊天或自主活动已经产生新的有效缓存观测：移动保温任务的到期时间，原到期机会作废，不能再发旧任务。
- 正在聊天或有待处理用户输入：让出执行权。聊天结束后重新判断，不能把旧维护请求排在用户下一条消息前面。
- 同时有一轮已经到期且通过 60 分钟门的自主活动：先执行自主活动；它产生有效缓存观测后取消这次重复保温。
- 没有活动窗、等待手选原文、身份门阻断、前缀已变、明确没有形成缓存、缓存证据未知：不发送保温请求，报告具体状态。
- 当前时间已经超过该缓存估计到期时间：默认不为“保温”进行一次冷写入。等下一次正常聊天或已获准的自主活动形成新观测后再排期；标记 `KEEPWARM_CACHE_ALREADY_COLD`。

以上“不在过期后补一次冷写”对应 `background.keepwarm.allow_cold_start=false`，是一期固定受限值，UI 不提供直接开启入口，目的是避免电脑睡眠几小时后把已冷缓存当作仍在保温。后续若用户明确需要无人聊天时也主动建冷缓存，应另行修改已确认的策略，不能在本轮偷加。

### 5.3 维护请求如何发送

`purpose=cache_keepalive`：

- 使用当前窗口的规范协议轨迹、同一型号、同一身份和同一已冻结工具定义快照；不重新拉一份身份或工具列表拼入旧窗。
- 在发送副本尾部加入最短的宿主维护说明，明确这不是用户消息，只要求短确认。它不写进用户原文。
- 使用同一 1h 缓存与断点规划。保护点要落在当前规范轨迹中真实存在的文本边界；不得只保护维护说明本身。
- 最多发送一次模型请求；任何工具请求都由宿主拒绝执行，不能因为模型返回了 `tool_calls` 就进入现有工具循环。不得依赖提示词作为唯一工具禁用措施。
- 不为了禁用工具而随意清空工具定义、变更模型或推理参数，避免自己破坏缓存前缀。若使用供应商公开的 `tool_choice` 控制，必须验证它与当前缓存形态兼容；宿主执行门始终存在。
- 所有用量照常记录；维护尾消息和回复只留在受保护的请求证据中，**不推进 `window_trajectories` 的规范消息，不推进 hold 书签或人工选集，不产生聊天气泡、朋友圈、桶或原文消息**。
- 下一轮聊天的前缀校验仍以规范轨迹为基准，不能把保温请求临时添加的尾消息当成上一轮必须复用的历史。

若维护请求没有形成有效缓存读写证据，终态记为 `failed` 或 `skipped` 并说明原因；不马上反复请求直到“看起来热了”。后续只有新的有效缓存观测或用户明确调整配置后才重新形成维护机会。

### 5.4 50 分钟与 60 分钟同时成立的例子

假设 10:00 普通聊天请求产生有效缓存观测，10:35 又聊了一次，则保温目标移动到 11:25。若 11:20 恰有一轮合法自主活动并刷新缓存，目标再移到 12:10，不会在 11:25 另发一次。

假设上次自主活动于 10:00 开始，保温于 10:50 到期，自主闹钟设在 11:00：这两项可以分别执行，因为它们有独立用途和预算。不能把 10:50 的维护请求算成一次自主活动，也不能为了省掉维护请求而将 11:00 的自主任务提前到 10:50。调度页面应显示这两笔可能用量。

## 6. 自主活动：同一个char，同一个执行入口

### 6.1 开始一轮的条件

`purpose=proactive_turn`。领取任务前及首次模型派发前都检查：

1. 自动唤醒总开关及任务开关仍然打开。
2. 当前主体具有有效身份、当前 driver 就绪，已有日常能力注册完成。
3. 没有正在执行或已等待的用户聊天，没有其他主模型活动占用宿主执行位。
4. 同一主体上次自主首个派发开始距今至少 60 分钟；创建多个任务、多个房间或改 ID 都不重置它。
5. 当前窗口可继续使用；若需换窗，沿用手选原文门，不能自动创建替代人格窗口。
6. 本次全部预算有效且仍有余额。

冷却记录以该主体的 `background_runs.first_dispatch_started_at` 为依据，跨任务统一。第一次可能收费的派发一旦开始，即消耗这次 60 分钟机会；即使随后失败、用户关闭开关或费用未知，也不能立即重开另一轮。尚未派发、被聊天抢占而取消的领取不消耗机会。

启用总开关不应立即补跑历史积欠任务。未指定立即活动的情况下，周期任务从启用后的下一个合法时间开始；自设闹钟早于冷却允许时间时，返回并展示实际 `effective_due_at`，不能悄悄修改后不告知。

### 6.2 自主选择和正常 no-op

char可以使用当前已接通、对他授权的日常工具：阅读、浏览、创作、发消息、写朋友圈、归档重要图片等。外部服务不可用时，工具如实返回 unavailable，他可以换件事做或结束。不能为了补齐一次唤醒的产出而自动连续重试。

普通模型文本不默认发布到私聊。真正要对宿主用户发文字时，调用 `chat_send_text`；发送图片等附件时调用 `chat_send_attachment`；要发布朋友圈时，走对应的独立内容能力。最终说明和工具运行日志不当作正式聊天发言。

`chat_send_text` 应复用现有正式助手消息发布函数，其最少参数为 `{ text, idempotency_key }`；房间、主体和运行归属由宿主填入。工具的 `idempotency_key` 映射到与 HTTP `Idempotency-Key` 相同的幂等服务，文本发送与附件发送沿用同一投递规则，不能因为来自后台就新造一张独立聊天消息表。明确发送工具仅向已授权的当前私聊投递，不能接受任意收件人地址扩成通用消息发送器。

建议增加一个很小的结束工具：

```ts
background_complete({ outcome: "done" | "noop" }): { completed: true }
```

该工具仅在 `proactive_turn` 有效。`noop` 是成功结束的一种结果，不要求理由、消息、图片、hold 或其他成果。若模型以正常终态结束且没有任何公开内容或副作用，也允许记录为 `noop`；不以“没有发消息”为失败重试理由。内部诊断只保留结果码，不要求模型写一段自我总结。

### 6.3 协议轨迹与原文归档

自主活动复用当前已批准身份与窗口的协议轨迹。唤醒说明标为宿主事件，不伪造“宿主用户发了一条消息”。已实际进入模型请求的工具往返按现有协议继续态保存；未向用户公开的维护说明、操作日志不写成正式原文。

char明确公开的消息必须进入现有正式消息发布、修订、原文同步链。只发布一次，不能工具已经发了消息，又把同样的最终回复再发一遍。外部作品或朋友圈返回的稳定引用通过对应业务能力保存；后台调度器不复制它们的正文作为第二份正本。

工具定义按当前窗口冻结。不要在每次从聊天切到自主／保温时重新排列或增删整套 tools；实际执行权限由 purpose、总开关、主体能力和预算共同检查。新增工具集导致窗口指纹变化时沿用现有受控切换，不擅改旧窗口协议历史。

## 7. 聊天优先、关闭开关和取消语义

### 7.1 不只是 FIFO 排队

现有 `runSerialized()` 是串行 Promise 链。直接把后台任务排进去仍可能让用户等很久；本轮需要在不重写整个 supervisor 的前提下补两点：

- 用户消息持久化后，进入串行链前立即通知 supervisor：存在优先用户工作；取消当前背景活动的后续可取消步骤。
- 后台闭包真正取得执行位时重新检查用户待办与开关。如果用户后来先排入待办，后台闭包让出，不继续长时间占位。

模型执行优先级是：用户聊天／用户触发的既有恢复动作，高于合法自主活动，高于保温。普通无模型提醒通过短事务和现有投递层执行，不占主模型执行位。继续遵守 `max_active_primary_runners=1`，不能用另一个房间或另一种 purpose 再启动并行主模型。

### 7.2 自动唤醒关闭必须原子生效

处理 `PUT` 关闭请求时：

1. 在一个 SQLite 事务内持久化 `enabled=false`，递增设置修订号，并把尚未执行的自主领取标为取消／失效。
2. 事务提交后立即 fence 当前自主执行、调用其 `AbortController.abort()`，唤醒等待中的调度器。
3. 后续每一次模型 transport、重试等待结束、工具派发与工具批次中的下一项，都重新读取有效开关／修订号并检查取消信号。预占成功不是无限期派发许可：预占提交与真正调用 transport 之间若发生 await，恢复后必须再次检查取消代号；关闭接口返回后不得开始新的自主 transport。
4. 迟到的 chunk、普通完成文本和未提交的公开消息不能在已取消后继续发布。
5. 已经提交到外部服务的动作按原 operation ID 查询结果；需要做的是核实和记账，不能把不明结果记作已撤销。

已经开始的不可撤销操作可能仍完成，状态应是 `unknown`／“等待结果核实”，而不是假写 `cancelled`。这部分不允许重试收费动作，但允许不收费的结果查询、收据处理和日志收口。已发生费用仍计入当日预算，未知费用继续占用预留额度。

关闭自动唤醒不自动修改保温或普通提醒开关。关闭保温按同样方式取消维护请求，但不停止聊天。关闭普通提醒投递不隐藏系统故障红点；重新开启不把积欠提醒批量推送一遍。

### 7.3 单次停止

提供单次执行停止接口。停止一次不会关闭总开关；关闭总开关则影响当前与后续自主执行。返回值必须区分：已经停止、正在取消、有已发出操作待核实、执行已结束。不能以 UI 上按钮变灰作为停止成功证据。

## 8. SQLite 结构：三张小表，不做通用工作流

新增 `background_tasks`、`background_runs`、`background_dispatches`。第三张表仅用于逐次收费预占、重试计数及未知结果恢复；因为现有 `tool_side_effects.kind` 只覆盖 hold／source_bind／review_complete，不应把图片生成等动作硬塞进记忆写入账本。

数据库迁移在当前 v20 之后按整批统一分配编号，不与其他工作包各自占用同一个版本号。需要同时覆盖 fresh install 与 v20 升级；迁移不得恢复已退役的旧摘要或 wakeups 表。

### 8.1 `background_tasks`

| 字段 | 要求 |
|---|---|
| `id`、`conversation_id`、`actor_id` | 稳定任务 ID、所属房间与实际主体；主体取现有身份，不用用户提交的任意值扩权 |
| `kind` | `autonomous` / `keepwarm` / `reminder` |
| `enabled`、`revision` | 任务开关与乐观并发修订号 |
| `schedule_kind` | 首版仅 `once` / `daily` / `interval` / `cache_idle`；不用通用 cron 表达式 |
| `scheduled_at`、`next_due_at` | UTC；已设置时间与实际下次到期时间分开 |
| `timezone`、`local_time`、`interval_ms` | 适用于相应调度类型；当前业务时区固定 Asia/Shanghai |
| `payload_json` | 受保护的小业务参数：提醒正文或活动意图、关联稳定 ID；不放身份、API key、整段聊天或全量工具定义 |
| `created_by_actor_id`、`created_at`、`updated_at` | 真实来源与时间 |

约束：每房间／主体最多一个 `cache_idle` 保温任务；周期自主任务的间隔不能小于 60 分钟。重要事项的正文仍归原业务后端，提醒只留引用和投递所需的最少内容。

此处 `actor_id` 是实际执行主体，`created_by_actor_id` 才是谁设置了任务。autonomous/keepwarm 的执行主体固定为获准的 `jiaming`：即使闹钟由宿主用户在前端创建，也不能把执行主体改成qiaosheng并获得另一份60分钟额度。普通预写留言的作者取源对象的可信author，不因任务创建者或服务调度而冒名。模型不能自报actor，也不能提高用户总开关或预算；用户在已授权私密会话中仍可停止后台活动。

### 8.2 `background_runs`

| 字段 | 要求 |
|---|---|
| `id`、`task_id`、`conversation_id`、`actor_id`、`kind` | 一次领取的归属 |
| `task_revision`、`occurrence_key`、`scheduled_for` | 一次机会的稳定身份；`occurrence_key` 唯一 |
| `state` | `claimed` / `running` / `cancelling` / `completed` / `noop` / `skipped` / `cancelled` / `failed` / `unknown` |
| `window_id`、`window_revision`、`driver`、`model` | 领取时快照；派发前必须复核仍有效 |
| `settings_revision`、`budget_snapshot_json` | 经批准的生效设置与小型预算快照，不保存密钥 |
| `claimed_at`、`first_dispatch_started_at`、`finished_at` | UTC；首个可能收费派发开始才启动自主冷却 |
| `model_requests_started`、`tool_calls_started`、`output_tokens_observed` | 累计；重试和多工具不能漏算 |
| `reserved_cost_micro_usd`、`known_cost_micro_usd`、`unknown_cost_count` | 整数美元百万分之一；未知不补零 |
| `result_code`、`cancel_reason` | 脱敏结果，如 `USER_CHAT_PREEMPTED`、`AUTONOMOUS_DISABLED` |
| `cache_observation_json` | 仅保温或缓存观测需要的窗口指纹、请求起点、读写 token、覆盖质量；不存完整请求 |

`occurrence_key` 由任务 ID、任务修订、计划发生时间生成，不用每次轮询随机生成。加局部唯一约束，防止同主体出现多条 `claimed/running/cancelling` 的自主执行。宿主仍保留既有单实例锁和执行互斥；数据库约束负责重启及重复回调下的最终去重。

### 8.3 `background_dispatches`

| 字段 | 要求 |
|---|---|
| `id`、`run_id`、`logical_action_key`、`attempt_no` | 每次真实尝试的稳定定位；组合唯一 |
| `dispatch_kind`、`capability_name` | `model` / `tool` / `delivery`；能力名，不保存完整用户正文 |
| `operation_id`、`provider_request_id`、`external_receipt_ref` | 幂等及对账引用；不可伪造供应商支持 idempotency |
| `state` | `reserved` / `started` / `settled` / `cancelled_before_send` / `unknown` |
| `budget_day`、`reserved_cost_micro_usd`、`actual_cost_micro_usd` | 派发开始日及费用；实际未知为 null |
| `dispatch_started_at`、`response_received_at`、`settled_at` | 不把响应时间当开始时间 |
| `outcome_code` | 脱敏结果码 |

`provider_requests` 增加可空的 `background_run_id`、`background_dispatch_id`、`dispatch_started_at` 关联字段；既有聊天请求继续兼容。收到 generation ID 时补关联。不得仅按一个 run 的最终 usage 记费用而覆盖中间多次请求。

每次背景请求须保存经过最终 payload builder 后实际交给 transport 的 JSON 请求体与实际 usage，包括保温请求的维护尾消息及缓存／压缩控制参数。当前 `supervisor.ts:246-247,263-280` 保存的 `payload_json` 是内部 envelope，不能把它称作已经证明了全部发包字段。新增请求可继续使用这个字段保存最终请求体，并增加 `payload_format=wire_v1` 标记；旧行保持原样，标识为 `envelope_legacy`，不重写历史来冒充以前已保存过最终 payload。若统一请求层另有等价受保护证据字段，则复用该字段，避免重复保存两份大 JSON。请求正文只保存在受保护证据库，普通日志和背景列表不得返回它。

保温不推进主窗规范轨迹，但保温已经发生的请求证据与用量必须保留。不能为了保持前缀干净，把维护请求行、费用或已发生事件删除；下一次主聊只是不把维护尾部选作自己的历史比较基准。

普通提醒使用稳定投递 operation ID 接入现有投递链；不要在调度表再实现一份消息 outbox。后端若已经有相同用途的持久逐调用账本，应复用并保持本文字段语义，不能两边各算一遍钱。

## 9. 状态机、去重与重启

### 9.1 执行状态转换

| 当前状态 | 条件 | 下一状态 |
|---|---|---|
| 无执行记录 | 到期、开关及身份合格、无同 occurrence | `claimed` |
| `claimed` | 优先用户工作出现／开关关闭／窗口过时 | `skipped` 或 `cancelled`，不收费 |
| `claimed` | 首次派发通过预算预占 | `running` |
| `running` | 正常完成明确活动 | `completed` |
| `running` | 主模型选择什么都不做 | `noop` |
| `running` | 用户聊天抢占、关开关或单次停止 | `cancelling` |
| `cancelling` | 可取消部分结束且无未决外部操作 | `cancelled` |
| `running/cancelling` | 已开始外部操作，结果或费用不明 | `unknown` |
| `running` | 确定性错误／预算耗尽 | `failed`，记录具体 code |
| `unknown` | 通过同一 operation ID 收到可核实结果 | `completed`／`cancelled`／`failed`，保留历史状态证据 |

预算耗尽可以正常停止已完成部分，不能把既有作品或已发消息回滚。失败和 no-op 都不自动创建一轮新的自主机会。

### 9.2 重启规则

- 使用现有单实例锁，调度器在 `Host.start()` 恢复一次，在 `Host.stop()` 停止领取并取消可取消任务。
- `claimed` 且没有任何 dispatch 的孤儿记录可标 `skipped:HOST_RESTART_BEFORE_SEND`，不自动当场补跑。
- `running/cancelling` 中存在已经开始的 dispatch，先标 `unknown`，保留其费用预占；有确定未开始证据的部分才能释放。
- 恢复阶段只做有界、不收费的 operation 状态查询和投递收据核对，不调用主模型猜测结果，不重新执行图片生成等收费动作。
- 一次性自主闹钟如果已错过，标记 missed；周期自主任务只计算未来下一个合法时刻，不创建过去每小时的执行记录再挨个补跑。
- 保温从当前仍有效的缓存证据重算；已冷则等待新聊天／新合法自主活动，不补历史保温。
- 普通提醒只向现有投递层提交每个稳定 occurrence 一次。长时间离线后的过期条目保留在提醒列表中，不批量推送；需要用户再次发送时视为一个新的明确投递动作。
- 系统时间向后跳时不得缩短冷却；暂停后台模型任务并报告 `BACKGROUND_CLOCK_REGRESSION`，待时间恢复或用户处理。向前跳按过期规则计算，不回补爆发。

`ENGINEERING_DEFAULT`：普通短时定时误差允许 5 分钟到期宽限；超过宽限的普通提醒只显示“已错过”，不主动补推。实现中可将这个值作为可见设置；不得把宽限期等同缓存 TTL 或自主冷却。

调度器使用一个定时唤醒源计算最近到期任务，并在配置变更、新消息、新缓存观测时重新排期。允许用短 `setTimeout` 或一个低频轮询，测试必须可注入时钟；不能创建一个任务一个常驻进程。

## 10. 整轮预算和未知费用必须怎么扣

### 10.1 所有收费路径共享同一 run

同一次自主活动的首次回复、工具结果后的继续回答、分页后的继续回答、网络重试、429 重试、输出前重试、外部生图／语音／付费搜索，都必须携带同一 `background_run_id`，消耗同一预算。不能换 purpose、换 task 或另建 run 获得新额度。

由本次背景执行触发的 `pre_rotate_review` 等宿主模型请求也必须携带同一 `background_run_id`，计入这次自主活动的请求数、输出、时长及费用预算。`purpose` 只用于分类，不能改变预算归属。若换窗正在等待用户手选原文，停止背景执行，不另起一个不受背景预算约束的评审调用。

在 driver 每次实际调用 transport 之前，执行异步准入：

```text
读取最新开关和取消状态
→ 检查聊天优先、窗口身份和截止时间
→ 检查请求数、工具数、总输出与日预算
→ 在 SQLite 事务中写 dispatch 预占并递增计数
→ 事务提交后才允许 transport / 外部动作开始
→ 返回后逐笔结算；未知结果保留预占
```

现有 driver 内部的重试必须调用该准入回调。只在 `runOrToolLoop` 外围扣一次，无法覆盖 driver 内的重试，属于验收失败。

### 10.2 预占必须是可信上界

- 请求前按当前型号、输出上限和计费方式计算保守费用上界；现有 `estimate_chars_per_token=2.5` 表示粗估每 token 约 2.5 个字符，不能把这个粗估值当严格美元上界。
- 缓存可能没命中，模型预算必须覆盖相应的不命中／1h 写入费用。不能只按缓存命中单价预占。
- 输入计数没有可信上界时，允许使用已验证模型上下文容量作为保守上界；若型号容量、价格或费用构成无法核验，返回 `BUDGET_ESTIMATE_UNAVAILABLE`，不开后台收费请求。
- reasoning 输出计入总输出和费用；没有完整 usage 时保持未核实，不释放可疑预占。
- 外部收费工具必须由适配器提供本次最大可能费用或明确固定价；未提供则 `PAID_TOOL_COST_UNKNOWN`。不能由模型在参数里自行声称“免费”。
- 预占与总日余额检查在一个事务内完成。给工具结果续答留出的额度也来自同一整轮，不是新额度。
- 被预算阻止的动作不发送。运行已产生费用而实际回报超出预估时，记录超限事实并停止后续动作，不能把超出部分截断、隐藏或改成零。

每日预算分别统计自主与保温。费用信息缺失时，界面显示“已知费用 + 仍占用的未核实额度”；不能以已知费用冒充当日总费用。

### 10.3 未知动作不自动重放

模型纯请求失败可在剩余预算内依 driver 原有规则重试，但每次尝试独立预占。外部写入或收费工具如果可能已被服务接受，必须先按稳定 operation ID 查询；适配器不支持查询或幂等时，终止为 `unknown` 并交界面提示处理，不能调用第二次来“确认成功”。

关闭功能、用户聊天抢占和进程重启都不能清零未知费用或滚动冷却记录。读取状态、接收回调和结算已经产生的费用不等于重新开启自主活动。

## 11. HTTP 与工具接口

沿用现有认证、Origin 检查和房间主体权限。下列为本轮新增的具体接口；请求正文不接受任意 shell、任意后端 URL、任意身份或模型密钥。

| 方法与路径 | 行为 |
|---|---|
| `GET /api/v1/background/settings` | 返回三开关、各预算、有效状态、阻断原因、设置 revision；不返回密钥 |
| `PUT /api/v1/background/settings` | 原子修改允许字段；`If-Match` 防覆盖，`Idempotency-Key` 防重复执行；关闭立即取消相关后续步骤 |
| `GET /api/v1/background/tasks?conversation_id=...` | 分页列出可见任务、计划时间与实际下次时间 |
| `POST /api/v1/background/tasks` | 创建提醒／自主任务；必须提供 `Idempotency-Key`；保温系统任务不允许任意复制 |
| `PUT /api/v1/background/tasks/:id` | 修改时间、内容引用或任务开关；使用 `If-Match` 与 `Idempotency-Key` |
| `DELETE /api/v1/background/tasks/:id` | 使用 `If-Match` 与 `Idempotency-Key` 取消任务及未来领取；不删除已发生执行／费用记录 |
| `GET /api/v1/background/runs?conversation_id=...` | 分页列出脱敏运行状态、用量、已知／未知费用与结果码 |
| `POST /api/v1/background/runs/:id/stop` | 使用 `Idempotency-Key` 停止一次执行，沿用上文取消语义；不隐式关闭总开关 |

所有修改接口使用 `Idempotency-Key` 请求头；PUT／DELETE 另使用 `If-Match` 请求头，不再从 HTTP body 读取 `expected_revision`。返回资源 `revision` 及适用的 `effective_enabled/effective_due_at`，并通过 ETag 表示可用于后续 `If-Match` 的版本。条件版本冲突、幂等键冲突的 HTTP 状态与错误码沿用本包统一 HTTP 合同；未配置预算等返回 `422`，无权限按原有认证语义处理。

重放顺序必须固定：先认证及检查当前请求对目标资源的权限，再以主体、方法、资源和 `Idempotency-Key` 查找合法回执。相同键、相同业务载荷的已完成请求返回原回执，不因当前资源 revision 已增加而误拒绝；相同键对应不同业务载荷必须拒绝。只有没有可重放回执的新操作，才继续检查 `If-Match` 并执行事务。回执是先前操作的结果，不冒充资源的当前状态；前端可刷新当前快照。不得在查幂等回执之前先用旧 `If-Match` 拒绝一次合法重试。

示例关闭请求（版本与幂等键均在请求头）：

```http
PUT /api/v1/background/settings
Content-Type: application/json
Idempotency-Key: disable-autonomous-example
If-Match: "7"
```

```json
{
  "autonomous": { "enabled": false }
}
```

示例响应须能表达正在收口，而不假装已经撤回外部动作：

```json
{
  "revision": 8,
  "autonomous": { "enabled": false, "effective_enabled": false },
  "cancellation": {
    "requested_run_ids": ["bgr_example"],
    "pending_external_results": 1
  }
}
```

聊天中设置闹钟复用任务服务：主模型调用有限的 `background_task_create`／`background_task_update`／`background_task_list`，宿主填写真实 actor 与 conversation。业务工具保留 `idempotency_key`，更新／取消工具另有 `expected_revision`；适配器将它们映射到 HTTP `Idempotency-Key`／`If-Match` 或直接调用同一幂等与条件更新服务，不平行实现两套检查。工具调用同样先鉴权、查合法重放回执，再检查新操作的 revision。一次聊天可以提出或设置一个任务；“说已经设好了”只有在任务保存成功后才成立。工具不能设置超出允许字段的总预算，也不能绕过用户总开关。

前端无需做复杂调度控制台：设置中三开关、预算字段；任务列表中的时间／启停；运行记录中的状态／停止。用户看不见的工程诊断不能代替必要的可见开关。

## 12. SDK 与 API 的压缩边界

### 12.1 当前真实差异

- **OR 直接 API**：`runtime.provider=openrouter` 走独立 fetch，不加载 Claude Agent SDK。因此 CC 客户端中的 `tengu_sunny_locket` 分支不会在这条 est 请求链里执行。前提是实际运行配置确实选择 OR；仓库默认值不能代表用户 Mac 的运行状态。
- **SDK + API key**：仍经过 SDK。`build-options.ts:60-65` 会透传 Anthropic 凭据与端点，使用 API key 本身并不能证明已经绕过 CC／SDK 的机制。
- **当前 SDK 实现**：只关闭自动记忆、Claude.ai 连接器、模型 flag 切换；没有压缩禁用参数、PreCompact／PostCompact 接线或等价恢复门。依赖声明锁定 `0.3.283`，但不能据此证明服务器当前开关状态。
- SDK 的 system 事件现仅泛化记录，`supervisor.ts:1730-1751` 对模型拒绝回退特殊处理，没有 compact 的专项处理；`rotateIfNeeded` 对非 OR/DS 驱动在 `supervisor.ts:730-731` 提前返回。

### 12.2 本轮实现裁定

1. 先完成 OR 直接调用路径的 1h／50m／60m 合同。不能为了使用 MCP，把已经隔离好的 OR 调用重新套进 SDK；MCP 工具接入与模型驱动是不同层。
2. 50 分钟保温第一版只对已经验证支持 1h 缓存的 OR Anthropic 路径开放。DS 自动缓存不显示固定 1h，不擅用同一 TTL 计时保证。
3. 自主执行可复用已通过上述预算及上下文门的 OR/DS 信封驱动；SDK 背景执行先标 `SDK_BACKGROUND_POLICY_UNVERIFIED` 并阻断。保留已有 SDK 手动聊天入口和其真实状态，不冒充同等验收通过。
4. SDK 模式的记录面不得无条件显示 `requestedTtl=1h`；显示 SDK 实际请求能力或 `unknown`。
5. 若后续要启用 SDK 背景活动，须针对真实安装版本核对公开支持的自动压缩设置、事件／hooks 及会话恢复方式；在 idle／上下文压缩实际发生的回归中证明不会接管原文与开窗策略，然后单独解除能力阻断。
6. 不把 `tengu_sunny_locket` 写进生产配置、环境变量或 feature-flag 代理。它不是此项目可依赖的公开控制接口，不能反向推测“默认 off／账号已开”作为验收证据。
7. OpenRouter 账户／组织层若使用插件的 Prevent overrides 强制覆盖客户端请求，必须核实最终有效配置。存在强制压缩与本地禁压缩冲突时显示 `UPSTREAM_COMPACTION_POLICY_CONFLICT`，不认为本地 `enabled:false` 必然胜出，也不擅自修改上游账户设置。

这项能力阻断只限制未验证的后台路径，不应阻止无模型提醒、查看已有聊天、查看媒体或关闭开关。

## 13. 观测与告警输出

复用全局系统告警机制。后台模块只发结构化 `code + run/task ref + severity + observed_at`，不建立第二个告警数据库，也不把模型输出或个人正文写入日志。

至少提供以下结果码：

| code | 展示含义 |
|---|---|
| `AUTONOMOUS_DISABLED` | 自动唤醒关闭，未开始后续自主调用 |
| `USER_CHAT_PREEMPTED` | 后台活动已让出给用户聊天 |
| `AUTONOMOUS_COOLDOWN` | 尚未达到 60 分钟，显示合法下次时间 |
| `CONTEXT_SELECTION_REQUIRED` | 等待用户选择新窗原文，不自动空选 |
| `BACKGROUND_BUDGET_NOT_CONFIGURED` | 尚未配置相应用途费用上限 |
| `BACKGROUND_BUDGET_EXHAUSTED` | 本轮或当日预算耗尽，后续未发送 |
| `BACKGROUND_OUTCOME_UNKNOWN` | 已发操作结果待核实，费用预占保留 |
| `KEEPWARM_CACHE_ALREADY_COLD` | 缓存估计已冷，未付费补写 |
| `KEEPWARM_CACHE_EVIDENCE_UNKNOWN` | 没有足够缓存观测，未宣称命中 |
| `KEEPWARM_MODEL_PARAMETERS_UNSUPPORTED` | 当前型号不支持维护请求的已设额度组合 |
| `SDK_BACKGROUND_POLICY_UNVERIFIED` | SDK 的后台上下文规则尚未验证 |
| `UPSTREAM_COMPACTION_POLICY_CONFLICT` | 上游强制规则与用户禁压缩要求冲突 |

普通 no-op 和用户主动关闭不是错误告警；运行记录可见即可。权限失败、未知收费结果、持久原文异常等按系统告警规则处理，不能被普通提醒开关或后台总开关一起隐藏。

## 14. GLM 分步施工顺序

1. **固定基准与保留行为**：确认当前 HEAD、工作区和 AGENTS；标明相对基准已变化的文件。读取真实配置结构，不能把旧 v0.2.1 source 副本当现状。
2. **设置与数据迁移**：新增三开关、预算字段、统一生效视图和任务／执行／派发账本；先不启动后台付费任务。
3. **派发前门**：在 OR/DS driver 的每个 transport 尝试前接异步准入；补开始时间，保证所有重试都计数。先完成取消、费用未知、用量结算，不先放出定时循环。
4. **supervisor 后台入口**：复用房间互斥、身份／窗口／路由门、工具循环、正式消息发布与取消 fence，增加聊天抢占和规范轨迹保护。
5. **保温支路**：实现 1 次请求、0 工具、50 分钟观测重排与不污染原文／轨迹；TTL 保持 1h。
6. **自主与提醒调度**：实现 60 分钟主体冷却、任务 CRUD、no-op、普通提醒无模型投递、重启不补跑。
7. **前端与记录面**：接三开关、预算、实际下次执行时间、单次停止与费用未知展示；纠正 SDK 假 1h 显示。
8. **离线验证与提交证据**：按下一节做有限、有意义的行为验证。关闭所有新后台付费功能交付，保留创建提醒正常可用。

不要求 GLM 在执行本文件时调用真实主模型、启用外部收费工具或修改网络／凭据／供应商账户。代码与离线验收完成后，报告明确列出尚待用户启用和真实供应商验收的项目。

## 15. 必须通过的行为验收

使用独立临时 `ESTOMAGO_HOME`、虚拟时钟和可控 transport；遵守仓库串行测试纪律。不得为这些测试连接真实模型、发送真实消息或执行真实收费工具。

| 编号 | 场景 | 必须观察到的结果 |
|---|---|---|
| CW-01 | 首次安装／升级 | 自动唤醒和保温 false；美元预算 null；没有后台模型请求；已启用的普通提醒可投递 |
| CW-02 | 开启自动唤醒但未填预算 | 422，开关未有效开启，无请求 |
| CW-03 | 10:00 缓存观测，10:35 新缓存观测 | 10:50 不发；合法目标移动到 11:25 |
| CW-04 | 200 回复但无 cache usage；网络失败；429 | 不假定缓存刷新；每次实际尝试均入派发账本 |
| CW-05 | 普通聊天与保温同时到期 | 用户聊天优先；新观测可消掉维护机会，无重复发送 |
| CW-06 | 自主任务 10:59 开始，第二个任务 11:01 到期 | 第二轮不开始；不能按钟表小时分桶绕过冷却 |
| CW-07 | 创建多个任务／换房间／修改 ID | 同一主体仍只有统一 60 分钟冷却 |
| CW-08 | 一轮里多次工具续答、transport 重试及多工具批次 | 共用 run，所有尝试／工具分别计数，不刷新整轮额度 |
| CW-09 | 自主活动中关闭总开关 | 新 transport、重试、下一工具、迟到公开文本均停止；已发操作如实结算 |
| CW-10 | 已收费外部请求超时后关闭／重启 | unknown 保留预占；不重放收费动作；可做不收费的状态核实 |
| CW-11 | 用户消息到达时后台正在运行 | 即时发取消信号，后续步骤停止，聊天在原有取消宽限内获得执行位 |
| CW-12 | 模型明确 noop 或无公开输出正常结束 | 正常 noop，一次结束，不重试、不强制 hold／发消息 |
| CW-13 | 保温返回 tool_calls | 0 工具执行；没有第二轮模型续答 |
| CW-14 | 保温成功后继续正常聊天 | 历史前缀校验通过；维护尾消息不在正式原文／选集／规范轨迹中 |
| CW-15 | 后台达到 64k，需要手选原文 | 不自动压缩、不自动空选；没有继续付费活动；用户可以确认 0 选 |
| CW-16 | 午夜／静默／缓存到期 | 不因此换窗或删原文，旧窗口及未 hold 原文保持可读 |
| CW-17 | 模式开关组合：auto off、keepwarm on、reminder on | 只禁止自主；维护与无模型提醒各自按规则运行 |
| CW-18 | 暂停数小时后重启 | 无积欠自主／保温爆发；普通过期提醒不批量补推；已发送动作不重复 |
| CW-19 | OR／DS／SDK 切换 | OR 不加载 SDK；DS 不假报 1h；SDK 背景路径阻断并显示未验证 |
| CW-20 | OpenRouter 上游强制压缩与本地禁压缩冲突 | 不能报策略已满足；明确冲突并阻止受影响后台执行 |
| CW-21 | 两个回调同时领取相同 occurrence | 唯一约束只允许一条执行，只有一次派发 |
| CW-22 | 日预算边界及跨午夜 usage 返回 | 预占不重复释放／迁移；未知成本不补零；后续超预算请求不发送 |
| CW-23 | 设置并发修改、关闭返回后旧闭包恢复 | 修订冲突明确；旧闭包不能继续以旧 enabled=true 运行 |
| CW-24 | 关闭普通提醒投递并存在系统错误 | 提醒按开关处理；故障红点和未核实费用仍可见 |
| CW-25 | 背景活动触发一次 `pre_rotate_review`，随后一次自主请求；整轮请求上限设为 2 | 两次请求携带同一 run、合计计数为 2，下一次被预算门阻止；等待人工选集时不另开无预算评审 |

测试证据报告必须列出实际用到的 driver、虚拟时钟推进、派发总数、公开消息总数、轨迹是否变化、已知／未知费用数量。不要用自填 PASS、仅截图按钮状态或仅断言配置值替代行为证据。

## 16. 官方资料与引用边界

以下链接由本轮资料核对提供，核验日期为 2026-10-11。公开文档是接口语义依据，不能代替用户 Mac 上的实际配置、已安装 SDK 版本、供应商响应或账户强制设置的验收。

- [Claude API Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：缓存 TTL、读写用量与前缀复用的公开说明。
- [OpenRouter Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)：OR 的 provider 缓存参数和观察方式。
- [OpenRouter Plugins overview](https://openrouter.ai/docs/guides/features/plugins/overview)：插件控制与账户规则；实现需关注 Prevent overrides 与请求内关闭发生冲突的情形。
- [Claude Agent SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)：SDK 自身执行循环与上下文管理边界。
- [Claude Code Prompt caching](https://code.claude.com/docs/en/prompt-caching)：CC 缓存行为；不能据此断言 est 的独立 OR driver 同样经过 CC。
- [Claude Code Environment variables](https://code.claude.com/docs/en/env-vars)：只考虑公开、适用于已安装版本的控制；内部 flag 不能作为部署接口。
- [Claude API compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)：API 压缩相关控制需要显式核对，不与 prompt caching 混为一谈。
- [anthropics/claude-code issue #98747](https://github.com/anthropics/claude-code/issues/98747)：关于观察到的行为的补充线索；issue 不是稳定 API 合同，也不能证明某账号当前 flag 已开启或关闭。

本轮源码引用可从[固定提交的仓库树](https://github.com/Asccccyn/estomago/tree/4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1)进入。若实际实施 HEAD 已变化，GLM 必须按文件与行为重新定位，并在交付报告写明新提交，不可把本文旧行号继续当作新代码已核实的证据。
