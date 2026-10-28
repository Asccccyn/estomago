# estómago Claude Agent SDK 接入验收

本轮完成候选代码和隔离验收，**没有部署或启用正式订阅入口**。生产目录、生产配置、聊天数据库和 VPS 代理均未修改。解锁后补验了当前家宽 HTTP 出口与设置页，用户已完成官方本机登录。一笔独立 SDK 合成短消息已成功，服务端确认使用订阅额度且未用额外付费；完整宿主的自动准入、真实工具续轮及缓存等验收尚未完成。新增模型请求已停止。

基线为 `52c7dcb44abd9390ff2ca6317ab647cad18261d4`，取自现行整合工作树；候选分支为 `sdk-subscription-integration`。实际安装并保持不变的是 `@anthropic-ai/claude-agent-sdk 0.3.283`，随包官方运行时 `Claude Code 2.1.283`。已比较候选和既有发布目录中的官方二进制，字节一致。MCP SDK 已有的 peer 包 `1.30.1` 被显式列为依赖，锁文件经 npm 重新生成，没有升级 Claude SDK。

实现提交：`1f667b9`；按实际官方账户元数据修正准入为 `13ff61e`；删除套餐名称硬匹配为 `d9b5d33`。本报告和 README 索引另行记录。

## 2026-10-28 后续专项修复

候选在原审计基线 `1f3f79d` 上继续修复，未升级 SDK、未部署、未改生产配置：

- F01 `b73ef06`：容量与记录共享单请求输入观测，按 source 归一化缓存分项；未知仍未知，回合/会话累计不冒充当前上下文。
- F02 `5377849`、记录面补齐 `7cbd8db`：实际入口、请求型号、上游响应型号与 provider 记录到既有 provider_requests，聊天、自醒、评审及记录面共同消费。
- F03 `138bb44`：累计估值及 modelUsage/costBasis 保存在既有 cumulative/raw 观测；不重复 token、不加入实际收费汇总，resume/fork 的范围关联可查询。
- `778067b`：完整隔离 Host 经过真实 HTTP 登录、消息接纳、准入与持久化，核对冷重启、角色/更正记录、已完成工具回执、人工选集。外部 SDK 回答为合成，不能证明真实模型理解。

最终相关单元 15 文件/127 项与集成 4 文件/11 项通过，主机类型检查通过；原生 SDK 本机假 API 基础抓包 26 笔、扩展抓包 20 笔。后者含真实 Siren HttpCoreBridge、主动发布、记忆投影、纯心跳、取消/超时与普通 429；均无真实模型或外部业务服务效果。

10:35 PDT 使用同一锁定 SDK、正式环境白名单及既有本机代理只读查询官方控制接口：firstParty、无 apiKeySource，usage 仍为 rate_limits_available=true / rate_limits=null。输入生成器没有 yield，persistSession=false，会话费用 0、model_usage 为空；准入仍是 SDK_EXTRA_USAGE_UNVERIFIED。没有放宽准入、建立人工永久放行或用 API key 冒充订阅。正式入口、真实冷重建理解、真实额度恢复和物理 1h 缓存仍未通过供应商验收。

## 2026-10-28 16:25 PDT 部署

用户批准后，将代码 `3d510f6` 部署到 `~/Projects/estomago-releases/sdk-integration-20261028-3d510f6`。沿用原 LaunchAgent 和启动脚本，仅修改 cd 发布目录；旧发布目录保留。原备份脚本保存数据库、配置、认证元数据及媒体，原启动脚本/plist另存 `~/Backups/pre-estomago-sdk-20261028-3d510f6`。

生产ready/live均200。新进程实际位于新目录，275个运行文件与资产匹配候选，网页脚本散列匹配。消息数/序号735、模型请求442、当前窗、schema50及配置散列均未变化，自醒和心跳开关仍false。未发送模型测试消息。

本次上线保留 configured/OpenRouter。SDK模型/版本/认证确认/代理字段未擅自填入，订阅SDK未启用。16:21 PDT官方控制接口重新核对仍返回rate_limits=null、额外付费状态未知，SDK_EXTRA_USAGE_UNVERIFIED仍成立；该控制查询无yield输入、不保存会话，费用0、model_usage为空。需要继续解决B01并完成正式入口验收，不能把代码部署写成SDK已经可聊天。

## 接入变化

est 仍负责身份与 I、Mariposa、消息与协议账本、窗口、后台调度、权限及业务执行。正式 SDK 调用采用官方 `query()`；SDK MCP 只映射现有窗口冻结的工具定义，并调用现有 `ModelToolBridge`（此前的 HostToolExecutor）。没有第二个业务服务，也没有手写 `claude -p` 模型通道。

SDK 原生工具循环与既有 OR 循环各自执行一次。SDK 的工具事件不会再落入 OR 的手工执行循环。换窗检查保留“同批其他业务工具完成后，最后确认检查”的顺序：经官方 `PostToolBatch` 执行原检查器，未确认前只回报 pending，不伪造完成回执。

新增接入策略 `subscription-first`，设置页入口为“更多 → 模型接入”。它显示策略、最近实际入口、下一安全回合入口、最近错误及订阅重置状态。设置变更通过既有 `runtime_settings` 持久化，在会话串行链取得执行位时生效，不改变进行中的回合。

SDK 子进程使用替换式环境白名单。OR/API key、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、第三方供应商设置和外部 OAuth token 不继承。正式认证只读取官方本机登录；每笔模型请求前，经官方 `accountInfo()` 和本版的实验性 usage 接口检查订阅身份及 `extra_usage.is_enabled === false`。缺少证据或额外付费已启用即阻断；运行中观察到 `isUsingOverage` / `overageInUse` 也会停止。

`permissionMode` 为 `default`，仅对已注册的 SDK est 工具由本地权限回调许可；不启用 auto 审核、bypassPermissions 或工程命令免审列表。业务权限继续由原执行器核验。内置工具通过 `tools: []` 真正移除；同时显式清空 settings sources、skills、plugins，启用严格 MCP 配置并关闭自动记忆与额外连接器。

## 请求证据

测试器是 [scripts/probe-claude-sdk.mjs](../../scripts/probe-claude-sdk.mjs)。父进程创建独立子进程、临时 HOME/Claude 配置目录/ESTOMAGO_HOME；假 API 仅监听 `127.0.0.1`，不转发，不保存请求头，仅使用虚构凭据、合成身份与聊天。真实身份正文没有被送进假 API。

最终运行采集 **26 笔真实 SDK 发出的请求，覆盖 18 个场景**。其中模型回答与用量由假服务器合成，不能作为真实模型能力、订阅认证、缓存命中或费用证据。另向临时目录放入带标记的 CLAUDE.md、技能及额外 MCP 配置，并向测试父进程放入虚构 OR/auth 凭据；这些标记均未出现在请求中。

完整的 system、tools 定义、messages、缓存标记和事件保存在本任务仓库之外：

- [合成原始请求](../../../outputs/sdk-capture-synthetic/requests.json)
- [合成事件](../../../outputs/sdk-capture-synthetic/events.json)
- [场景摘要](../../../outputs/sdk-capture-synthetic/summary.json)
- [版本与证据索引](../../../outputs/sdk-evidence-summary.json)

原始请求 SHA-256：`916ae8f81dcb7a3e403f195a5aa3066d533b89ee1856a247e5981cab6760b23f`。这些原始日志不加入 Git。

### 四种提示词模式

以下四项使用相同的空内置工具目录、空设置来源和隔离环境。长度是 JavaScript string length，不是 token 数或账单。

| 模式 | 实际 system 各块长度 | 实际 tools | 观察 |
|---|---|---|---|
| preset | 73 / 62 / 13511 | 空 | 保留 CC 编程预设 |
| append | 73 / 94 / 13540 | 空 | 保留编程预设并追加标记；身份块也不同 |
| custom persona | 73 / 62 / 111 | 空 | 第三块完整替换成合成人格；没有编程预设 |
| 未指定 systemPrompt | 73 / 62 | 空 | 仍存在计费头与 SDK 身份标识，不是没有 system |

四种模式的首个 user 消息都带运行时提醒。正式候选组合配置去掉了部分附加内容，但本版订阅兼容配置仍保留环境、型号/知识截止日期、当前日期提醒，原始用户正文位于独立文本块中。因此“原文未被改写”已验证，**“messages 完全没有无关运行时信息”没有达标**。

补做的官方 bare 模式对比仅留下日期提醒，但不能用于本架构：官方文档说明 bare 不读取 OAuth 登录或系统钥匙串。该模式只用于独立实验，未加入正式配置。[官方 bare 说明](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

### est 正式装配代码的合成验收

完整宿主测试走实际 `TurnSupervisor`、身份材料装配、窗口工具快照、ModelToolBridge、任务服务和后台调度器；数据替身全部为合成。没有用模型自述判断剥离或工具成功。

| 位置 | 实际结构与来源 | 分类 |
|---|---|---|
| system 自定义块 | est 已批准身份/I/规则的合成替身、既有宿主业务与权限规则 | 业务必需 |
| system 前两块 | SDK 计费头、SDK 身份标识；本轮保留官方运行时，没有改二进制移除 | SDK 运行时必需（本版保留层） |
| CC 编程预设 | custom 请求中不存在 | 已剥离 |
| tools | `mcp__est__tool_catalog`、`mcp__est__tool_define`、`mcp__est__tool_invoke`；JSON Schema 沿用当前 deferred 工具协议 | 业务必需 |
| Bash / Read / Edit 等 | 不在请求工具目录中 | 已剥离 |
| CLAUDE.md / skills / 额外 MCP | 隔离目录中的污染标记未进入请求，目录只含 est 工具 | 已剥离 |
| messages 的 host 数据 | est 时间、记忆、选集或账本重建历史，保持与用户正文区分 | 业务必需 |
| messages 的环境/型号/日期提醒 | 本版订阅兼容配置仍由 runtime 注入；未找到兼容官方登录且经验证的完整移除方式 | 尚未确认／未剥离 |
| metadata.user_id | SDK 生成的设备/会话元数据，在 metadata 层，不是用户正文 | SDK 运行时必需（本版保留层） |
| OR 密钥、地址、供应商配置 | 未进入 SDK 子进程白名单或采集的请求 | 已剥离 |

普通续聊、三步工具发现/执行及后续模型请求、native resume、宿主重启后的账本重建、窗口切换、合成自动唤醒和心跳均取得请求。实际副作用测试经原执行器建立一条合成预约；SDK 未重复执行它。额外同批换窗检查测试观察到执行顺序为 `wake_manage → context_review_complete`，检查正本确实变为 completed，没有多发下一笔模型请求。

## 额度与缓存

只有本版 `rate_limit_event` 中 `status: rejected` 且明确属于订阅桶才允许自动 OR：`five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`、`seven_day_overage_included`。`overage`、缺失桶、allowed、allowed_warning、网络错误、普通 429 和服务错误均不授权回退。`resetsAt` 按 Unix 秒转成时间，不把 usage 接口的 ISO 时间或额外付费重置时间混进来。

回退的隔离测试覆盖：无输出的订阅拒绝才派发 OR；有部分正文或真实本地工具副作用后不整轮重发；断流在完整 assistant 包之前也保留已输出正文；重置前后选择正确入口。额度恢复后的下一安全回合重建当前 est 历史，不恢复 OR 已推进之前的旧 SDK session。额度事件是在 SDK 外部边界合成注入的，**不代表发生过真实订阅耗尽**。

同窗测试中，system 和 tools 的完整散列在续聊、工具续轮、resume、自醒和心跳间保持一致。使用当前安装包公开的 `settings.promptCacheTtl: '1h'`，请求中实际出现 `ttl: '1h'`。宿主继续使用既有保温调度；纯 `1` 维护回执不入聊天或主轨迹，官方 `forkSession` 保持原聊天 session 不变。

SDK stream 用量按每笔请求写入既有用量账本，忽略重复的整轮累计 result usage；nullable 缓存计数保留 unknown。四笔工具请求对应四条 request 观测，没有重复计费计数。这里的计数来自合成服务器，仅证明解析与记账，不证明真实缓存读取或真实费用。

冷重建会改变 SDK 计费头的短后缀；runtime 日期提醒也可能影响跨日期前缀。未测真实订阅的 1h 保留、跨重启命中率、账户侧缓存分区或长期保温效果。不能据此宣称缓存必命中。

## 网络与正式认证阻塞

本机现有代理监听 `127.0.0.1:1082`。解锁后核对 Shadowrocket 正在连接既有单一节点，采用全局代理；当前偏好确认 Always On、包含所有网络、UDP 转发和禁用 STUN 均开启。活动配置的主/备用 DNS 均为 `#proxy` 的 DoH，`dns-fallback-system`、`dns-direct-system`、IPv6 均为 false，不支持的 UDP 策略为 REJECT。经只允许连接该代理端口的沙箱执行 HTTPS 出口检查，返回地址与既有家宽地址一致。**没有修改该代理、VPS、防火墙、隧道或全局网络设置。**

候选通过官方 `spawnClaudeCodeProcess` 扩展点为官方运行时附加 macOS 网络限制：只允许指定回环代理端口，不设直连后备。真实本机测试确认：代理端口可连接；其他 TCP、IPv6、UDP 目标被内核拒绝；代理端口关闭后返回连接拒绝，其他路径仍被拒绝，旁路服务器收到零连接。

这是对 **SDK 子进程** 的已测限制，不是整台 Mac、浏览器或用户手动启动的其他进程的全局保证。当前连接下的 HTTP 出口已实测；DNS/IPv6 结论来自实时配置核查，未做全链路抓包，也没有主动断开用户正在使用的 VPN。参考仓库中的多节点自动切换和 CLIProxyAPI 没有采用。

用户登录后，宿主权限下的官方 `auth status --json` 已返回 `loggedIn: true`、`authMethod: claude.ai`、`apiProvider: firstParty`。受限工具沙箱不能访问系统钥匙串时会得到未登录结果，因此不能把该结果误报为用户登录失败；正式 SDK 检查在同样网络限制下使用宿主的正常钥匙串访问。

2026-10-28 07:32 PDT 的 SDK 控制接口返回 `apiProvider: firstParty`、`subscriptionType: Claude API`，未提供 tokenSource 或 apiKeySource；usage 返回 `rate_limits_available: true`，但 `subscription_type`、`rate_limits` 均为空。本次检查会话的 SDK 费用为 0、模型用量表为空；检查器从未放行模型输入。模型目录可读取不代表账户已获对应型号权限。

已只读核对当前安装运行时：正常本机 OAuth 登录会省略 tokenSource；未识别到套餐时，显示名称默认落到 `Claude API`，这个标签不是使用 API key 的证据。`13ff61e` 删除了 tokenSource 必须存在的错误前提，`d9b5d33` 进一步删除了套餐名称硬匹配，保留第一方认证、API key 来源拒绝及额外付费检查。已有 15 项额度/工具/流式单测及两项 SDK 合同测试、主机类型检查均通过。当前完整宿主仍因 usage 接口缺少额外付费数据返回 `SDK_EXTRA_USAGE_UNVERIFIED`；没有自动转交 OR。

本机官方资料缓存显示 Apple 订阅计费方式及额外付费关闭；这是账户资料证据，不能代替尚未取得的当前 usage 响应。账户检查脚本和脱敏结果位于任务输出目录，原始诊断仅经内存筛选，不保存授权码、token 或请求头。未知套餐/usage 的具体原因仍待确认，未通过修改凭据或硬编码套餐绕过。

补充对照：用户确认套餐为 Pro；官方网页侧显示 Pro 有效、使用积分关闭。08:17 PDT 在独立临时目录用官方 SDK `0.3.312`／运行时 `2.1.312` 查询同一本机登录，仍得到空套餐与空 rate_limits，模型输入未提交、会话费用 0、模型用量表为空。候选及生产依赖仍为 `0.3.283`，没有因这个对照替换版本。

公开检索发现高度相似的 [iOS App Store 套餐识别报告 #34049](https://github.com/anthropics/claude-code/issues/34049) 与 [Pro 登录成功但 subscriptionType 为空的报告 #36769](https://github.com/anthropics/claude-code/issues/36769)。这些是官方仓库中的用户报告，部分被机器人关闭，不能据此声称 Anthropic 已确认本机根因或修复。现有证据更符合 OAuth 套餐资料识别／同步异常；尚未定位具体故障端，也未找到已验证的本地修复。不能据此要求用户更换付费渠道、手填 pro、删除凭据或使用 API key。

08:41 PDT 做了一笔独立真实 SDK 请求，依据已完成的官方登录及已核对的使用积分关闭状态放行；它没有走完整宿主的自动预检，也未启用生产入口。自定义 system 为 `This is a synthetic connectivity check. Reply only with EST_SDK_OK.`，用户消息为 `Synthetic test. Reply only with EST_SDK_OK.`。实际型号 `claude-sonnet-5`，工具为空，session 不持久化；返回 `EST_SDK_OK`，成功结果，观察到两次文本增量。未提交 est 的真实身份、记忆或聊天正文。

这笔请求实际消耗订阅输入 500／输出 11 tokens。真实 `rate_limit_event` 为 `status: allowed`、`rateLimitType: five_hour`、`isUsingOverage: false`、`overageStatus: rejected`、`overageDisabledReason: org_level_disabled`。SDK 的 `costUSD: 0.00111` 标注 `costBasis: list`，属于价目表用量估值，不能当成 API 账单。缓存创建/读取均为 0；短消息不构成缓存命中验收。脱敏结果在任务输出目录 `official-subscription-message.json`。

该结果直接证明：套餐字段为空不妨碍此账号的实际 SDK 订阅调用。此前把套餐识别失败等同于不能使用 SDK 的判断过严。请求后的只读 usage 查询仍为空；完整宿主如何可靠取得额外付费状态仍须收口，不能把这笔独立诊断冒充整个正式接入已通过。已停止新增真实模型请求。

按用户要求，准备了任务输出目录中的 `登录-Claude-官方订阅.command`。它启动前再次检查家宽出口，使用替换式环境和本机代理网络限制，再执行未修改的官方运行时 `auth login --claudeai`；用户在终端打开官方链接并手动输入授权码。没有把授权码、token 或真实认证请求写入抓包日志。

生产配置当前仍为 OR，SDK 版本与型号字段未配置，认证确认标志为 false。登录后还需要用官方运行时确认可用型号、对应上下文容量与额外付费状态，再填写这几个配置项并做小规模合成订阅请求。不会导出 VPS token，也不会用 API key 冒充订阅登录。

## 验证与回滚

- 主机与 React 类型检查通过；前端按现有 `npm run build:web` 重建，生成文件未手改。解锁后在独立临时数据目录启动候选实例，实际完成登录、打开“更多 → 模型接入”、保存订阅优先策略及刷新复核；状态与阻塞提示显示正常。该实例未发送模型请求，验收后已停止。
- 单元首跑 170/174 文件通过；本次变更关联的三个旧夹具/断言更新后，相关六个文件定向复跑全部通过。
- 剩余 `envelope-golden-baseline.test.ts` 在未修改的 `52c7dcb` 上同样失败：语音拒接描述已改，而旧 golden 仍要求解释拒接理由。本轮未改业务行为或重生成无关 golden。
- 合同回归 3/3 文件通过；集成回归 24/24 文件通过，含 SDK 网络隔离。
- 新增额度、真实工具副作用、流中断与用量测试共 15 项通过；最新 SDK 合同两项也通过。
- 原始 SDK 请求验收 26 笔、18 场景通过。当前 HTTP 家宽出口已补验；真实订阅授权、真实限额事件和物理缓存命中没有通过声明。

复跑（在候选仓库根目录）：

```sh
npm run typecheck
npm run typecheck:web
ESTOMAGO_HOME=/tmp/est-sdk-check ESTOMAGO_TEST_MODE=1 npm test -- --file=tests/unit/sdk-subscription-access.test.ts --file=tests/contract/aud-01-sdk-options-contract.test.ts
ESTOMAGO_HOME=/tmp/est-sdk-check ESTOMAGO_TEST_MODE=1 npm test -- --file=tests/integration/sdk-network-isolation.test.ts
node scripts/probe-claude-sdk.mjs
```

网络隔离测试需要 macOS 允许启动本机监听和 sandbox-exec；遇到权限拒绝应记录环境失败，不算业务测试通过。抓包脚本会打印新的临时证据目录。

本轮没有数据库 schema 迁移。当前未部署，因此生产无须回滚。若之后试用候选版本，需要退回时：在安全回合边界恢复 `access_policy: configured`，回到既有 OR；必要时停止候选实例并把启动目录指回原发布版本。保留聊天数据库和工具副作用账本，不恢复旧数据库快照，不重放已执行回合。代码可在干净基线应用或反向应用随交付提供的补丁；不要覆盖别人的未提交修改。

仍未完成：官方 usage 套餐/额度与额外付费的实时核验、全链路断线/DNS 抓包、真实额度耗尽/恢复、真实缓存/长时间保温、真实外部业务服务及 SDK 媒体透传验收。新 SDK 文本接入没有宣称解决既有图片输入限制。

## 参考与适用边界

- [sibylsea-hub/cc-codex-sdk-modify-preset](https://github.com/sibylsea-hub/cc-codex-sdk-modify-preset)：已读 README、给人看的教程、给机看的教程；只作实现参考，没有加入依赖。它的 0.3.234 锚点以本机 0.3.283 类型定义和抓包结果校正。
- 用户提供的《扒 system prompt.docx》：采用回环假 API 抓取请求的思路，重新实现为独立 Node 进程，并扩大到多轮、原执行器及后台场景。
- [官方提示词文档](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)：区分 custom、preset、minimal default 和 system 外部提醒；以实际捕获为最终证据。
- [nevertoday/xiaoxiaodong-vps 方案说明](https://github.com/nevertoday/xiaoxiaodong-vps/blob/main/skills/xiaoxiaodong-vps/references/design.md)及其 WebRTC 手册：借鉴 AI 规则优先、DNS 出口及 IPv4/IPv6/UDP 分开验收的方法；没有执行其部署脚本或迁移现有线路。
