# 05 · 系统异常红点与单条消息 token 预估

范围：U-SYSTEM-01/02、U-TOKEN-01/02；本章是这两项的字段、状态与验收语义正本。
目的：使缓存与后台消耗异常可见，同时不把预估当成账单、不用提醒制造新模型请求。
现有用量账本、SSE、换窗提示继续复用；不建立独立监控服务。

## 1. 用户界面

统一前端顶栏保留“系统通知”入口。桌面可开侧栏，手机开抽屉/页面；有可访问名称，不只依赖颜色。

- 红点：存在未读 warning/critical 系统异常。
- “待处理 N”：仍有 open 的异常。读过后红点可消失，但待处理状态不消失。
- 页面列出：发生时间、短标题、受影响通道/用途、是否可能产生额外消耗、已知用量/未知状态、系统已采取动作、可操作入口。
- 严重的“禁用后仍派发”“压缩越过用户策略”“预算越限仍派发”等，除入中心外，显示非阻塞状态条；对应后台能力自动停止领取新步骤。
- 已解决项留在历史。不能仅刷新页面就清空。
- 换窗/手选历史提示仍在原位置；正常换窗不反复制造红点。
- 朋友圈未读、聊天未读、普通闹钟提醒各有语义，不汇入“系统故障”红点。
- 通知不写入普通聊天原文，不注入模型上下文，不触发hold，也不触发一次AI解释费用。

普通错误文案说明发生了什么，例如：
“缓存保温失败：本轮未确认缓存续期，已暂停自动重试。”
“本轮已发生 2 次模型请求，另 1 次费用结果未知。”
禁止写“已扣 $0”来表示未知，禁止错误堆栈/真实URL参数/凭据/私人正文上屏。

## 2. 监控边界

“一切消耗异常”指所有经过est模型驱动、后台调度及已接入外部付费工具的请求。用户在别的终端独立运行的CC、别的应用账单，est没有观测来源时不能宣称覆盖。
外部服务的观测合同见03/04；未知覆盖显示 unknown，不默认为零。

### 2.1 事件类别

| code | 触发依据 | 级别/处理 |
| --- | --- | --- |
| CACHE_PARAMETER_REJECTED | 上游明确拒绝指定TTL/缓存参数 | warning；停止同参数自动重试，不切5m/模型 |
| CACHE_TTL_UNVERIFIED | 所选驱动没有证据落实用户1h策略，例如旧SDK装配 | warning；页面显示未核实，不能显示已生效 |
| CACHE_TTL_MISMATCH | 最终生效参数/可用供应商证据与正本冲突 | critical；停止后台保温，人工聊天按显式错误处理 |
| CACHE_PREFIX_CHANGED | 同窗未授权的tools/system/history改写被断言发现 | critical；阻止该请求，走受控恢复 |
| CACHE_UNEXPECTED_MISS | 有符合条件的温缓存预期，但完整usage明确read=0 | warning；聚合；不立即重试同一大请求 |
| CACHE_KEEPWARM_FAILED | 到期保温失败/无法确认续期 | warning；有界停止，勿把失败记成刷新 |
| CONTEXT_COMPACTION_UNEXPECTED | SDK/API观测到未许可压缩或摘要替换 | critical；停止后续步骤，保留证据，交既有人工换窗 |
| UNEXPECTED_DISPATCH | 没有有效用户回合或有效背景run/admission的模型/付费动作 | critical；挡新派发 |
| DISPATCH_AFTER_DISABLED | 关闭已生效，仍实际派发，或检测到绕过准入的执行路径 | critical；停止后续派发，保留开关版本与run引用 |
| RETRY_BUDGET_EXCEEDED | 达到预算后仍实际重试，或重试绕过准入 | critical；停止后续派发 |
| BACKGROUND_BUDGET_REACHED | 预占使下一步超过明确上限 | warning；正常保护性终止；不伪称服务崩溃 |
| COST_EXCEEDS_RESERVATION | 实际费用超过本次保守预占或配置硬线 | critical；账本照实，停止后续后台动作 |
| USAGE_MISSING | 已可能执行的请求结束后，在约定结算宽限期内仍无应有usage | warning；保留unknown，禁止预算当作全额释放 |
| USAGE_INCONSISTENT | 负数/分类和大于总量/同请求冲突终值等明确矛盾 | warning；隔离该观测，不用它覆盖可信终值 |
| TOOL_OUTCOME_UNKNOWN | 外部写/付费动作响应失联，无法确定结果 | warning；同operation_id查询，不自动再做一次 |
| BACKGROUND_DUPLICATE | 同一任务时隙出现两个有效owner或真实重复派发 | critical；停止受影响路径，追踪已发费用；唯一约束正常挡住第二个领取不报警 |
| BACKGROUND_OVERRUN | 超过单轮时间/步骤/输出上限 | warning；fence后停止续步，迟到usage仍记账 |
| RAW_ARCHIVE_FAILED | 原文同步失败/冲突/长时间积压 | warning；本地原文仍可读，不丢弃重建 |
| ASSET_ARCHIVE_CONTRACT_UNVERIFIED | 附件资产合同未核实却需要归档 | warning；文字/附件同步分列，不伪报完整成功 |
| MEDIA_OR_TOOL_FAILED | 已接入能力真实失败，影响消息或有潜在额外消耗 | warning；按operation聚合 |
| CLOCK_OR_RECOVERY_UNCERTAIN | 时钟/崩溃恢复不能安全判断预算与任务领取 | warning；暂停新背景活动，普通页面保持可用 |

模块可以添加具体code，但必须登记、测试，并说明计费/重试行为；不得通过任意字符串把所有日志都变成红点。

正常关闭后旧闭包恢复、随后被准入门拦住，是 `AUTONOMOUS_DISABLED` 正常终止；正常达到次数门是保护性停止。二者不得仅因“曾尝试进入门”就触发critical。预算达到可聚合成一次可读提醒，不能每次调度轮询重复增加次数。`BACKGROUND_BUDGET_EXHAUSTED` 映射到 `BACKGROUND_BUDGET_REACHED`；外部动作的 `BACKGROUND_OUTCOME_UNKNOWN` 映射到 `TOOL_OUTCOME_UNKNOWN`；模型用量缺失按结算宽限触发 `USAGE_MISSING`。`BACKGROUND_CLOCK_REGRESSION` 映射到 `CLOCK_OR_RECOVERY_UNCERTAIN`；上游强制压缩策略冲突映射到 `CONTEXT_COMPACTION_UNEXPECTED` 的 policy_conflict 原因，页面明确“发现策略冲突”而非伪称已经发生压缩。尚未发送、仅缺少缓存证据的保温状态不算一次维护失败。

### 2.2 缓存未命中不能见0就报错

以下属于正常 cold 或不确定，展示信息即可，不自动触发 CACHE_UNEXPECTED_MISS：

- 首次请求、正常新窗口、改模型/获准工具集合变化后的首请求；
- 超过1h或无法确定最近相关缓存的时间；
- 提示不足该模型的最小可缓存长度；
- 供应商没有提供cache计数字段（null不是0）；
- 媒体重新物化、明确受控换窗等已知前缀变化；
- 只命中A/B而新增尾部需要写入的部分命中；cache_read > 0并不证明整窗都命中。

候选异常必须同时有：相同模型/生效上游约束、相同可缓存前缀版本、上次可靠缓存读写证据、仍在预计TTL内、本次完整usage明确read=0。路由节点不可见时，文案为“未命中预期缓存”，不能断言供应商故障。
不引入“为了查是否命中再调用模型”的诊断请求。

### 2.3 用量缺失与服务能力正常缺失

供应商本来不返回美元费用时：cost_unknown=true、展示“实际费用未提供”；不能每条都制造严重故障。若此前有约定结算来源却超时缺失，则USAGE_MISSING。
预算需要可靠的上限时，依据配置的已核价格/付费工具max-cost预占；若没有可用上限，后台付费能力不可启用，不能把unknown当免费。

## 3. 复用现有事件，不再做第二套事件总线

生产点：runner / supervisor / usage collector / archive sync / tools / scheduler。
统一调用 SystemAlertService.observe({code,scope,dedupe_key,...})。

事务顺序：
1. 更新system_alerts聚合行。
2. 同一SQLite事务persistInTx系统通知事件。
3. 把返回的sequence写回告警last_event_sequence。
4. 事务提交后dispatchRow，沿现有SSE重放。

SSE kind：system.alert.changed、system.alert.read。
payload仅含alert_id、revision、severity、lifecycle、last_event_sequence、聚合计数和无正文摘要。前端以sequence去重并重新读取授权快照。
不能先发SSE再写DB，不能因浏览器离线丢告警。

## 4. 最小数据模型

### system_alerts

| 字段 | 语义 |
| --- | --- |
| id | 稳定ID |
| scope_kind / scope_id | system / conversation / integration / background_run 等作用域 |
| code / severity | 受控枚举 |
| dedupe_key | code+作用域+具体操作/窗口标识；不含正文/URL/query/key |
| lifecycle | open或resolved |
| revision | 每次可观察状态变化递增 |
| first_occurred_at / last_occurred_at / resolved_at | UTC时间 |
| occurrence_count | 真实异常出现次数，不是SSE回放次数 |
| last_event_sequence | 当前告警最新可见版本的SSE序号 |
| safe_summary_json | 结构化短文案参数，白名单 |
| related_request_id / related_run_id / related_turn_id | 可为空；不能只依赖turn |
| last_dedupe_observation_id | 最近去重输入事件；只作快捷字段，不能独自承担乱序重放的去重保证 |

唯一索引dedupe_key；复发可复用告警ID但重新open、revision/sequence增加。某一故障若已跨新窗口/新operation，使用新key，避免终生合并。
输入必须有稳定 observation_id（如request_id+attempt+terminal_state）。利用原有来源账本唯一键/事件sequence确认是否已消费；不能只比较last_dedupe_observation_id而让较旧重复事件再次计数。若来源没有可用唯一消费约束，增加同模块最小去重索引，不能引入新事件平台。去重范围为同一真实故障/操作，不用固定时间窗把不同收费操作合并。前端刷新频率只按policy-defaults。

### system_alert_reads

主键(actor_id,alert_id)，seen_event_sequence整数、seen_at。当前UI读者为qiaosheng，数据形状保留按actor，以免后续双端状态互串。char不能用业务工具把宿主用户的提醒标已读。
不需要alert_delivery消息队列；沿现SSE和重连快照。

### 已读与恢复

- 已读：用户实际看过该版本。
- 恢复：真实故障条件解除，或受控处理结果明确。
- “全部已读”只提交当前快照已返回的ID与sequence，不能覆盖操作过程中后来到达的新异常。
- 刷新usage、网络恢复、再次观测成功可更新恢复状态，但必须对应同一故障条件；一个成功HTTP不能解决未知扣费。
- code结算未知需结果查询/核对闭环，不能设置计时器自动resolve。

## 5. HTTP与前端合同（拟新增）

### GET /api/v1/system-alerts

query：lifecycle=all|open|resolved、unread_only、limit、cursor。
默认limit20，max100；排序(last_event_sequence DESC,id DESC)，opaque cursor绑定过滤与权限作用域。
返回items、next_cursor、has_more、unread_anomaly_count、open_count、snapshot_sequence。
限量第一页不是全部；不得假装加载完。

### GET /api/v1/system-alerts/summary

轻量状态：unread_anomaly_count、open_count、highest_open_severity、snapshot_sequence。
页面启动/重连调用一次，SSE更新后有界刷新；不每秒无限轮询。

### POST /api/v1/system-alerts/read

body：items:[{alert_id,seen_event_sequence}]，最多100。
server只接受用户有权读取的alert与不超过该alert已存在版本的sequence；更新用max(old_seen,incoming_seen)。
并发新事件sequence更大仍未读。幂等，不resolve故障。

只接受POST/PUT/DELETE的mutation，沿现有Origin门。此处不用PATCH，避免漏过旧路由mutation判断。
告警产生/恢复是内部服务接口，不向浏览器开放任意code创建或自填“已修复”。

## 6. 所有费用要有归属

复用04的每次dispatch前admission与attempt账本。所有模型/付费工具尝试必须包含：
conversation_id、window_id（可空）、purpose、request_id或tool_operation_id、background_run_id（可空）、dispatch_started_at。
purpose沿现chat/pre_rotate_review/proactive_turn/cache_keepalive；外部工具另有provider/service与operation，不能伪装成模型token。

需要修准的旧实现：
- summaryForTurn目前依赖attempt与completed状态；后台统计须从run/request归属出发，不能因没有用户turn而漏钱。
- SDK stream/result同一请求观测去重；cumulative是快照，不能再加到request。
- OR prompt_tokens已含cache分类；SDK原生input可能是未缓存部分，必须先按provider归一化再求合计，不能把OR cache读写加第二遍。
- 被停止/丢弃的文本不显示，但迟到真实usage仍接收、去重、记到原请求/背景run。
- 成本和token完整度独立。每个聚合返回known_subtotal、unknown_count与complete_total(可null)，不要让一个模糊completeness把所有字段一并归零。
- unknown费用不能释放已预占预算；04定义结算状态，05只消费结果，不另做预算算法。

新背景费用按 `background_dispatches.budget_day` 汇总，即真实派发开始时的 Asia/Shanghai 日期。usage.observed_at 只说明获得证据的时间，不能把跨午夜返回的费用挪到新一天。旧记录缺少可靠派发时间时保留旧时间来源并标 `legacy_observed_at`，不回填虚构时间。

本章不增加按用户正文自动判断“这轮值不值得花钱”的模型。

## 7. 单条消息预计token：三个视图

### 7.1 编辑器中

默认常驻：
“本条文字约 N token”
有附件时：
“文字约 N · 图片约 M”或“图片用量待估”。

点击展开：
“本次请求输入约 T（含历史、身份、工具与本条）”
“回复输出上限 O；后续工具续答/重试另计”
“缓存部分占上下文；命中可能降低费用，无法预先保证。”

不把回复上限O显示成“预计一定生成O”，不把本条N显示成整轮成本。
单纯计算/打开预估面板零模型调用、零外部网络、零hold/换窗/缓存刷新。

### 7.2 已发送的用户消息

随message revision保存发送前快照，含model、estimator_revision、quality、正文/媒体估计和computed_at。重新打开历史仍能显示“发送时估计”。
后续改模型不回写旧估计。编辑产生新revision和新快照；旧版本估计留在旧修订。
历史旧消息可本地按当前模型临时估计，但必须标“按当前模型粗估”，不能伪造旧发送时快照。

### 7.3 char回复/分段气泡

每条正文可显示可见文字的本地估计。模型usage通常是请求/轮级，不保证每条气泡有单独实际值。
三段回复共用一次模型请求时：
- 各段可显示“正文约N”；
- “本轮实际输入/输出/费用”只在轮汇总出现一次；
- 不能把整轮actual重复贴三份，也不能按字数平均摊成精确实际；
- 思考、工具参数和隐藏协议开销不属于正文估计，但计入供应商真实用量。

## 8. 估计实现：一个纯函数来源

新增 apps/host/src/usage/estimator.ts，供composer预估、发送前容量探针、手选历史预览、记录面板共同调用。原有estimate_chars_per_token及实际usage校准逻辑移入此处，不能只给UI再复制一套算法。

纯函数输入：
model/provider、tokenizer_or_rough_profile、content、附件元数据、当前窗口的可恢复发送投影、output_cap、estimator_revision。

输出：
- message_text_tokens；
- message_media_tokens（不可估时null）；
- message_total_tokens（有未知组成则null，同时保留已知小计）；
- request_input_tokens（可null）；
- output_cap_tokens；
- quality：model_tokenizer|rough_text|partial_media|unavailable；
- unknown_components；
- model、profile_revision、estimator_revision；
- source_window_id、source_window_revision、payload_projection_hash；
- scope：message_only或request_preview。

实现选择：
1. 有离线且与目标模型吻合的tokenizer时，使用已验证tokenizer并标版本。
2. 其余沿现配置粗估系数，用Unicode码点统一计数；明确rough，不能称精确token。
3. 完整请求以规范化发送投影计算，包含系统/工具定义/人工选集/工具消息/附件表示；不能只把messages正文相加。
4. 不把base64字符串长度当图像token。按已核模型图像规则估算，未知则partial_media；二进制附件base64不进入普通文字估计。
   转写费用单列外部service费用；转写文字实际进入模型请求时才计文字token。原音频没有进入模型输入时，不能再重复添加一次“音频token”。
5. 实际usage可以校准同一模型/同类完整输入的容量保守下界；不能拿“整轮输入÷这条文字长度”来校准单消息。
6. 不下载大向量模型为计数，不在每次按键调用count_tokens API或主模型。
7. 预估不更改window_trajectories，也不把待发送草稿入库/日志。

预览是只读派生，不建新的上下文正本。若无法在无副作用条件重建完整投影，返回message_only并说明request unavailable，不能顺便触发bootstrap/模型请求补齐。

类型边界：rough/partial 的 `request_input_tokens` 用于显示与已有容量探针，不自动成为 `billable_input_upper_bound`。后台美元预占需要04定义的可信计费上界；两者共享投影来源，但不能混淆可信度。

## 9. token预估API（拟新增）

### POST /api/v1/token-estimates

body：
conversation_id；
client_draft_revision；
content（string）；
attachments（与发送DTO同形）；
include_request_estimate（boolean）。

返回：
client_draft_revision、model_snapshot_id、window_id/revision、
attachment_fingerprint、projection_version、estimate（上述结构）、stale_after_state_change=true。

不返回凭据/身份正文/历史原文；不写message、不生成turn、不触发window rotate。
服务端有请求大小上限；前端按policy-defaults debounce，同一draft更新取消旧预览。
媒体预览只读取est已有资产元数据；不下载源图、不调用转写/生图、不刷新签名URL。没有可用元数据时返回未知组成。
只应用同时匹配draft_revision、model_snapshot与附件fingerprint的响应，防止慢响应覆盖新输入。

没有活动窗/等待人工选集时：message estimate照给，request estimate为null并标pending_selection。预览不可替用户零选。

估计失败仅显示“预计用量暂不可用”，不禁用户正常发送；真正发送仍走现有容量和身份硬门。
后台每次transport前必须重新核算，不得用几秒前的UI预估当预算授权。

### 消息DTO新增（additive）

revision.token_estimate：可null（旧消息）；
revision.attachments：默认[]；
turn usage仍走现有 GET /api/v1/turns/:id/usage，扩展按字段的已知小计/未知状态，不破坏旧consumer字段。
保留文本content_hash。附件fingerprint与token_estimate分开，不让估计刷新改变正文hash/修订号。

## 10. 安全、性能与限度

- 预估纯本地运算；body不入访问日志，不持久化未发送草稿。
- 小屏不每条展开多行费用：正文下小字+详情按钮，系统红点单独顶栏入口。
- 多窗口/重连通过后端快照恢复通知状态；不能只在localStorage存红点。
- 默认不对“用户聊得多”本身报警；只对明确配置上限/不一致/隐藏重复消耗/异常缓存等报警。
- 重复网络错误聚合显示次数，不能一秒弹十个toast。
- 本章不承诺供应商不可见的物理cache节点、未接服务账单或未知tokenizer可精确测量。

## 11. 必须有的针对性验收

- 正常冷启动/换窗cache_read=0：无异常红点；符合温缓存条件的read=0：有一条聚合异常。
- cache_read字段缺失：显示未知，不当成0或命中。
- 同一request的stream/result重复：只记一次费用，不重复加红点。
- 两次真实重试：两个dispatch，原run预算累计；第二次usage未知不能显示总计0。
- 关闭auto后竞态领取任务：新派发被挡，正常停止不冒critical；故意注入绕过准入的路径时，告警可追踪开关revision并阻止后续动作。
- 标记已读与新异常同时发生：只旧版本已读，新版仍红点。
- 读过open告警：红点可清，待处理项仍显示；真实解决后进入历史。
- SSE重复/断线/重启：状态一致，不凭页面内存消失。
- 三段回复：正文估计各自显示，整轮actual只累计一次。
- 输入中文、ASCII、emoji、代码块与组合附件；未知图片token必须partial，不显示精确总量。
- 预览期间切模型/改附件/换窗：旧响应不能覆盖新状态。
- 发送前后预估、显示旧消息、查看系统中心：断言模型/付费服务调用次数=0。
- 无turn的cache_keepalive/proactive工具费用：日期与用途汇总仍能看到。
- SDK final options无TTL证据：UI不得写“已生效1h”；异常中心有明确状态。

上述场景映射到acceptance.json。验证真实行为和计数，不仅断言字符串/枚举存在。

