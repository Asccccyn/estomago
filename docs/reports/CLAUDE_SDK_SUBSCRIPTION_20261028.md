# estómago Claude Agent SDK 接入验收

本轮完成候选代码和隔离验收，**没有部署或启用正式订阅入口**。生产目录、生产配置、聊天数据库、Claude 登录态和 VPS 代理均未修改。Mac 官方运行时的只读认证检查返回 `loggedIn: false`、`authMethod: none`；正式订阅请求、真实额度事件和真实缓存命中仍待登录后验收。

基线为 `52c7dcb44abd9390ff2ca6317ab647cad18261d4`，取自现行整合工作树；候选分支为 `sdk-subscription-integration`。实际安装并保持不变的是 `@anthropic-ai/claude-agent-sdk 0.3.283`，随包官方运行时 `Claude Code 2.1.283`。已比较候选和既有发布目录中的官方二进制，字节一致。MCP SDK 已有的 peer 包 `1.30.1` 被显式列为依赖，锁文件经 npm 重新生成，没有升级 Claude SDK。

实现提交：`1f667b9`。本报告和 README 索引另行记录，不改变运行代码。

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

本机发现现有代理监听 `127.0.0.1:1082`，历史网络记录指向既有家宽链路。**没有修改该代理、VPS、防火墙、隧道或全局网络设置。** 当前 Mac 锁屏，无法核验代理界面里的实时路由及故障策略，尚未确认“实际出口只能是家宽 IP”。

候选通过官方 `spawnClaudeCodeProcess` 扩展点为官方运行时附加 macOS 网络限制：只允许指定回环代理端口，不设直连后备。真实本机测试确认：代理端口可连接；其他 TCP、IPv6、UDP 目标被内核拒绝；代理端口关闭后返回连接拒绝，其他路径仍被拒绝，旁路服务器收到零连接。

这是对 **SDK 子进程** 的已测限制，不是整台 Mac、浏览器或用户手动启动的其他进程的全局保证。既有代理自身是否允许 DIRECT、DNS/IPv6 是否走家宽、浏览器登录出口及断线行为，仍须解锁后按现有代理配置核验。核验前不启用正式 SDK。参考仓库中的多节点自动切换和 CLIProxyAPI 没有采用。

生产配置当前仍为 OR，SDK 版本与型号字段未配置，认证确认标志为 false。登录后还需要用官方运行时确认可用型号、对应上下文容量与额外付费状态，再填写这几个配置项并做小规模合成订阅请求。不会导出 VPS token，也不会用 API key 冒充订阅登录。

## 验证与回滚

- 主机与 React 类型检查通过；前端按现有 `npm run build:web` 重建，生成文件未手改。锁屏期间未做浏览器视觉验收。
- 单元首跑 170/174 文件通过；本次变更关联的三个旧夹具/断言更新后，相关六个文件定向复跑全部通过。
- 剩余 `envelope-golden-baseline.test.ts` 在未修改的 `52c7dcb` 上同样失败：语音拒接描述已改，而旧 golden 仍要求解释拒接理由。本轮未改业务行为或重生成无关 golden。
- 合同回归 3/3 文件通过；集成回归 24/24 文件通过，含 SDK 网络隔离。
- 新增额度、真实工具副作用、流中断与用量测试共 15 项通过；最新 SDK 合同两项也通过。
- 原始 SDK 请求验收 26 笔、18 场景通过。真实订阅授权、真实限额事件、实际家宽出口和物理缓存命中没有通过声明。

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

仍未完成：正式登录及账户额外付费核验、家宽唯一出口实测、真实额度耗尽/恢复、真实缓存/长时间保温、真实外部业务服务及 SDK 媒体透传验收。新 SDK 文本接入没有宣称解决既有图片输入限制。

## 参考与适用边界

- [sibylsea-hub/cc-codex-sdk-modify-preset](https://github.com/sibylsea-hub/cc-codex-sdk-modify-preset)：已读 README、给人看的教程、给机看的教程；只作实现参考，没有加入依赖。它的 0.3.234 锚点以本机 0.3.283 类型定义和抓包结果校正。
- 用户提供的《扒 system prompt.docx》：采用回环假 API 抓取请求的思路，重新实现为独立 Node 进程，并扩大到多轮、原执行器及后台场景。
- [官方提示词文档](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)：区分 custom、preset、minimal default 和 system 外部提醒；以实际捕获为最终证据。
- [nevertoday/xiaoxiaodong-vps 方案说明](https://github.com/nevertoday/xiaoxiaodong-vps/blob/main/skills/xiaoxiaodong-vps/references/design.md)及其 WebRTC 手册：借鉴 AI 规则优先、DNS 出口及 IPv4/IPv6/UDP 分开验收的方法；没有执行其部署脚本或迁移现有线路。
