# estómago 时间与换窗根因修复交付

## 状态与基线

已完成本仓代码修复和离线验证。初次交付未部署；随后用户明确授权 push 和切生产，已完成发布，详见下方部署记录。未调用真实收费模型；发布核验仅读取计数、状态和哈希。SDK 非空选集属于明确阻断的能力边界，不能把本报告解释为 SDK 已支持角色保真的原文携带。

源仓：`/Users/user/Projects/estomago`，`main@e73abfe`，开工时工作树干净。交接文档的 `4e3788e` 之后已有 `8e52eba` 时间压缩及 `d4884d7` 聊天／浮现生命周期修复，均保留后续有效行为。施工副本：`/Users/user/Documents/Codex/2026-10-21/glm-token`，从源仓同一提交本地复制；没有改其他 worktree 或兄弟项目。首次同步因目标目录授权范围被自动审批拦截，未改动源仓。用户随后明确回复“同意”授权同步。2026-10-21 再次确认源仓仍为相同提交且干净后，已将 32 个源码、测试和文档文件同步到源仓，逐文件 SHA-256 与验证副本完全一致。原仓同步后类型检查与 2 个关键回归文件再次通过。交付为两处一致的未提交工作树变更，不推送远端、不部署。

用户在施工会话中明确覆盖交接文档第 3.1 节：最终采用下列两行，第一行是用户两条消息的发送间隔，不是模型处理延迟。

```text
user_gap: PT26H7M
2026-10-21 08:33 Wed UTC+8
```

## 根因、唯一调用链与保留项

- **时间语义**：`buildTimeContext → modelTimeContextText → assembleContext`。同一捕获时间计算日期／星期／分钟／时区，午夜 `00:xx`；用户间隔用原发送修订，编辑、助手发言、后续排队输入均不重置它。不再生成 daypart、her-last 或 new-day 字段；结构化时间事实仍在库中。
- **选集来源与日期**：`confirmed selection → loadForProjection → loadContents → selectionGuides → buildEnvelope → initial trajectory`。原消息修订、hash、角色、sequence 均验证；缺修订直接失败。用户时间按选中修订的 supersedes 链回到原发送，助手按 published_at；有修复标记或无可信时间就不用具体日期。正文、角色、序号锚、图片文本占位、合法语音转写均保留。引导语和缺口分隔来自宿主，不算原文引用。
- **时间冻结**：v31 持久化 projection_reference_at，轨迹保存实际投影。正常回放及工具续轮复用已发送快照，旧 JSON 时间和旧浮现不重渲染。仅未派发轨迹仍可按既有规则重建。
- **原因与评审解耦**：手动入口和确认恢复统一进入 `rotateConfirmed → rotateIfNeeded → doRotate → WindowManager.rotate`。普通聊天先评估容量，服务端记录 capacity；确认和重启不把它变成 manual。手动无 review、无自动 hold、无伪 completed/skipped 记录。容量保留提醒开关、真实范围、去重、失败上限、取消和 no_new_hold。
- **安全与事务**：身份与指纹、活动窗口、串行队列、活跃评审、生成、路由、未知写账本、选集完整性及新窗容量均检查；未知 hold 用原 operation_id 查回执。资料准备在事务外，事务内再次检查生成／路由／评审／未决写，窗口指针、选集消费和初始轨迹一起提交。失败不恢复待答输入；提交后入队前崩溃，可凭 consumed + 当前目标窗恢复一次。必要安全依赖缺失返回 blocked，不调用旧直转分支。
- **旧原文不是补记债**：从 `forTargetWindow` 的已消费选集取精确消息修订，作为自动评审焦点的背景豁免。没有写入假 held/reviewed 覆盖；新见消息、用户当前保存旧事的请求及自主 hold 继续正常工作。现行人工选集仅支持整条修订，本轮没有新增片段选择系统。
- **浮现**：`renderAugmentation` 保留批准正文和短 ref，分别列事件时间，声明仅包尾一次。日期只有 exact 且日历合法时采用，可信时分才显示时分；未知不补午夜。声明和校验值同源。缺 ref 明确失败，不输出可调用假引用。详情授权、映射、版本、幂等、取消和最近修订失效修复保留。

## 删除与兼容

删除 `modelTimeContextJson` 接口、旧 PT 小时取整 helper、force 同时表示容量绕过和手动原因的语义、manualRotateInner 的身份／SDK 低安全直转旁路、selection-gaps 技术报告、sf_unknown 输出、旧声明的固定 60 字节／旧 hash 锁、按历史成功指针高水位猜测携带范围的逻辑。自动评审专用 prompt 现在仅接受 capacity；原手动强制评审测试改为容量评审测试或手动零请求断言，没有跳过整个文件。

保留旧迁移、原文／修订、轨迹、回执、hold 成功指针、工具冻结、TTL 和 A/B/G 策略。`fixedSystemCount` 仅补充识别新宿主引导／浮现文本，避免误把它们当 B；不恢复“数所有 system”旧算法。工具和路由不改，容量配置不改，未启用压缩。

Golden 先保留旧副本及 hash，仅手工更新两处允许的固定规则文字。格式用额外未经归一化的断言验证；canonicalize 先深拷贝，不修改捕获的 wire；匹配新格式的规则是具体的两行语法，不是把整段上下文吞掉。旧 JSON 兼容只服务于已有历史数据。

## 迁移

v31：context_selections 新增 rotation_cause、projection_reference_at 两列。旧 awaiting/confirmed 原因为 NULL，恢复返回 ROTATION_CAUSE_UNKNOWN，不默认手动或容量，也不收费猜测。活动窗口明确的新手动请求可以接管，审计保留原原因。confirmed/consumed 的确认幂等键复用；重复恢复不产生第二次切换或原文归档。

迁移为向前添加列，不重写旧 schema 或原文。旧二进制虽然能读表，但不维护新原因／时间合同，会重新使用旧手动评审政策；有待处理选集时回退须人工核对，不默认删列或清空数据库。

## 验证与矩阵

全部使用独立临时 ESTOMAGO_HOME、ESTOMAGO_TEST_MODE=1 和 fake runner/transport。先前沙箱回环监听 EPERM、副本缺 React 依赖导致的失败已记录和排除；没有把这些失败算 PASS。最终完整结果为 **137/137 文件、933/933 测试通过，0 失败、0 跳过、0 取消**。主机类型检查、Web 类型检查、Web 构建均通过；Web 构建只有现有 Vite inlineDynamicImports 弃用提示，产物未发生变化。

```sh
npm run typecheck
npm run typecheck:web
npm run build:web
ESTOMAGO_HOME=$(mktemp -d /tmp/est-delivery-tests.XXXXXX) ESTOMAGO_TEST_MODE=1 npm test
```

HTTP 测试仅需本机回环监听权限，没有对外真实服务调用。最终结果计数、golden 前后 SHA 和成本数据见 [results.json](context-rotation-evidence/results.json)。

| 交接 ID | 行为证据／实际断言 |
| --- | --- |
| T01–T02 | time-usage-segments：固定捕获时间，Wed/UTC+8、上海跨日与午夜；精确两行和分钟级 PT |
| T03–T04、C03–C04 | envelope-golden-baseline：三轮及工具续轮最终 wire；context-rotation-root：旧 JSON 保留、新文本追加、篡改仍报 HISTORY_CHANGED |
| T05–T07、T13 | context-rotation-root：今天／昨天／前天、两分钟跨午夜、月末／年末、多段及缺口；无接续标记统一说过的话 |
| T08–T10 | context-rotation-root：冻结初始轨迹、新轮前缀及重新读取相等；编辑祖先时间、修复时间未知；正文里的 time_context/tool_calls/JSON 未删 |
| T11–T12 | exec-v1-wp3-model、wp3-manual-selection、context-rotation-root：语音／图片修订投影、空选与未确认、hash／修订检查、缺修订拒绝 |
| T14、R11 | 原话 seq/manifest 保留；wp4-conversation-read、hold/quote 既有回归与 or-rotation 自主 hold 成功收据／指针验证通过；没有新增旧原文 hold 禁令 |
| R01–R04、R07 | context-rotation-root：OR/DS 手动 intent→选集→消费，额外请求 0、无 review/checkpoint、新输入仅正常请求一次 |
| R05–R06 | context-rotation-root：容量阻断后关闭／重新打开 DB 和服务，原因仍 capacity；确认完成真实 fake review 和待答输入 |
| R08–R10 | or-rotation、review-policy、context-rotation-root：空范围／合法凭证去重；同原文重复携带两次无模型请求／假 checkpoint |
| R12 | context-rotation-root：unknown 阻断，原 op 查成功后放行，无 memory.hold 重放；remediation-batch1 覆盖未提交与错配收据 |
| R13 | remediation-batch1/5、aud-05-06-23-route-gate-tx 等：评审／生成／路由互斥、队列和取消、原子事务守卫 |
| R14–R15 | wp7-selection-state-machine、context-rotation-root：初始轨迹写失败全部回滚、不恢复；重试仅一次；切换后入队前崩溃从 consumed 恢复 |
| R16–R17 | context-rotation-root：缺原因明确 blocked；新手动意图接管；旧评审失败达上限不会强制新评审 |
| R18 | audit-d-fixes：身份变化无失效内容外发；context-rotation-root：缺安全依赖阻断；SDK 非空选集明确阻断且不消费；aud-03-sessions SDK/mock 既有会话回归通过 |
| M01–M04 | context-rotation-root、surfacing-core/seam：单／多／空包、原文、日期精度与未知、短 ref 详情、声明唯一包尾及校验 |
| M05、C06 | joint-audit-surfacing、surfacing 系列：编辑、取消、重试、已发送冻结及 transport gate；未新增 OR/SDK 浮现支持 |
| C01–C02 | context-rotation-root：分别跑 OpenRouter 和 DeepSeek 假 transport；角色／冻结前缀／时间引导检查；新 system 数据不被算作 B |
| C05 | 同源合成基线执行与字节测量，见下节；实际 Opus tokenizer／美元费用未测 |

## Wire 与成本证据

OR 与 DS 都通过其真正的 payload builder/runner 接入 fake transport。人工原文保留 user/assistant 角色，宿主引导独立 system，选集中不复制工具协议历史。OR 继续使用既有显式缓存参数，DS 不新增 OR 专属字段；并未把 DS golden 当作 OR 验证。

合成原文包含 `synthetic [time_context] {"tool_calls":[]} 工具已剥离`，两条驱动均按正文保留，没有正则清洗。日期引导示意：

```text
system: 这是你们昨天（2026-10-20）说过的话：
user: [既有 seq 锚] synthetic one
system: —— 原文片段 ——

这是你们昨天（2026-10-20）说过的话：
assistant: [既有 seq 锚] synthetic two
```

| 合成测量 | 旧基线 | 新实现 |
| --- | ---: | ---: |
| 一次正常聊天后明确空选手动换窗的额外模型请求 | 1 | 0（OR、DS 分别验证） |
| 指定样例时间文本 UTF-8 字节 | 54 | 44 |
| seq 1、4，均 2026-10-20，参照 2026-10-21 的引导／分隔 UTF-8 字节 | 132 | 126 |
| synthetic one / synthetic two 原文字节 | 26 | 26 |

请求数基线从 e73abfe 导出到独立临时目录，用同构 compose、fake transport、明确空选、no_new_hold 回执实测，轮转成功。没有把正常聊天请求混入换窗检查计数。复现用 [基线 fixture](context-rotation-evidence/baseline-manual.fixture.ts)：复制到 e73abfe 导出目录的 tests/unit/context-rotation-baseline.test.ts，再用正式 npm test -- --unit --file=tests/unit/context-rotation-baseline.test.ts 运行。

字节数不是 token 数。没有 Opus 4.6 本地 tokenizer 实测，不承诺固定节省比例或美元收益。新时间文本同时修正了原旧行的间隔语义；上表不能被理解为仅压缩了相同语义的数据。

## 交付边界

- 非空人工选集在 SDK 上仍不可用，返回明确能力错误，旧窗／选集不动；未发明将历史角色压成一条 user/system 的伪支持。
- 浮现仍只支持现有 DeepSeek transport，OR/SDK 能力门未绕过。
- 生产迁移、部署、启用 flag、真实供应商缓存命中与 tokenizer 验证均未执行。本次仅交付代码、离线证据和现行规格。


## 后续授权部署记录

2026-10-21 02:26 PDT，用户明确授权“push，然后部署切生产”。

- 代码提交 `72ea946` 已正常推送 origin/main；没有强推。
- 重启前完成一致性备份：`chat-2026-10-21T09-25-17-277Z`，包括 chat/content 数据库、媒体及受保护配置；保留全部旧备份，备份不进 Git。
- 仅通过既有 LaunchAgent 对聊天主服务发送 SIGTERM 并正常拉起；未改隧道、凭据、内容服务配置或模型选项。
- 生产 schema 从 v30 升至 v31，新列存在，SQLite quick_check=ok。
- 旧轨迹、成功指针、活动窗口哈希及消息／修订数量不变。provider_requests 发布前后均 296，核验未产生模型请求。
- `/health/live` 200；登录页、认证后的聊天页和 chat-app.js 均 200，JS 与提交产物字节一致。
- `/health/ready` 发布前后均 503，降级项相同：runtime unknown、archive unknown、push disabled。这是既存健康报告状态，不宣称全项 ready，也未为本次发布修改探测配置。
- 本节覆盖上文离线阶段“未部署／未重启／未提交”的时间性状态；SDK 非空选集和浮现 transport 的能力限制不变。
