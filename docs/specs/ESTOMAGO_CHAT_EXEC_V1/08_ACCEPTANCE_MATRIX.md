# 08 · 实施验收矩阵

由 contracts/acceptance.json 生成。共 40 项需求、114 条验收场景。

**全部初始状态为 NOT_EXECUTED。** 本矩阵是施工与验证要求，不是已实现测试报告。

每项的前置条件、步骤、证据要求在JSON同ID下。离线fixture不能证明真实供应商已支持；外部缺口按BLOCKED_DEPENDENCY单列。

verification含义：offline_behavioral为实际实现的隔离行为测试；source_contract为源码/合同核验；manual_ui为真实界面检查；external_contract为实际外部能力核验；deferred_boundary为已定延期边界检查。

## BASE · 3 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| BASE-01 | 当前HEAD和源码事实重新定位 / WP0 | 不reset或覆盖别人的改动；记录真实provider与未核运行状态，README不代替运行配置 | U-MODEL-01, U-EXT-01 | NOT_EXECUTED |
| BASE-02 | 旧配置升级与新默认不偷偷启用收费 / WP0 | 保留现配置；auto/keepwarm false、日金额null；无模型网络请求 | U-WAKE-01, U-CACHE-01 | NOT_EXECUTED |
| BASE-03 | 迁移中断与fresh install / WP0 | 消息正文hash和旧revision不变；新表只建立一次；无生产路径、模型调用或数据丢失 | U-CHAT-01, U-CONTEXT-02 | NOT_EXECUTED |

## ALERT · 8 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| ALERT-01 | 正常冷缓存与温缓存意外未命中区分 / WP1 | 只有符合完整温态条件的read0触发未命中异常；缺失显示unknown，部分命中不称全命中 | U-SYSTEM-01, U-CACHE-01 | NOT_EXECUTED |
| ALERT-02 | 告警已读与恢复独立 / WP1 | 已读后红点可消失但open保留；恢复后历史仍在；已读动作不调用模型或resolve | U-SYSTEM-02 | NOT_EXECUTED |
| ALERT-03 | 并发新告警不会被全部已读吞掉 / WP1 | 102仍未读；seen不倒退；重连与另一页面同一快照 | U-SYSTEM-02 | NOT_EXECUTED |
| ALERT-04 | 乱序重放不增加真实异常次数 / WP1 | occurrence_count=2；旧A重放不当新复发；不依赖只比较last_observation | U-SYSTEM-02 | NOT_EXECUTED |
| ALERT-05 | 正常关闭去重与真实越界分开 / WP1 | 前两种被正常门拦无critical；真正越界有critical且停止后续路径；关闭提醒总开关也不隐藏告警 | U-SYSTEM-01, U-WAKE-01 | NOT_EXECUTED |
| ALERT-06 | 错误信息不泄漏私人正文或凭据 / WP1 | 只允许安全摘要及ID/hash计数；私密片段不进日志和公开错误；系统通知不写聊天/hold | U-SYSTEM-01, U-SYSTEM-02 | NOT_EXECUTED |
| ALERT-07 | SDK未核TTL不假报已生效 / WP1 | desired1h与effective unknown分开；一次可聚合未核提醒；没有硬编码requested1h冒充实际 | U-CACHE-02, U-SYSTEM-01 | NOT_EXECUTED |
| ALERT-08 | 独立系统入口与小屏可见 / WP1 | 系统红点可访问名称明确；正常换窗及feed未读不混成故障；后端快照恢复未读而非localStorage单点 | U-SYSTEM-01, U-SYSTEM-02 | NOT_EXECUTED |

## USAGE · 6 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| USAGE-01 | stream/result去重与累计快照 / WP1 | 完整终值保留且只加一次；累计不是新增请求；矛盾终值产生可核异常 | U-TOKEN-02, U-SYSTEM-01 | NOT_EXECUTED |
| USAGE-02 | token完整与费用未知分开 / WP1 | 完整token不被清空；complete_cost为null，known subtotal和unknown count保留；正常不报美元的能力不每条报警 | U-TOKEN-02, U-SYSTEM-01 | NOT_EXECUTED |
| USAGE-03 | OR和SDK缓存token分类不双加 / WP1 | 两者总输入均100；不把OR读80再加到100；按真实provider解释字段 | U-TOKEN-02 | NOT_EXECUTED |
| USAGE-04 | 后台无用户turn、取消和迟到usage仍记账 / WP1 | 费用没有因turn JOIN消失；取消不把已发费用改零；迟到usage按原request去重 | U-SYSTEM-01, U-TOKEN-02, U-WAKE-03 | NOT_EXECUTED |
| USAGE-05 | 跨午夜预算日与观察日不混 / WP1 | 归派发时budget_day；不移动预占或释放到新日；历史无派发时间标legacy来源 | U-SYSTEM-01, U-WAKE-03 | NOT_EXECUTED |
| USAGE-06 | 费用缺失宽限与未知结果恢复 / WP1 | 宽限后告警且预占保留；不发第二次请求来确认费用；有确证才结算/恢复 | U-SYSTEM-01, U-SYSTEM-02, U-WAKE-03 | NOT_EXECUTED |

## TOKEN · 7 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| TOKEN-01 | 混合文字的可见粗估与单一算法 / WP1 | Unicode码点口径和profile版本一致；rough标签可见，不伪称exact；换行正文仍是一条消息 | U-TOKEN-01 | NOT_EXECUTED |
| TOKEN-02 | 单条正文与完整请求输入分开 / WP1 | 本条不等于完整请求；回复上限不叫必然输出；缓存输入仍占上下文，工具续答/重试另计 | U-TOKEN-01, U-TOKEN-02 | NOT_EXECUTED |
| TOKEN-03 | 所有预估均无外部副作用 / WP1 | 模型/外部计数/媒体下载/转写请求均0；无草稿持久化/hold/换窗；request unavailable而本条估计仍可给 | U-TOKEN-01, U-CONTEXT-02 | NOT_EXECUTED |
| TOKEN-04 | 晚到预估不能覆盖新草稿 / WP1 | 只应用匹配draft/model/window/attachment指纹的新值；过期响应丢弃；预览失败不禁正常发送 | U-TOKEN-01, U-MEDIA-01 | NOT_EXECUTED |
| TOKEN-05 | 历史修订保存发送时快照 / WP1 | 旧估计不回写；新revision有新快照；旧缺失只能标当前模型粗估；估计变化不改正文hash | U-TOKEN-01, U-CHAT-01 | NOT_EXECUTED |
| TOKEN-06 | 分段回复实际费用只显示一次 / WP1 | 正文可每条粗估；整轮actual只出现/累计一次；不按字数摊成精确气泡实际token | U-TOKEN-01, U-TOKEN-02 | NOT_EXECUTED |
| TOKEN-07 | 未知图片与转写不双计 / WP1 | 图片总量null且known文字小计保留；不按base64长度估图；只计算实际入模型的转写文字，Siren费用单列 | U-TOKEN-01, U-TOKEN-02, U-MEDIA-02 | NOT_EXECUTED |

## CACHE · 8 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CACHE-01 | OR 直接驱动保持 1h 与禁压缩的最终发包合同 / WP2 | OR 路径不加载或调用 Claude Agent SDK。；最终请求包含 1h 缓存控制和关闭 context-compression 的控制，允许的断点数不超合同上限。；合法追加请求通过；改写旧历史的请求在 transport 前被拒绝。；这些结果只证明本地发包与门控，不证明供应商实际接受了参数或产生缓存命中。 | U-MODEL-01, U-CACHE-01, U-CACHE-02 | NOT_EXECUTED |
| CACHE-02 | 缓存倒计时采用有读写证据的请求开始时间并滚动顺延 / WP2 | 第一次计时依据 10:00 的 dispatch_started_at，不依据响应或 usage 到达时间。；10:35 的有效观测将保温目标移动到 11:25，10:50 不再发送旧维护请求。；11:25 只领取一次当前合法维护机会，估计到期明确标为估计。 | U-CACHE-01, U-TOKEN-02 | NOT_EXECUTED |
| CACHE-03 | 成功 HTTP、缺失 usage 与失败尝试都不能伪造缓存刷新 / WP2 | 单纯收到 200、缺失 cache 字段、明确零读写或失败尝试均不把缓存基准刷新为当前时间。；null 不改成 0，也不改成命中；没有可靠温缓存前提时不产生缓存异常红点。；每次 transport 尝试仍保留派发记录，不额外调用模型诊断或追求命中。 | U-CACHE-01, U-SYSTEM-01, U-TOKEN-02 | NOT_EXECUTED |
| CACHE-04 | 保温最多一个请求且不执行工具、不污染主窗轨迹 / WP2 | 保温仅一次模型请求，工具执行为 0，没有工具续答请求。；保持当前 tools 快照；维护尾消息不进入正式原文、人工选集、hold 书签或主窗规范轨迹。；实际维护请求体及 usage 保留于受保护证据中，不因不推进主窗而被删除。；下一次正常聊天以前一份规范轨迹为比较基准，前缀校验通过。 | U-CACHE-01, U-CONTEXT-01, U-CONTEXT-02 | NOT_EXECUTED |
| CACHE-05 | 聊天或到期自主活动刷新缓存后取消重复保温 / WP2 | 用户聊天先获得执行位，旧保温不排在其前面。；到期自主活动在无用户工作时先于保温执行；新缓存观测取消重复维护机会。；不会为同一旧缓存时点多发送一次保温请求，仍保持单主模型并发约束。 | U-CACHE-01, U-WAKE-03 | NOT_EXECUTED |
| CACHE-06 | 已冷缓存不被后台保温重新付费建立 / WP2 | 恢复时不补跑保温、不进行冷写，记录 KEEPWARM_CACHE_ALREADY_COLD。；未形成新缓存观测前没有反复付费维护尝试。；普通聊天的新观测重新建立未来保温机会，50 分钟后至多执行一次。 | U-CACHE-01, U-WAKE-03 | NOT_EXECUTED |
| CACHE-07 | SDK 与 DS 的未验证能力不能显示为已落实 1h / WP2 | SDK 显示实际证据缺失或 unknown，不能显示已生效 1h；SDK 背景执行被能力门阻断。；DS 显示自动缓存语义，不能借用 OR 固定 TTL 或 50 分钟保证。；无模型页面、关闭开关和普通提醒保持可用。；夹具只验证未验证状态与阻断行为，不作为 SDK 或供应商支持的证明。 | U-MODEL-01, U-CACHE-02, U-WAKE-01 | NOT_EXECUTED |
| CACHE-08 | 真实上游强制插件配置与本地禁压缩冲突必须可见 / WP2 | 观察到强制压缩冲突时阻断受影响背景执行，并产生 UPSTREAM_COMPACTION_POLICY_CONFLICT 的受控告警。；不能因为本地 payload 有 enabled=false 就声称必然覆盖账户规则。；未核实的外部状态保持 unknown，不改模型、不换 TTL、不修改上游账户来伪装成功。 | U-CACHE-02, U-SYSTEM-01 | NOT_EXECUTED |

## CONTEXT · 4 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CONTEXT-01 | 后台达到容量门时必须等待手选原文 / WP2 | 沿用既有容量与选择门，记录 CONTEXT_SELECTION_REQUIRED。；不自动空选、不自动压缩、不注入固定 12k 或日摘要。；等待确认期间没有新的自主或无预算评审模型请求，原文保持可读。 | U-CONTEXT-01, U-WAKE-03 | NOT_EXECUTED |
| CONTEXT-02 | 明确零选只改变新窗输入，不删除原文 / WP2 | 确认 0 条后可以受控换窗；新窗不擅带旧历史、固定上下文段或自动摘要。；原文及修订记录仍存在，未 hold 或未绑定不影响留存。；空选集有真实确认来源，未提交状态不会被同样处理。 | U-CONTEXT-01, U-CONTEXT-02 | NOT_EXECUTED |
| CONTEXT-03 | 静默、午夜和缓存过期不能自动换窗或遗忘 / WP2 | 仅时间变化与缓存冷却不自动更换窗口。；后续聊天继续原窗口，缓存冷却如实展示，不伪造保温成功。；原文和修订没有被摘要替换、清除或根据 hold 状态过滤。 | U-CHAT-01, U-CONTEXT-01, U-CONTEXT-02, U-CACHE-01 | NOT_EXECUTED |
| CONTEXT-04 | 换窗前评审允许不 hold，范围沿用实际已见书签 / WP2 | 评审沿用真实已见清单和成功书签口径，不扫描全库制造漏记任务。；no_new_hold 是可接受结果，不强制创建记忆或反复评审直到有产出。；不增加小模型扫描、滚动摘要或第二套记忆，原文不受影响。 | U-CONTEXT-01, U-CONTEXT-02 | NOT_EXECUTED |

## CHAT · 4 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CHAT-01 | 多行正文、独立发送键与 IME 语义保持 / WP3 | Enter 只换行，IME 确认不发送；只有独立发送按钮创建消息。；多行正文仍是一条消息，只规范化换行，不 trim 或按行拆分。；附件与该消息稳定关联，不改变文字草稿守卫。 | U-CHAT-01, U-CHAT-02, U-MEDIA-01 | NOT_EXECUTED |
| CHAT-02 | 媒体改造后流式、分段、停止和历史重连不回退 / WP3 | 已正式发布的文字和附件仅出现一次，停止后没有新正式气泡。；重连不漏已提交消息，分页不会因加入附件丢失或重排历史。；前端展示顺序与服务器消息序列一致。 | U-CHAT-01, U-MEDIA-01 | NOT_EXECUTED |
| CHAT-03 | 附件发送保持原子事务和完整请求幂等 / WP3 | 空文字只有具备有效附件才允许发送；无效附件不会形成半条正式消息。；同键同指纹返回原结果，同键不同指纹返回冲突。；成功只有一套完整记录，失败事务不留下半套 side effects。 | U-CHAT-01, U-MEDIA-01 | NOT_EXECUTED |
| CHAT-04 | 文字编辑保留附件修订与既有原文 hash / WP3 | 第一次修改产生一条新 revision；合法重放不再增加 revision；新操作的过期版本被拒绝。；新旧版本均保留正确附件，旧引用不被删除。；content_hash 继续只使用既有文字算法，附件指纹和估计元数据不会改变旧 hash。 | U-CHAT-01, U-MEDIA-01, U-CONTEXT-02 | NOT_EXECUTED |

## MEDIA · 11 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| MEDIA-01 | 资产上传、授权读取与重启后字节一致 / WP3 | 仅实际保存及校验成功后返回 available 和稳定 asset_id。；前后字节 hash 一致，不依赖浏览器 Blob URL。；表名为 media_assets，HTTP 资源名仍为 assets；响应不泄漏绝对路径或凭据。 | U-MEDIA-01, U-MEDIA-03 | NOT_EXECUTED |
| MEDIA-02 | 大小、类型和保存失败不会产生假成功资产 / WP3 | 分别返回稳定的大小、类型或保存错误，不把 pending/failed 标为 available。；只清理本次临时文件，不损坏既有媒体。；失败资产不能变成正式消息附件，日志没有二进制或私人正文。 | U-MEDIA-01 | NOT_EXECUTED |
| MEDIA-03 | 图片 URL 是导入来源，已有资产发送不重复搬文件 / WP3 | 源 URL 失效不影响已保存文件，结果引用稳定 asset_id。；发送已有资产不重新下载或复制图片文件。；重放不创建第二份逻辑资产或重复气泡。 | U-MEDIA-03, U-MEDIA-01 | NOT_EXECUTED |
| MEDIA-04 | URL 导入限制实际连接目标和凭据传播 / WP3 | 不允许的目的地不会被实际连接；每跳重新校验且检查结果与实际连接一致。；不转发 est 会话 token 或其他站点 Cookie。；可信服务只接受自身资源 ID 或受约束路径，不能被模型当作任意内网代理。 | U-MEDIA-03, U-EXT-07 | NOT_EXECUTED |
| MEDIA-05 | 图片真实进入驱动输入，未知视觉能力明确阻断 / WP3 | 支持分支含正确视觉块及对应图片内容，不是 URL 普通文字或只有资产元数据。；未支持分支保存本地消息但返回 MODEL_VISION_UNAVAILABLE，不丢图后继续回答或静默切换型号。；本用例证明输入接线，不把离线 payload 检查写成真实模型识图验收。 | U-MEDIA-02, U-MODEL-01 | NOT_EXECUTED |
| MEDIA-06 | 历史选择与原文回读携带正确 revision 的媒体 / WP3 | 真实语音/贴纸不因旧 kind 过滤被拒；空正文图片没有被当作空记录跳过。；装载对应固定 revision 的附件，旧版本不被当前附件替换。；仅实际送入视觉块的资产记录为已见，元数据读取不冒充看图。 | U-MEDIA-01, U-MEDIA-02, U-CONTEXT-01 | NOT_EXECUTED |
| MEDIA-07 | 助手附件发布保持顺序并能恢复未知结果 / WP3 | 附件仅发布一次，不被普通分段逻辑再发一遍。；先文字、附件、后文字按真实发布顺序保存。；未知结果先回查原操作，不换新键重复发布。 | U-MEDIA-01, U-MEDIA-03, U-CHAT-01 | NOT_EXECUTED |
| MEDIA-08 | 语音原件、转写来源和贴纸显示形成完整本地链 / WP3 | 原音频持久保存，转写明确为派生内容，不改成用户亲自输入的正文。；转写失败保留音频/草稿或待处理状态，不空输入调用模型。；贴纸无需先填写含义即可发送；本地用例不声称 Siren 已真实接通或通话已完成。 | U-MEDIA-01, U-EXT-02 | NOT_EXECUTED |
| MEDIA-09 | 纪念代码文件可持久保存且不会在宿主执行 / WP3 | 文件持久保存，重放复用原结果，同键不同内容冲突。；没有 shell、构建或代码执行，也没有任意 URL 请求。；纪念用途的格式许可不自动扩大聊天附件许可，本用例不自动发布作品记录。 | U-CREATION-01, U-MEDIA-03 | NOT_EXECUTED |
| MEDIA-10 | 本地资产引用守卫保护历史 revision 和 pending pin / WP3 | 历史消息 revision 仍引用时返回 ASSET_REFERENCED，文件不被删除。；protected pin 在结果未知时继续保护文件，不因超时自动释放。；合法重放返回原解除回执，越权不能取得或执行他人引用操作。 | U-MEDIA-01, U-CONTEXT-02, U-ALBUM-04 | NOT_EXECUTED |
| MEDIA-11 | 共享媒体授权与直接打开 active MIME 的隔离 / WP3 | created_by 只记录来源，不把双方共享资产变成创建者独占；未授权读取仍被拒绝。；直接打开和 iframe 预览都不能获得 est 主站凭据或内容写权限。；尚未实现安全预览的 active MIME 只能下载并明确标未支持预览。 | U-MEDIA-01, U-MEDIA-03, U-CREATION-01 | NOT_EXECUTED |

## BACKGROUND · 17 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| BACKGROUND-01 | 安装与升级默认关闭后台收费但保留显式提醒 / WP4 | autonomous=false、keepwarm=false、两个 daily_cost_cap_usd=null，没有后台模型或外部收费请求。；创建的普通提醒按自身开关投递，不被后台收费默认关闭误伤。；迁移不恢复死 wakeups、旧摘要表或隐式后台流程。 | U-WAKE-01, U-WAKE-02, U-CACHE-01 | NOT_EXECUTED |
| BACKGROUND-02 | 前端三开关与服务端有效状态一致并持久化 / WP4 | 预算缺失时启用被拒绝，页面不显示后台已有效开启。；三个开关独立；普通提醒与现有换窗 hold 提醒开关不混淆。；设置持久化且页面显示实际阻断原因，不只有按钮本地变化。；关闭文案说明已产生费用和已完成动作保留，不宣称退款或撤回。 | U-WAKE-01, U-WAKE-02, U-CACHE-01 | NOT_EXECUTED |
| BACKGROUND-03 | 滚动 60 分钟在多任务与跨房间下仍统一 / WP4 | 11:01 的新一轮被冷却门阻止，不能按钟表小时分桶绕过。；同主体的任务、任务 ID 或房间变化不重置冷却。；只有到达合法时间后才允许下一轮，显示的 effective_due_at 与门控一致。；created_by不同不改变actor_id执行主体，不获得第二份60分钟额度 | U-WAKE-02, U-WAKE-03 | NOT_EXECUTED |
| BACKGROUND-04 | 相同 occurrence 并发领取只产生一个 owner 和派发 / WP4 | 最多一条有效 owner 和一次实际派发，不因随机 run ID 绕过 occurrence 去重。；被唯一约束正常阻止的重复领取只留去重诊断，不被当作真实重复收费。；已完成 occurrence 重放不再次执行。 | U-WAKE-03, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-05 | 关闭自动唤醒能拦住预占后和重试中的竞态派发 / WP4 | 关闭接口返回后不再启动新的自主 transport、重试或下一工具。；尚未发送的预占按真实证据释放；已开始动作不伪造撤销或退款。；正常门控拦截记录取消原因与设置版本，不当作关开关本身的系统故障。 | U-WAKE-01, U-WAKE-03, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-06 | 用户输入优先抢占正在执行的后台活动 / WP4 | 用户输入入库后立即请求取消可取消背景步骤。；背景活动不继续占据长工具链；用户在已有取消宽限内取得执行位。；仍只有一个主模型执行位，待处理保温重新核定而不是抢在聊天前面执行。 | U-CHAT-01, U-WAKE-03 | NOT_EXECUTED |
| BACKGROUND-07 | 自主 no-op 正常结束且不会自动发出最终说明 / WP4 | 两种无动作完成都可正常记录为 noop，不强制写原因、消息、图片或 hold。；普通最终说明不自动发布到私聊或朋友圈。；本轮没有因无产出重试，下一轮仍遵守原冷却。 | U-WAKE-03, U-FEED-02, U-CONTEXT-02 | NOT_EXECUTED |
| BACKGROUND-08 | 工具续答与 driver 内部重试全部进入同一预算 / WP4 | 429、重试和续答均有独立 dispatch，携带同一 run，共累计 3 次。；输出与 reasoning 累计进入原整轮预算，工具批次各项分别计数。；第四次请求在 transport 前被阻止，不因新 purpose 或新逻辑步骤取得额度。 | U-WAKE-03, U-TOKEN-02, U-SYSTEM-01 | NOT_EXECUTED |
| BACKGROUND-09 | 外部付费默认门不能由模型声明绕过 / WP4 | 免费日常工具按身份正常使用。；收费工具在总门关闭时不派发，模型参数不能改写适配器计费属性。；费用上界未知时即使允许付费工具也不派发，不把 unknown 当免费。 | U-WAKE-03, U-SYSTEM-01 | NOT_EXECUTED |
| BACKGROUND-10 | 未知费用保持预占，余额不足时不能继续派发 / WP4 | 未知期间 70 的预占不释放，第二笔在派发前被阻止。；真实回执结算后按实际余额重新计算，不能双重累计或双重释放。；界面分别显示已知费用和未核实额度，不将未知费用或总费用补零。 | U-WAKE-03, U-TOKEN-02, U-SYSTEM-01 | NOT_EXECUTED |
| BACKGROUND-11 | 外部动作超时后只能核实结果，不能自动收费重放 / WP4 | 动作先保持 unknown 和费用预占，不将超时等同未执行。；关闭期间不重新执行收费动作，但允许不收费的结果查询和结算。；收据只结算原操作，已完成资产或消息不重复生成。 | U-WAKE-03, U-SYSTEM-01, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-12 | 重启不会补跑积欠自主活动或重复已发请求 / WP4 | 未发送孤儿可标 skipped；已开始而结果不明的执行保留 unknown 及预占。；周期任务只计算未来合法时刻，不补跑过去每小时。；重复恢复不会重发已经开始的模型或收费工具；只允许有界不收费核实。；向后跳不缩短冷却，暂停新后台收费并报告CLOCK_OR_RECOVERY_UNCERTAIN；向前跳不补跑 | U-WAKE-03, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-13 | 普通提醒不受自主冷却和保温开关限制 / WP4 | 预写提醒按时投递，不需要主模型生成且不占用自主机会。；同 occurrence 只投递一次，使用统一投递幂等服务。；不因提醒投递而开启自主或保温，模型请求数为 0。 | U-WAKE-01, U-WAKE-02, U-CALENDAR-03 | NOT_EXECUTED |
| BACKGROUND-14 | 提醒关闭与过期宽限不会隐藏故障或批量补推 / WP4 | 过期提醒保留可见的错过状态，不在重新开启后批量补推。；系统异常与未核实费用不受普通提醒开关隐藏或自动解决。；整个过程无主模型调用。 | U-WAKE-02, U-SYSTEM-01, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-15 | 取消后迟到用量仍计账但迟到公开输出被挡 / WP4 | 取消后的新公开文本及工具动作不再发布或执行。；真实迟到 usage 仍记到原 request／run，只累计一次。；停止不清零已发生费用，也不把当前运行后续步骤重新启动。 | U-WAKE-01, U-WAKE-03, U-TOKEN-02 | NOT_EXECUTED |
| BACKGROUND-16 | 幂等重试先查合法回执，再判断新操作版本 / WP4 | 合法相同操作重放返回原回执，不因当前版本已增长而误拒或再次执行。；相同 key 不同业务载荷被拒；没有可重放回执的新操作才按统一合同检查 If-Match。；鉴权在回执查询前生效，无权主体不能读取或重放他人结果。；工具映射复用同一幂等与版本服务，不形成不同语义。 | U-WAKE-01, U-WAKE-02, U-SYSTEM-02 | NOT_EXECUTED |
| BACKGROUND-17 | 后台预评审与自主请求共用整轮额度 / WP4 | 预评审与自主请求携带同一 background_run_id，虽然 purpose 不同，请求／输出／时长／费用仍归同一预算。；两次请求合计为 2，第三次在 transport 前被阻止。；等待人工选集时不另起一个无背景预算的评审请求。 | U-CONTEXT-01, U-CONTEXT-02, U-WAKE-03, U-TOKEN-02 | NOT_EXECUTED |

## CONTENT · 9 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CONTENT-01 | 一个可选内容服务停机不阻断聊天，并如实显示不可用 / WP5 | 浏览器只经 est 的既有会话访问 /api/v1/content/*；content 仅监听 loopback，端口可配置。；内容故障不阻断聊天和历史；已打开页面显示内容服务不可用，不能伪装为空列表。；恢复后原内容仍在；albums、feed、creations、future-notes 共用一个 content 服务和一个 SQLite，无每功能新服务器。；端口冲突不静默启动另一份服务或改用未知地址。 | U-CHAT-01, U-FEED-01, U-ALBUM-02, U-CREATION-01 | NOT_EXECUTED |
| CONTENT-02 | 作者由真实宿主身份派生，拒绝冒充与第三方访问 / WP5 | 前端真实身份映射为 qiaosheng，模型工具真实身份映射为 jiaming，显示名分别为江乔生、周家明。；客户端伪造身份头被移除，body、query 或工具自报作者均不能改变可信作者；维护上下文不能默认冒名发言。；content 验证内部凭据与双人 actor 集合；无权限请求返回明确拒绝且没有内容写入。；双方读取未来留言不等于获得以对方身份安排投递的权限。 | U-FEED-01, U-ALBUM-02, U-CALENDAR-03 | NOT_EXECUTED |
| CONTENT-03 | 全部内容写入遵守幂等键和精确版本合同 / WP5 | 每个同 key 同请求最多产生一个业务结果；同 key 不同请求返回 idempotency_conflict。；同版本并发写最多一方成功；版本冲突不覆盖正文、不改任务、不释放资产。；新增 HTTP 副作用必须有 Idempotency-Key，PUT/DELETE 还必须有精确 If-Match；读取或写入返回对应 revision/ETag。；无效头部和重复控制字段被明确拒绝；工具与 HTTP 复用同一业务实现，已成功操作的重试返回原结果。 | U-FEED-01, U-ALBUM-02, U-CREATION-01, U-CALENDAR-03 | NOT_EXECUTED |
| CONTENT-04 | 媒体引用跨服务中断后恢复，已发布附件不被回收 / WP5 | 明确成功只保留一个内容对象，正文与附件集合在 content 本地事务一起提交。；状态未知时保留保护；新增附件先 pin，旧附件在内容成功更新后才释放，失败不使旧内容丢图。；恢复可收敛引用；删除一处不会破坏聊天或其他内容引用，GC 不误删仍受保护资产。；字节、引用账本和补偿记录归 est；content 不同步反调 est，不另建永久文件仓库、队列或协调服务。 | U-MEDIA-01, U-ALBUM-04, U-FEED-01, U-CREATION-01 | NOT_EXECUTED |
| CONTENT-05 | 未来留言正文与一次性调度分责，安排失败不冒充成功 / WP5 | content 保存作者、正文、附件和版本；est 保存 source_ref、目标时间及执行状态，没有第二份可独立编辑的留言正本。；第二步失败明确显示留言已保存但尚未安排；同操作恢复不重复正文或任务。；第一版使用现有 kind=reminder、schedule_kind=once；同一留言最多一条启用且未完成的任务。；仅保存不触发投递；日期缺少时间时使用界面已明确展示的配置默认时间，不能偷偷选择当前时刻。 | U-CALENDAR-03, U-WAKE-02 | NOT_EXECUTED |
| CONTENT-06 | 未来留言冻结版本确定，编辑不会改写已发消息 / WP5 | 冻结前编辑可被本次投递读取；冻结后本次保持已冻结作者、正文、附件、note ID 和 revision。；后改源留言不改写已发消息；未来再次明确安排可读取新版，不能伪称修改了历史消息。；消息保留真实作者，qiaosheng 的留言不能变成 jiaming 回复。；普通留言走既有消息保存/展示层，不调用模型补文，也不因用户角色自动启动模型。 | U-CALENDAR-03, U-WAKE-02, U-CHAT-01 | NOT_EXECUTED |
| CONTENT-07 | 停止或删除先于投递提交时阻止发送，失败结果如实返回 / WP5 | 停止或删除先取得 fence 时，最终提交重新核对后不产生消息。；鉴权或版本校验失败不提前取消任务、不释放媒体、不改正文。；取消成功而源删除失败明确返回部分完成，保持投递停止；同 key 恢复完成原操作。；重启后已删除留言的孤儿任务不能继续发送；没有新调度器或锁服务。 | U-CALENDAR-03, U-WAKE-02, U-ALBUM-04 | NOT_EXECUTED |
| CONTENT-08 | 投递先提交或收据未知时保持单消息且不虚报撤回 / WP5 | 提交先完成时返回 already_committed 与允许读取的 message ID；后删源留言不撤回或改写历史。；重复回调与未知结果恢复只产生一条最终消息，不能因读取到新 revision 或重试而更换发送 ID。；结果未知显示待核实；仅 outbox 接受显示待投递，不能宣称已送达或手机已收到。；已发消息的附件继续受保护；源留言自己的引用移除不会破坏历史消息。 | U-CALENDAR-03, U-CHAT-01, U-MEDIA-01 | NOT_EXECUTED |
| CONTENT-09 | 到期无法读取留言时不发空消息，恢复遵守现有宽限 / WP5 | 读取失败或不完整时不保存空消息、不猜正文、不调用模型补文，也不写成功状态。；错误、暂不可达和已错过按既有规则可见；有界恢复不无限补发，不突发发送积压留言。；任务开关、总开关、可信作者、会话权限及 fence 在最终投递前仍有效。；content 不拥有定时器；恢复复用 est 现有任务和消息链。 | U-CALENDAR-03, U-WAKE-02 | NOT_EXECUTED |

## FEED · 6 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| FEED-01 | 双方经真实入口互相看帖、发帖和评论 / WP5 | 双方都可查看、发布和评论；作者显示与可信 actor 一致，图片引用可重读。；普通帖和 letter 使用同一评论机制，没有因发帖入口不同而形成另一份帖子。；未认证访问不可见；不需要额外建立第二个账号体系。 | U-FEED-01, U-FEED-02 | NOT_EXECUTED |
| FEED-02 | 本人帖子和评论可编辑删除，另一人的内容拒绝修改 / WP5 | 本人操作成功并递增 revision；删除按合同留下必要墓碑。；另一人的内容返回 forbidden，不能借帖子所有权获得删除对方评论的权限。；拒绝不产生正文、版本或引用变动，维护能力不隐式参与日常操作。 | U-FEED-01 | NOT_EXECUTED |
| FEED-03 | 删除帖子保留他人评论，移除原文附件并禁止新增评论 / WP5 | 删除后的普通接口不再暴露原帖子正文、标题和自身附件关联。；乙的评论不被级联删除，保留可解释的帖子墓碑；新增评论返回 parent_deleted。；无评论墓碑不占普通列表；其他对象引用的媒体仍可读取。；删除帖子的操作不会替乙删除或编辑评论。 | U-FEED-01, U-MEDIA-01 | NOT_EXECUTED |
| FEED-04 | 评论和帖子稳定分页，独立评论工具可读完全部 / WP5 | 帖子按 published_at 与 id 降序，评论按 created_at 与 id 升序，游标遍历无重复或遗漏。；首次遍历上界固定；新内容由刷新读取，编辑不重排已读序列。；游标绑定资源、筛选和排序，跨范围复用被拒；超限明确返回参数错误。；前端和工具都能跟随 next cursor 读完评论，保留准确 has_more。 | U-FEED-01 | NOT_EXECUTED |
| FEED-05 | 发表时间独立，letter 只改变展示且不恢复旧系统 / WP5 | published_at 由服务端确定并保持不变；编辑只更新 updated_at/revision，不能把旧帖顶为新发表。；未来留言的 created_at 不作为帖子发表时间，也不自动出现在 feed；第一版不存在隐式草稿定时发布。；post/letter 共享 feed_posts 正本和评论机制，只改变 presentation。；发 letter 不调用 Mariposa 旧 letter 能力，不自动建桶或 hold。 | U-FEED-02, U-CALENDAR-03, U-CONTEXT-02 | NOT_EXECUTED |
| FEED-06 | 自愿分享可正常不发帖，新朋友圈与扎西德勒完全分开 / WP5 | 无分享正常结束，不出现欠交、强制补发、催交或小模型检查。；两种朋友圈不共用帖子/评论正本，不默认同步或转发；失败不自动向另一个服务发布。；content 不创建自主模型定时器，明确发帖仍经同一宿主工具与身份控制。；新 feed 仅为双人私密空间，无公众主页、关注或推荐流。 | U-FEED-01, U-FEED-02, U-WAKE-03, U-EXT-04 | NOT_EXECUTED |

## ALBUM · 5 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| ALBUM-01 | 周家明可独立归档重要照片，真实资产可长期重读 / WP5 | 导入保存真实字节及稳定资产，而非仅保留临时外链；两种作者均能通过各自入口完成归档。；原 URL 失效及重启后图片仍能读取，来源和备注可追溯。；已有资产仅新增关联，不重新下载或复制永久文件；content 只保存 asset_id 和元数据。 | U-MEDIA-03, U-MEDIA-01, U-ALBUM-02 | NOT_EXECUTED |
| ALBUM-02 | 共享相册移除无需逐项审批，其他正本与引用不被连删 / WP5 | 双方可以维护和移除共享相册归档；依赖正常认证、版本和幂等合同，不增加逐项审批流程。；移除只解除该相册条目与其关联，不修改或删除 our_words、桶、原文。；仍被聊天、帖子或其他内容使用的图片继续存在，不能把归档删除误作物理删除。 | U-ALBUM-04, U-ALBUM-01, U-ALBUM-02, U-MEDIA-01 | NOT_EXECUTED |
| ALBUM-03 | 从我们的话真实搜索结果按稳定 ID 反查绑定截图 / WP5 | 反查按 service、kind、source_id 的完整稳定引用命中，仅返回真实绑定截图。；游标绑定源对象及筛选，跨引用使用被拒；大于一页可完整读取。；话的正文与搜索权威留在 Mariposa，content 保存引用与截图信息，不复制新的可编辑正文正本。；源不可达与明确不存在分开报告，不把未核验的拟议 DTO 声称为外部既有 API。 | U-ALBUM-01, U-EXT-01 | NOT_EXECUTED |
| ALBUM-04 | 表情含义可搜索并发送，图检索和生图均可替换 / WP5 | 人工定义的含义立即可用于文本搜索；没有含义允许后补，不自动编造固定解释。；选择后发送的是可重读的真实 asset 引用，不能仅发一串不受保护的临时链接。；第一期含义检索可独立运行，不要求付费生图或特定 embedding 模型。；外部生成或多模态检索保留可替换适配边界，没有提供时如实显示能力状态。 | U-ALBUM-03, U-VISUAL-01, U-MEDIA-01 | NOT_EXECUTED |
| ALBUM-05 | 相册资产和源引用先校验，重复归档不覆盖共享说明 / WP5 | 必要资产及完整关联验证全部成功后才提交内容，不把校验失败的引用悄悄丢掉并报告成功。；不存在、无权与暂不可达给出各自准确错误；先前独立上传的有效资产可以保留但不冒充归档成功。；同 kind、asset_id 只有一条归档；重复添加返回已有条目，不暗中覆盖另一人的说明或含义。；修改已有说明须显式更新并经过版本校验。 | U-ALBUM-01, U-ALBUM-02, U-MEDIA-03 | NOT_EXECUTED |

## CREATION · 5 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CREATION-01 | 纪念作品自愿建立，只有图标也能直接打开原桶 / WP5 | 新桶不自动产生待创作任务、作品债务或强制动画；没有纪念记录属于正常状态。；图标加稳定桶引用是有效记录，作品字段成对省略即可。；图标入口直接定位源桶，沿已有明确打开流程；content 不复制桶正文或另造桶。；双方可经各自入口创建，默认只有创建者可更新或删除自己的纪念记录。 | U-CREATION-01, U-CREATION-02 | NOT_EXECUTED |
| CREATION-02 | 后补作品沿用原纪念记录与真实事件日期 / WP5 | 后补更新原记录和原 bucket_ref，不创建重复桶、待办或新的发生事件。；作品和桶显示源服务的真实 event_date，不能取上传日、created_at 或 updated_at。；源日期更正后聚合按当前正本反映；content 不持有独立可编辑的事件日期正本。；没有作品的记录仍有效，不被计为欠交。 | U-CREATION-02, U-CALENDAR-02 | NOT_EXECUTED |
| CREATION-03 | 小作品保存不执行，查看器不能访问会话或宿主写能力 / WP5 | 保存只是受限文件入库，不在服务端执行；content 只关联资产。；HTML 在隔离 sandbox 与 CSP 中运行，无宿主会话、写 API、任意网络或顶层跳转权限。；postMessage 按来源 iframe、实例和允许事件校验，不能信任作品自报 URL。；图标 SVG 按安全图像展示，不直接插入可执行原始 DOM。 | U-CREATION-01, U-MEDIA-01 | NOT_EXECUTED |
| CREATION-04 | 作品详情可读取，播放结束和异常时都有准确原事件入口 / WP5 | 详情工具与 HTTP 返回真实作品引用，不只返回列表摘要。；播放结束显示醒目的事件入口；随时可返回，不要求强制看完。；播放失败仍保留原事件入口，源桶不存在与暂时不可读的提示明确不同，本地作品仍保留。；预加载、打开作品或播放完成本身不调用 memory_open/view.confirm；明确打开桶才按既有语义确认一次。 | U-CREATION-01, U-CALENDAR-02 | NOT_EXECUTED |
| CREATION-05 | 游戏和情绪保持已批准的最小延期边界 / WP5 | 游戏厅真实展示空状态或作品入口，不虚构已有游戏、积分、排行榜、实时服务器。；只呈现实际允许的心情标签、来源和时间；无记录不补中性，历史不冒充当前。；情绪维度和数值模型保持待定，不从聊天或作品自动推导；自由心情文字仍受原读取边界约束。；空白和未创作不制造待办或欠交；该项只验延期边界，不宣称未实现的游戏或数值模型已完成。 | U-GAME-01, U-EMOTION-01, U-CREATION-02 | NOT_EXECUTED |

## CALENDAR · 7 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| CALENDAR-01 | 月历只读跨源摘要，单源故障如实降级 / WP6 | 月视图按自然月按需取计数/标记，不下载整月聊天正文、桶全文或星星正文。；独立源失败保留其他源结果并明确部分不可用，不能把未知计数显示成 0。；无法取得精确数量时如实表达有内容但计数未加载；单源不可达返回 source_unavailable 等准确语义。；聚合仅保存可重建读缓存或引用，不成为外部可编辑正本。 | U-CALENDAR-01, U-EXT-01, U-EXT-06 | NOT_EXECUTED |
| CALENDAR-02 | 日详情分源稳定分页，不把一页当成当天全部 / WP6 | 日概要与各源条目分开，分页后可读完有效范围，准确保留 next cursor/has_more。；不透明 keyset 游标绑定日期、来源、筛选、排序和遍历上界，不因新增或编辑重复漏项。；跨范围游标、无效日期、超限明确报错；默认 20、最大 100。；前端保留继续读取入口，尚有下一页时不能标成当天全部。 | U-CALENDAR-01, U-CALENDAR-02 | NOT_EXECUTED |
| CALENDAR-03 | 北京时间自然日采用半开区间并跨内部聊天窗口 / WP6 | UTC 范围为 [2026-10-10T16:00:00Z,2026-10-11T16:00:00Z)，包含当日 00:00，排除次日 00:00。；毫秒边界不被日期截断或本机 UTC 时区误算。；完整当天聊天涵盖内部窗口切换及未 hold 消息；不依赖当前模型上下文或缓存存活。；原始消息时间不被日历转换改写。 | U-CALENDAR-01, U-CALENDAR-02, U-CHAT-01, U-CONTEXT-02 | NOT_EXECUTED |
| CALENDAR-04 | 事件按真实发生日归属，写入日和农历不被静默替代 / WP6 | 桶和作品按源真实 event_date 归属，不用 created_at、updated_at、published_at 或导入日替代。；未知事件日期保持未归属，不推定为创建日或今天；源日期更正按正本反映。；公历年度重复按已明确合同处理；农历未核验时不静默当公历或猜转换。；后补作品不生成第二个事件或复制桶。 | U-CALENDAR-01, U-CALENDAR-02, U-CREATION-02, U-CALENDAR-04 | NOT_EXECUTED |
| CALENDAR-05 | 相关原文和当天全部聊天分开，读取预取不触发打开确认 / WP6 | 相关原文按源绑定引用精确定位，允许跨天；当天全部入口按自然日读完整聊天，两者不能互相替换。；未 hold 闲聊仍能在当天完整聊天中读取；内容服务不保存新的可编辑原文正本。；列表、关联校验、搜索、预取和作品播放不触发打开或续期确认。；明确打开桶才复用已有确认语义，页面与代理不能各确认一次。 | U-CALENDAR-02, U-CONTEXT-02, U-EXT-01 | NOT_EXECUTED |
| CALENDAR-06 | 星星仅按重要日期显示，所有日历读取和提醒预览均不消费 / WP6 | 只有源既有重要日期产生标记，create 日不自动成为拆星日。；日历读取、预加载和提醒展示均不取下一颗、不确认、不消费会话，不读取未允许星正文作预览。；刷新前后剩余数量、取星状态与确认状态完全一致；提醒投递不等于星已拆。；显式进入仍遵守原服务流程；未核验时保留待接状态，不能用模拟行为声称外部已接通。 | U-CALENDAR-04, U-EXT-06 | NOT_EXECUTED |
| CALENDAR-07 | 计划正本在 Mariposa，提醒投递不改变计划完成状态 / WP6 | 正式计划正文、状态和安排日期只在 Mariposa 修改，est 保留任务执行信息，content 留言正文保持单一正本。；目标日展示来自计划/任务各自权威时间；提醒投递成功不自动把 plan 标为完成。；预写提醒和留言无需额外模型；保存、待投递、已保存到聊天和手机推送结果各自如实报告。；只有站内实时提醒或推送能力未支持时不能宣称离线手机系统提醒已送达。 | U-CALENDAR-03, U-WAKE-02, U-NOTIFY-01, U-EXT-01 | NOT_EXECUTED |

## INTEGRATION · 11 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| INTEGRATION-01 | Mariposa 既有 HTTP 与媒体原文合同逐项核实 / WP7 | 保留既有 /api/capability HTTP 面及凭据边界，不为统一名词改造为 MCP。；不擅发新增 published_kind 或未支持资产对象，含附件消息不能用 assets 空数组宣称完整归档。；合同缺失登记 blocked，保留本地完整事实；离线行为证据不冒充 Mariposa 真实 ACK。 | U-EXT-01, U-MEDIA-01, U-CONTEXT-02 | NOT_EXECUTED |
| INTEGRATION-02 | Siren 转写、完整语音归档和流式通话分别核验 / WP7 | 选择真实存在的 HTTP/MCP 业务入口，实时通话按真实流协议接线。；音频字节生成成功不等于聊天归档/历史可播放，语音条完成不等于实时通话完成。；未核的接口保持 blocked；fixture 成功只证明 est 适配代码。 | U-EXT-02, U-MEDIA-01 | NOT_EXECUTED |
| INTEGRATION-03 | oído 按真实 MCP 接缝预留而不内置听觉管线 / WP7 | 听觉/频谱业务保留在 oído，est 只做工具适配与结果入口。；只填地址不能标记已接通；未知传输/schema 返回 INTEGRATION_CONTRACT_UNVERIFIED。；没有用假工具列表代替 oído 实际合同证据。 | U-EXT-03 | NOT_EXECUTED |
| INTEGRATION-04 | 扎西德勒 MCP 工具按现有业务隔离接入 / WP7 | 扎西德勒继续独立服务，工具目标由明确服务注册决定。；与新私密朋友圈不共用发布目标或默认同步，不在失败后改投另一个空间。；只有真实协议和接线证据齐备才报告对应能力已接通。 | U-EXT-04, U-FEED-01 | NOT_EXECUTED |
| INTEGRATION-05 | Antinomy 共度能力复用现有正本与参与者身份 / WP7 | 书籍、进度、批注等业务正本仍在 Antinomy，est 只接入口和授权工具。；双方身份与进度不被混用。；合同或连接未核明确 blocked，离线不会返回空书架冒充正常。 | U-EXT-05 | NOT_EXECUTED |
| INTEGRATION-06 | Superposition 日期读取与状态改变工具分清合同 / WP7 | 日历/提醒接缝只映射只读重要日期与安全入口，不指向取下一颗或确认消费操作。；拆星动作继续服从原服务邀请与确认合同。；未知协议不启用动作，不用 fixture 宣称真实星星流程联调成功。 | U-EXT-06, U-CALENDAR-04 | NOT_EXECUTED |
| INTEGRATION-07 | X 和小红书复用用户已有外部浏览架构 / WP7 | 不在 est 重新建立爬虫、浏览器账号或社交平台业务库。；本包没有新增站外社交发布，读取结果与可导入媒体按受控合同返回。；外部故障只影响该能力；未核访问不能以假搜索结果补齐。 | U-EXT-07 | NOT_EXECUTED |
| INTEGRATION-08 | MCP 客户端实际完成协议生命周期和结果转换 / WP7 | 发生真实协议往返，不是配置静态工具表后直接返回 PASS。；未允许工具不自动开放，图片/资源结果不变成普通 Base64 正文。；取消与未知写结果有明确处理，不盲目重复；只将此结果计作 MCP 客户端离线验收。 | U-MODEL-01, U-EXT-03, U-EXT-04, U-MEDIA-01 | NOT_EXECUTED |
| INTEGRATION-09 | OR 与 SDK 的工具装配分别证明，未接驱动不假通过 / WP7 | OR 工具适配不依赖 SDK 路径；Mariposa 继续沿已有 HTTP 客户端。；SDK 映射未实现时明确 blocked，不能只删除旧门后静默丢工具。；每个驱动独立报告接线状态，没有动态执行远端代码的万能调用器。 | U-MODEL-01, U-EXT-01, U-EXT-03, U-EXT-04 | NOT_EXECUTED |
| INTEGRATION-10 | 站内到时可见与离线手机系统推送分别验收 / WP7 | 站内页面可见不能被登记为离线手机推送已完成。；未支持/未配置推送明确显示对应状态，不用网页红点冒充系统通知。；没有经过授权的真实手机接收证据前，真实推送状态保持未验证；fixture 只证明适配。 | U-NOTIFY-01 | NOT_EXECUTED |
| INTEGRATION-11 | 生图与图像检索使用已核外部合同且不虚构能力 / WP7 | 不锁定未经核实的型号，不把向量检索写成图片生成能力。；图片先持久保存为 asset_id，结果未知先查询原任务，不重新创建计费任务。；文本含义检索可独立可用，外部多模态能力未核则如实待核，不阻塞基本聊天。 | U-VISUAL-01, U-MEDIA-03 | NOT_EXECUTED |

## DELIVERY · 3 项

| ID | 场景 / 批次 | 必须观察到的结果 | 需求 | 初始状态 |
| --- | --- | --- | --- | --- |
| DELIVERY-01 | 备份恢复覆盖两个DB和媒体 / WP8 | 消息/feed/revision/已读/后台未知账本一致；资产可读、无孤立活跃引用；不靠复制活跃WAL主文件伪称备份 | U-CHAT-01, U-CONTEXT-02, U-ALBUM-04, U-FEED-01 | NOT_EXECUTED |
| DELIVERY-02 | 跨模块一条完整离线链 / WP8 | 图片和修订保留；双向内容作者准确；只读不拆星/hold；关闭后无后续付费，新告警与未知费用重启不丢 | U-MEDIA-01, U-CONTEXT-01, U-WAKE-01, U-FEED-01, U-CALENDAR-01, U-SYSTEM-02 | NOT_EXECUTED |
| DELIVERY-03 | 最终报告不把mock当实机 / WP8 | 代码/离线测试/实机状态分开；未知依赖精确列字段与能力；没有自填PASS、生产部署或付费调用混入离线证据 | U-MODEL-01, U-EXT-03, U-EXT-04, U-NOTIFY-01 | NOT_EXECUTED |

## 需求反查

| 需求 ID | 用户要求 | 场景 ID |
| --- | --- | --- |
| U-CHAT-01 | 文本聊天与连续历史 | BASE-03, TOKEN-05, CONTEXT-03, CHAT-01, CHAT-02, CHAT-03, CHAT-04, MEDIA-07, BACKGROUND-06, CONTENT-01, CONTENT-06, CONTENT-08, CALENDAR-03, DELIVERY-01 |
| U-CHAT-02 | 输入语义 | CHAT-01 |
| U-MEDIA-01 | 图片/贴纸/语音消息 | TOKEN-04, CHAT-01, CHAT-02, CHAT-03, CHAT-04, MEDIA-01, MEDIA-02, MEDIA-03, MEDIA-06, MEDIA-07, MEDIA-08, MEDIA-10, MEDIA-11, CONTENT-04, CONTENT-08, FEED-03, ALBUM-01, ALBUM-02, ALBUM-04, CREATION-03, INTEGRATION-01, INTEGRATION-02, INTEGRATION-08, DELIVERY-02 |
| U-MEDIA-02 | 主模型真正看图 | TOKEN-07, MEDIA-05, MEDIA-06 |
| U-MEDIA-03 | 周家明独立保存图片 | MEDIA-01, MEDIA-03, MEDIA-04, MEDIA-07, MEDIA-09, MEDIA-11, ALBUM-01, ALBUM-05, INTEGRATION-11 |
| U-MODEL-01 | 主模型与工具宿主 | BASE-01, CACHE-01, CACHE-07, MEDIA-05, INTEGRATION-08, INTEGRATION-09, DELIVERY-03 |
| U-CONTEXT-01 | 上下文唯一策略 | CACHE-04, CONTEXT-01, CONTEXT-02, CONTEXT-03, CONTEXT-04, MEDIA-06, BACKGROUND-17, DELIVERY-02 |
| U-CONTEXT-02 | 原文与 hold | BASE-03, TOKEN-03, CACHE-04, CONTEXT-02, CONTEXT-03, CONTEXT-04, CHAT-04, MEDIA-10, BACKGROUND-07, BACKGROUND-17, FEED-05, CALENDAR-03, CALENDAR-05, INTEGRATION-01, DELIVERY-01 |
| U-CACHE-01 | 1h 缓存与滚动 50min 保温 | BASE-02, ALERT-01, CACHE-01, CACHE-02, CACHE-03, CACHE-04, CACHE-05, CACHE-06, CONTEXT-03, BACKGROUND-01, BACKGROUND-02 |
| U-CACHE-02 | 防止隐式压缩 | ALERT-07, CACHE-01, CACHE-07, CACHE-08 |
| U-WAKE-01 | 自动唤醒开关 | BASE-02, ALERT-05, CACHE-07, BACKGROUND-01, BACKGROUND-02, BACKGROUND-05, BACKGROUND-13, BACKGROUND-15, BACKGROUND-16, DELIVERY-02 |
| U-WAKE-02 | 自设/聊天设置闹钟 | BACKGROUND-01, BACKGROUND-02, BACKGROUND-03, BACKGROUND-13, BACKGROUND-14, BACKGROUND-16, CONTENT-05, CONTENT-06, CONTENT-07, CONTENT-09, CALENDAR-07 |
| U-WAKE-03 | 自主活动自由且有界 | USAGE-04, USAGE-05, USAGE-06, CACHE-05, CACHE-06, CONTEXT-01, BACKGROUND-03, BACKGROUND-04, BACKGROUND-05, BACKGROUND-06, BACKGROUND-07, BACKGROUND-08, BACKGROUND-09, BACKGROUND-10, BACKGROUND-11, BACKGROUND-12, BACKGROUND-15, BACKGROUND-17, FEED-06 |
| U-SYSTEM-01 | 独立系统异常红点 | ALERT-01, ALERT-05, ALERT-06, ALERT-07, ALERT-08, USAGE-01, USAGE-02, USAGE-04, USAGE-05, USAGE-06, CACHE-03, CACHE-08, BACKGROUND-08, BACKGROUND-09, BACKGROUND-10, BACKGROUND-11, BACKGROUND-14 |
| U-SYSTEM-02 | 异常可追溯 | ALERT-02, ALERT-03, ALERT-04, ALERT-06, ALERT-08, USAGE-06, BACKGROUND-04, BACKGROUND-05, BACKGROUND-11, BACKGROUND-12, BACKGROUND-14, BACKGROUND-16, DELIVERY-02 |
| U-TOKEN-01 | 单条消息预计token | TOKEN-01, TOKEN-02, TOKEN-03, TOKEN-04, TOKEN-05, TOKEN-06, TOKEN-07 |
| U-TOKEN-02 | 请求预计与整轮实际 | USAGE-01, USAGE-02, USAGE-03, USAGE-04, TOKEN-02, TOKEN-06, TOKEN-07, CACHE-02, CACHE-03, BACKGROUND-08, BACKGROUND-10, BACKGROUND-15, BACKGROUND-17 |
| U-CALENDAR-01 | 综合月历与日详情 | CALENDAR-01, CALENDAR-02, CALENDAR-03, CALENDAR-04, DELIVERY-02 |
| U-CALENDAR-02 | 桶/原文层次 | CREATION-02, CREATION-04, CALENDAR-02, CALENDAR-03, CALENDAR-04, CALENDAR-05 |
| U-CALENDAR-03 | 计划、提醒、未来留言 | BACKGROUND-13, CONTENT-02, CONTENT-03, CONTENT-05, CONTENT-06, CONTENT-07, CONTENT-08, CONTENT-09, FEED-05, CALENDAR-07 |
| U-CALENDAR-04 | 许愿星重要日 | CALENDAR-04, CALENDAR-06, INTEGRATION-06 |
| U-ALBUM-01 | 聊天截图相册 | ALBUM-02, ALBUM-03, ALBUM-05 |
| U-ALBUM-02 | 重要照片相册 | CONTENT-01, CONTENT-02, CONTENT-03, ALBUM-01, ALBUM-02, ALBUM-05 |
| U-ALBUM-03 | 表情包库 | ALBUM-04 |
| U-ALBUM-04 | 删除相册条目无需审批 | MEDIA-10, CONTENT-04, CONTENT-07, ALBUM-02, DELIVERY-01 |
| U-CREATION-01 | 纪念空间 | MEDIA-09, MEDIA-11, CONTENT-01, CONTENT-03, CONTENT-04, CREATION-01, CREATION-03, CREATION-04 |
| U-CREATION-02 | 自愿后补 | CREATION-01, CREATION-02, CREATION-05, CALENDAR-04 |
| U-FEED-01 | 双人私密朋友圈 | CONTENT-01, CONTENT-02, CONTENT-03, CONTENT-04, FEED-01, FEED-02, FEED-03, FEED-04, FEED-06, INTEGRATION-04, DELIVERY-01, DELIVERY-02 |
| U-FEED-02 | letter变形 | BACKGROUND-07, FEED-01, FEED-05, FEED-06 |
| U-NOTIFY-01 | 到时可见与手机提醒 | CALENDAR-07, INTEGRATION-10, DELIVERY-03 |
| U-VISUAL-01 | 生图与图片检索 | ALBUM-04, INTEGRATION-11 |
| U-EMOTION-01 | 心情维度入口 | CREATION-05 |
| U-GAME-01 | 游戏厅 | CREATION-05 |
| U-EXT-01 | Mariposa | BASE-01, ALBUM-03, CALENDAR-01, CALENDAR-05, CALENDAR-07, INTEGRATION-01, INTEGRATION-09 |
| U-EXT-02 | Siren | MEDIA-08, INTEGRATION-02 |
| U-EXT-03 | oído | INTEGRATION-03, INTEGRATION-08, INTEGRATION-09, DELIVERY-03 |
| U-EXT-04 | 扎西德勒 | FEED-06, INTEGRATION-04, INTEGRATION-08, INTEGRATION-09, DELIVERY-03 |
| U-EXT-05 | Antinomy | INTEGRATION-05 |
| U-EXT-06 | Superposition | CALENDAR-01, CALENDAR-06, INTEGRATION-06 |
| U-EXT-07 | X/小红书 | MEDIA-04, INTEGRATION-07 |
