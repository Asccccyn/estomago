# estómago · Mac mini 实现路径与执行规章 v0.2.1

**日期：2026-09-24。实施目标：Mac mini。本文所有路径均为拟新增或现场待核验。**

先读 `01_estomago_架构与接口_v0.2.1.md` 和 `05_estomago_SDK装配与思考流实现细则_v0.2.1.md`，再读本文和验收矩阵；04 是给周家明的独立说明。没有现场源码、命令输出和设备证据，就不能声称已经创建、已通过、已接入或已上线。路径采用 ASCII 标识 estomago，界面名称始终为 estómago。

## 1. 开始之前的边界

本包授权范围只是设计交付；实际开发需接续用户明确交付的实现任务。收到实现任务后，只在确认的 estómago 根目录新增/修改，保留已有未提交内容，不重建整个目录。

不得顺手修改 Mariposa 的规则、正式库、旧 Ombre、Siren、许愿星、扎西德勒、Antinomy、DevSpace、Cloudflare 路由或计费身份。需要外部服务变更时记录受影响接口与最小补丁，另行获得对应范围的授权。不能直接用本机数据库连接绕过外部服务 API。

不启用未被授权的 Codex CLI、递归代理或远程执行器。不因某个 root 被拒绝就换目录用 shell 绕过。测试不调用真实外发消息、真实电话、正式健康数据和私人记忆；真实烟测使用单独明确授权。

## 2. 首次 doctor：只读优先

输出 `reports/mac-doctor-<timestamp>.json`，至少包含：macOS/CPU 架构、登录用户与 HOME、项目路径 realpath、可执行文件绝对路径、Node/SDK/runtime 版本、依赖锁、剩余空间、内存、候选端口、系统/业务时区、所需目录权限、证书与网络、已有服务与监听端口。

另查认证方式是否可用、对应授权来源、是否存在继承的 API key/base URL/模型变量、全局 Claude 配置和受管策略；报告只标类型/存在性/脱敏来源，不打印 secret。不要复制 Windows 现成 node_modules、.venv 或登录 token 充当 Mac 环境。

若已有 estomago 目录，先记录 Git HEAD、工作树、文件清单、现有启动方式与数据目录，再做增量。若目标用户名或项目路径与示例不同，用现场路径替换配置；禁止在代码中硬编码 `/Users/某人`。

候选 `127.0.0.1:18787` 若占用，不杀占用者、不挪其他项目，提出或配置另一个明确端口。本文不指定正式公网域名。

## 3. 建议仓库结构：全部为拟新增

```text
~/Projects/estomago/
  README.md
  package.json
  <选定包管理器的唯一锁文件>
  tsconfig.base.json
  .gitignore
  apps/
    host/src/
      main.ts
      config/{schema,load,doctor}.ts
      auth/{sessions,devices,scopes}.ts
      db/{connection,migrations,transactions}.ts
      conversations/{service,membership,actor}.ts
      messages/{service,repository,revisions,projection}.ts
      events/{inbox,outbox,dispatcher,leases}.ts
      runtime/{adapter,supervisor,runner,capabilities,build-options,sdk-event-normalizer,turn-finalizer}.ts
      identity/{loader,manifest,verifier,bootstrap-receipt}.ts
      reasoning/{service,repository,projector,visibility,reconciler}.ts
      windows/{manager,handoff,bootstrap,recovery}.ts
      time/{clock,context,calendar-time}.ts
      usage/{collector,normalizer,context-meter}.ts
      routing/{detector,gate,decisions,edit-retry}.ts
      output/{segments,ordering,publication}.ts
      media/{assets,stickers,validation}.ts
      delivery/{stream,receipts,notifications}.ts
      wakeups/{scheduler,policy,occurrences}.ts
      calls/{bridge,bindings,interrupts}.ts
      signals/{ingest,consent,filters}.ts
      modules/{registry,context-provider,contracts}.ts
      integrations/{mariposa,siren,superposition,zashidele}/
      calendar/{projection,routes}.ts
      jobs/{service,executor-contract,results}.ts
      mcp/{server,adapter,authorization}.ts
      observability/{audit,logging,health}.ts
    web/src/
      features/{chat,identity-status,routing,usage,calendar,settings}/
      features/chat/{ReasoningPanel,reasoning-reducer,ToolStatus}.tsx
      data/{api,event-stream,cache}.ts
    ios/                  后续原生桥占位，不伪造已完成 App
  packages/
    contracts/src/        API/MCP/event DTO 与严格校验
    test-fixtures/        合成内容；禁止放真实聊天/身份正文
  config/
    estomago.example.yaml
    identity-manifest.example.json
    bootstrap-receipt.example.json
  scripts/
    doctor.mjs            只读检查
    start.mjs             本项目启动，验证配置后执行
    stop.mjs              只停本项目进程树
    backup.mjs            一致性备份，未授权不传云端
    restore.mjs           默认隔离/关闭副作用
    install-launchagent.mjs  显式操作；渲染实际绝对路径
    test-guard.mjs        测试资源/时间/进程保护
  deploy/macos/
    online.charstarearth.estomago.plist.template
  tests/{unit,contract,integration,e2e,mac-smoke}/
  docs/                   本架构包可放这里
  reports/                版本化验收证据；秘密/私人正文排除
```

文件名是职责建议，不要求为凑目录创建空壳几百个文件。小模块可合并；边界、测试和状态不得消失。正式数据不放源码目录。

## 4. 实现路径与验收映射

| 工作包 | 首要修改/新增路径 | 要读的外部来源 | 退出证据 |
|---|---|---|---|
| MAC | config、scripts、deploy/macos | 现场 macOS/Node/服务配置 | doctor、启动/停止/重启、无越界改动 |
| MSG | messages、db、delivery/stream | 无；使用合成消息 | 幂等、修订、断线补发、顺序 |
| INPUT | web/features/chat + messages | 浏览器/移动端输入事件；不依赖模型 | Enter 换行、独立发送键、IME、安全重试、多行保真 |
| EVT | events、conversations/actor | SDK 输入/interrupt 能力 | 单执行者、控制优先、fence |
| ID / CFG / BOOT | identity、runtime/build-options、capabilities | 实际 SDK + 批准身份 + 05 | manifest/receipt 证据分层、自动记忆/连接器隔离、冷启动测试 |
| THINK | runtime/sdk-event-normalizer、reasoning、delivery、web/chat | 实际SDK流样本 + 05 | 实时增量、完整块核对、空/删隐/失败、回放、原文/TTS隔离 |
| WIN | windows、integrations/mariposa | Mariposa 实际 bootstrap/raw 契约 | cutoff、交接、原子指针、失败恢复 |
| TIME | time、wakeups | Mariposa 业务时区 | 跨日/延迟/时钟跳变/回归 |
| USE | usage、web/features/usage | 真实 SDK 流样本和 result 字段 | 请求去重、turn/cumulative 分离 |
| ROUTE | routing、web/features/routing | SDK 实际路由/模型切换能力 | 两选项、重启待决、范围校验 |
| VOICE | calls、integrations/siren | Siren 当前协议与既有取消回归 | 同会话、插话、A/B 独立取消 |
| STICKER | media、output/ordering | 真实资产 API 或新增本项目库 | 序列、权限、渲染、重复防护 |
| WAKE | wakeups、delivery/notifications | 真实设备/推送凭据（获准后） | 到期、过期、双端去重、补同步 |
| SIGNAL | signals、apps/ios | 原生授权与真实字段（获准后） | 撤销、迟到、unknown、无越权披露 |
| MOD | modules、integrations、mcp | 实际 API/MCP schema | 版本、预算、ACL、失败降级 |
| JOB | jobs、zashidele adapter | 对应已授权执行器 | 无执行器诚实不可用、结果回房间 |

## 5. SDK 适配能力矩阵，先测再依赖

在 `runtime/capabilities.ts` 导出带 evidence_ref 的能力记录，不能只有自报 true：

- system_prompt_explicit：自定义系统提示实际生效。
- settings_sources_isolated：user/project/local 来源不会意外加载。
- global_inputs_audited：受管策略、环境、全局配置、自动记忆与连接器经过审计。
- effective_identity_verified：身份/I/规则版本通过校验和隔离测试。
- session_resume_semantics：恢复会话的提示快照、模型和路径行为已知。
- interrupt_supported：能停止当前代；迟到输出被应用 fence 阻断。
- request_usage_observed：能区分请求级、轮级和累计统计。
- precompact_observed / postcompact_observed：钩子或同等信号真实可见。
- route_signal_observed：是否能准确识别路由，而不是只拿到普通拒绝。
- automatic_flag_switch_disabled：相应自动切换已关且设置确实生效。
- route_continue_supported：同意后有真实可调用、范围明确的动作。
- model_change_before/after_observed：区分主动切换、事后变更、临时 fallback。
- model_capacity_known：当前模型窗口容量来源明确。

版本不支持的能力设 unsupported；未测设 unknown。unknown 不能在 doctor 或 UI 冒充 available。路由动作不支持时仍实现 pending/edit/cancel 和明确说明，不造假按钮。

新增能力条目：summarized_thinking_requested、thinking_delta_observed、complete_block_mapping_verified、signature_not_exposed、tool_registry_exact、auto_memory_disabled、auto_connectors_disabled、reasoning_replay_verified。每项为 unknown/supported/unsupported/blocked + evidence_ref；官网说明可作为支持线索，不是实机 PASS。

## 6. 关键实现规章

### 6.1 身份与权限

不能写一个名为“周家明”的默认字符串当身份正本。没有批准材料就让 readiness 报 IDENTITY_BLOCKED。维护者不改 I 正本，也不把 cwd 指向 Mariposa 源码期待它自己找到身份。

显式配置 systemPrompt 和 settingSources；I、记忆基础包、运行规则各只有一个装载位置。不读取未批准的工程 CLAUDE.md。禁止为了接工具开启全局 bypassPermissions。服务器端 ACL 每次校验，不能只靠模型说“我有权限”。

### 6.2 输入框与发送

聊天输入框必须是多行 composer。Enter 的产品语义固定为换行；发送只能通过独立发送键触发，首版不提供任何 Enter 组合键发送捷径。IME `compositionstart/compositionend` 与 Enter 要单测：候选确认不能变成发送或多插一行。

发送时冻结当前 draft revision，并在客户端生成幂等键；按钮防连点只是 UI 辅助，真正的去重仍由服务端 `Idempotency-Key/client_message_id` 完成。多行正文统一以 `\n` 规范化存储并在前端、编辑修订、归档投影中保持等价；用户的换行不拆成多条消息。仅空白且无附件时拒绝发送，不能通过 `trim()` 后重写用户正文。

### 6.3 输出与停止

把生成、正式发布、客户端收到、读到/听到分开。所有输出共享顺序账本；回合被打断后不再发布尾部文字/表情/语音。不得依赖杀死整进程作为唯一停止方法，失败时才由 supervisor 有界终止自己的进程树。

### 6.4 换窗与路由

不修改 transcript 拼接身份、删除触发消息或制造压缩。新窗只有在身份和开窗包通过校验后才能切换指针。路由批准必须绑定输入版本和当前 attempt，多端重复点击只能产生一次有效动作；不能通过配置全局自动切换来实现单次同意。

### 6.5 原文和记忆

原文保存实际发生时间，不用入库时间冒充。Mariposa 不通时保存 outbox，不假成功。hold 不是每窗强制全量摘要；临时交接不得写成当时心情或 I。不恢复旧的“默认三十条原文开窗”、标题全文检索、plan 打开续期等已废止规则。

### 6.6 时间与用量

每轮执行前取时间，不在排队时取一次就一直使用。模型输出的时间不能覆盖服务端时间。token 先标 scope，再计数；累计对象不相加、气泡不重复计、崩溃不把缺数填零，容量未知不画假的 1M 百分比。

### 6.7 设备与隐私

HealthKit 读取、上传到私有后端、提供给外部模型是不同边界。测试用合成观测，不连接当前用户真实健康数据。iOS 后台尽力同步，验收不能用前台轮询冒充后台能力。锁屏推送默认不含敏感正文。

### 6.8 v0.2.1 SDK 装配与摘要实现路径

沿用 `apps/host`，不得因为对话中出现过 `apps/server` 示例就新造第二后端。`build-options.ts` 只负责校验与装配；`sdk-event-normalizer.ts` 负责 SDK 类型到产品事件；`reasoning/projector.ts` 管可读摘要投影；`turn-finalizer.ts` 管异常/取消收尾；前端只渲染已归一化事件。

`tools:[]` 与 MCP 能共存；批准列表不是目录。关闭自动记忆、未选连接器和来源时检查实际生效。effort、返回摘要、UI 展开三者独立；不让 Python 示例改变 TypeScript 技术栈。默认显示名用“思考”，参考图名称仅为候选。

主采集不得是 Stop 后扫 transcript。完整块可能先于 block_stop 到达；一轮不只一条模型消息。无法唯一映射的块保留未配对状态并报告，不用 hash/数组下标猜身份。只在可信前缀关系下补尾，冲突发版本化 snapshot，不重复拼接。

事件回放、摘要投影和对应序号要有原子或可核对的一致性策略。SSE 慢客户端使用有界队列和 cursor 重连，不阻塞 SDK 控制通道。达到存储限制要标截断/降级，不能悄悄丢一半还标完整。

测试摘要不是“我们的话”。禁止误进原文 outbox、TTS、推送、hold、默认交接和普通记忆检索；SDK 的协议继续态由 SDK 管，UI 不回写签名块。权限撤销后的读取和回放同样受控。

Stop/Telegram 方案保持 disabled / not_in_scope，不注册 hook、不创建 bot 或发送真实消息。只有未来用户明确要求时才新增独立通知适配；不作为本版聊天验收依赖。

## 7. 测试顺序与防失控

先单元/契约，再集成/E2E，最后授权真机/真实 SDK/真实推送。第一轮禁并行进程扩散，设每命令超时和测试进程上限；每批结束检查孤儿进程。不能为通过测试关闭权限、绕开路由待决或改正式业务规则。

所有测试指向专用临时 ESTOMAGO_HOME；发现生产目录、正式外部 URL 或未授权真实凭据即终止。验证 start/stop 只影响本项目，不停止其他 Node/Python/cloudflared 进程。

验收矩阵的每项附：执行命令、开始/结束时刻、代码 commit、SDK/runtime/OS 版本、输入夹具、退出码、日志/截图/测试结果路径与有效结论。所有初始状态为 NOT_EXECUTED，禁止生成器批量改 PASS。

## 8. 部署关卡

A：Mac 只读核验完成，项目路径/端口明确，不与旧项目冲突。

B：本地私聊链路通过，包括身份、消息、思考摘要实时流及隔离、时间、token、停止、换窗和路由待决。

C：独立测试凭据接入 Mariposa/Siren/许愿星；证明没有私聊/群聊越权和原文丢失。

D：登录、TLS、推送授权、备份恢复、Mac 睡眠/重启场景通过后，才申请公网开放。

E：真正迁移某个旧服务时，先有备份和回退，切换单一调度权，不双机运行同一正式主动任务。estómago 新建本身不要求立即迁完所有项目。

## 9. 交付报告模板

```text
代码位置：实际绝对路径
数据位置：实际绝对路径
版本：commit / SDK / runtime / macOS
本轮改动：新增、修改、未动的范围
测试：PASS / FAIL / BLOCKED / NOT_EXECUTED 的真实数量
关键证据：身份加载与观测范围、思考增量/回放/隔离、换窗、路由、原文、通话、推送分别列
外部依赖：已联调 / 模拟 / 缺凭据 / 不支持
仍需用户决定：仅列真正未定的域名、预算或授权
回退：实际备份位置与恢复验证结果
```

**“架构写好”“代码写好”“隔离测试通过”“Mac 实机通过”“公网运行”是五种不同状态，报告不得混用。**

## 10. 本轮范围追踪

原 115 个验收 ID 全部保留；本版新增 46 项，共 161 项。旧项修订内容见矩阵 revision_log；不能因升级版本清空既有实施者的证据，若现场已有执行结果，应另存历史结果并针对新规格复测。本包所有状态仍为 NOT_EXECUTED，未把资料查证计为运行验收。
