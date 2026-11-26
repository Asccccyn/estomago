# 复验与能力矩阵

状态只覆盖该行的具体断言。证据键及观测数据见 [EVIDENCE](EVIDENCE.json)。缺陷与 G 编号见 [交接单](HANDOFF.md)。A/B/D/S/H 的定义同主报告。

## 本轮 J01—J20

|条款|状态|实际入口、所有者与观察|
|---|---|---|
|J01|PASS|真实聊天 → activity/scheduler → 维护回执；49:59 为 0，关闭为 0，过期重开 1，早一秒仍 1，到点 2，插话后原目标仍 2。失败恢复另列 G3。|
|J02|PASS|新窗 Host 邀请 → 实际首发；正常选择、固定号、拒抽及一次一张；同窗简化和纠正由 orchestration 验。删源余号缺陷另见 09。|
|J03|PASS|API direct/deferred 发现及回复原星 → 源回执 → 写星、记忆、聊天、完成；发话和沉默主链通过。01/06 是另有触发条件的缺陷。|
|J04|PASS|SDK 同两路，经 query 工厂、工具钩子与 MCP；回复引用可用，保留同一逻辑回合，非终结写入后继续。预算之外另见 08。|
|J05|PARTIAL|未抽/已抽 noop、连续多轮、无强制 1 与自然续聊通过。先走工具再自行说话有 01。|
|J06|PASS|完成前源提交保留；完成后的同批动作有同 ID 未执行回执，正常/沉默均无额外请求。准入前让位另见 08。|
|J07|PASS|整数 1、同操作重传、同键异参、新操作重选、同轮二选的抽卡域与工具入口有证；写锚点是另一所有者，见 05。|
|J08|PASS|两驱动各 10 次确认，下一轮才真回 1；不足、9 张加未知/失效、误把普通文本 1 当卡均有对照。断电窗口见 02。|
|J09|FAIL|数据准备、派发、未知、交付后失败分别核；未知第 31 天不释放。图片准备后已明确未送仍占号见 07；外部撤权跨最终门证据见 G5。|
|J10|PARTIAL|同一冻结日、跨午夜回合、同日滚窗及冷重启有独立测试，SDK 冷回放成对。耗尽轮首发的恢复有 02；两设备换窗+迟到并发未组合。|
|J11|FAIL|标准四动作排序、正常一轮一篇、沉默显示已写动作通过。其他实际发言与写入漏失见 01/06。|
|J12|FAIL|同操作重投一篇、旧 outbox 遇删除不复活、晚修订不反盖有证；明确未受理/未知及轮终态见 08，五次上限见 G3。|
|J13|PASS|后端默认仅“我们”，扩展客厅独立受控、关闭后可读合格历史；family scope 无登记，无采集 worker。真实部署外部权限未拨测。|
|J14|PARTIAL|首页心跳页原留言的增改删、朋友圈跳源、并发修订及未知/已投保留消费有组合证据。已投和未知分别用浏览器穷尽所有按钮未测。|
|J15|PARTIAL|六种真实正文入口四路逐字对比；回复星、记忆、聊天另有主链。整数字段保持独立。其余条件式写工具的正文、错误与体积未逐一实写。|
|J16|FAIL|关系失败重试、同资产多集合、撤一保另、异用途键冲突均通过。迟到列表撤错成员 03，资产回执丢失再刷新 10。|
|J17|PARTIAL|53 成员实际首页分页，10 张带入及权威 hash 有域证据，GIF/SVG/HTML、历史引用及迁移重复应用有分层证据。生产历史数量与待补详主报告。|
|J18|FAIL|正常配对、同窗/prefix、未派发尾、冷恢复、可见 1 和容量有证。SDK/聊天对外正文与已发耗尽首邀中断有 01/02。物理缓存 G1。|
|J19|PASS|wake_manage 受理后收尾，原 note/due 投递；适用首邀一次短提醒，终态后不追问。已修的预约投影通过；owner 代设被拒。|
|J20|PARTIAL|63 项注册、57 个新业务名、56 项心跳合格定义四路取回。单能力条件、实际副作用覆盖与有消费者的历史兼容见下；G4 未全部执行。|

## v1.2 R 项

|编号及原要求|当前判定|证据定位与限制|
|---|---|---|
|R01 业务正本|PARTIAL|J11/12，06 业务引用缺|
|R02 E 原生正本|FAIL|J05/18，01 正式助手发言漏|
|R03 缓存/暂存|PARTIAL|J16，G2、07/10|
|R04 媒体分类|PASS|J17，旧位图写入入口实拒|
|R05 直接上传|PARTIAL|J16，10 及 G2|
|R06 撤成员|FAIL|J16；03/09|
|R07 同日固定|PASS|J07/08|
|R08 上海业务日|PASS|J10，冻结业务日子项|
|R09 调度/自设边界|PARTIAL|J01/19，失败 occurrence 的恢复条件 G3|
|R10 可拒抽|PASS|J05，完成工具拒抽|
|R11 提示/纠正|PARTIAL|J02；09 影响显示余号|
|R12 数字 1|PASS|J07/08，不以文本筛 1|
|R13 每轮一张|PASS|J03/07|
|R14 六源|PARTIAL|J13/20，六源和第七源有隔离证据，现网授权 G1/G6|
|R15 消费与未知|FAIL|J09，07|
|R16 滚动冷却|FAIL|04；未知隔离修复通过|
|R17 首次留言例外|PARTIAL|J14；揭牌前回复已排除，源撤权与历史包装联合 G5|
|R18 唯一耗尽兜底|PASS|J08|
|R19 同一聊天|FAIL|J03/04 正常，01/02 中断或发言|
|R20 宿主来源|PASS|J02，来源权限和协议标签|
|R21 维护 1|PARTIAL|J08/18；正式 1 正常，02 已发邀请丢|
|R22 普通聊天可沉默|PASS|J05，普通沉默及下一自然聊天|
|R23 完成复用|PASS|J05/06|
|R24 终态停发|PASS|J06，已测完成和强停恢复无额外调用|
|R25 朋友圈整轮映射|FAIL|J11/12，01/06/08|
|R26 三层|PASS|J13|
|R27 星与日常分工|PARTIAL|J03/04；真实原星回复成功，其余申请写入缺显示 06|
|R28 唤醒短提醒|PASS|J19|
|R29 页面接线|FAIL|J16/17，03/10|
|R30 退役|PARTIAL|J20，运行消费者及退出条件见末表|
|R31 朋友圈改删|PARTIAL|J12/14，CAS 和墓碑通过，跨源组合 G5|
|R32 留言管理|PARTIAL|J14，已投/未知全 UI 组合尚缺|
|R33 无文字协议|PARTIAL|J05/18；复用完成协议通过，驱动终态差异 08|

## v1.2 T 项

|编号及原要求|当前判定|证据定位与限制|
|---|---|---|
|T01 上传无聊天|PASS|J16，零聊天/模型|
|T02 落正后关系失败|PASS|J16；已拿资产回执后关系失败|
|T03 移除退出各范围|FAIL|J16；03 切 tab，09 其他源余号|
|T04 多集合|PASS|J16；有明确集合关系的对照|
|T05 历史分类迁移|PARTIAL|J17/G2|
|T06 正常抽卡/一条朋友圈|PASS|J03/04；J08 亦逐号覆盖|
|T07 重选号纠正|PASS|J02/07|
|T08 同操作重传|PASS|J07，抽卡操作|
|T09 选号 1 / 文本 1|PASS|J07/08|
|T10 拒抽|PASS|J05|
|T11 完成跨轮|PASS|J05/06|
|T12 普通沉默|PASS|J05 普通沉默|
|T13 已说话后完成|PARTIAL|J05；显式 send 通过，01 的后续正文漏|
|T14 同批工具|PASS|J06|
|T15 四路目录/完成|PASS|J03/04/20|
|T16 兜底 1 连续性|PARTIAL|J08 正常；J18/02 首发后中断|
|T17 L 与维护锚点|PASS|J01|
|T18 同窗提示|PARTIAL|J02；09 非相册来源删除|
|T19 跨午夜|PASS|J10 在途 run 冻日|
|T20 滚窗/重启|PARTIAL|J10/18，G5|
|T21 十张真实交付|PASS|J08，十次完整派发两驱动|
|T22 明确未派发|FAIL|J09，07 明确未物化结账|
|T23 交付后失败/沉默|PASS|J03/04/09 已交付后沉默或后续失败|
|T24 派发未知|PASS|J09 真已派发未知当日及第 31 日仍隔离；08 系误报未知|
|T25 用户优先、关闭|FAIL|J05/12，01/08|
|T26 删除和固定修订|FAIL|J09/14，09 冻结号仍显示|
|T27 三十天跨包装|FAIL|J09，04|
|T28 预留话首次回应|PARTIAL|J14，预揭牌不算回应，跨源组合 G5|
|T29 防重播套娃|PARTIAL|首次回应限定/引用解析，深层扩展与撤权组合 G5/G6|
|T30 一轮一篇|FAIL|J11，01/06|
|T31 投影失败与晚到|PARTIAL|J12，丢确认和晚到通过，五次上限 G3|
|T32 正本与解析|PARTIAL|J16/17，07/G6|
|T33 客厅/family|PASS|J13|
|T34 闹钟短钩子|PASS|J19|
|T35 首页管理|FAIL|J16/17，03/10|
|T36 退役/进程|PARTIAL|J20，测试进程均退出，旧冻结包仍有实际消费者|
|T37 完成重传|PASS|J06/18，按同回合恢复及跨轮复用|
|T38 崩溃一致|FAIL|J18，02；既有助手 1 提交前后 SIGKILL 断点为正向证据|
|T39 来源图|FAIL|J09，04 实际根源身份改变|
|T40 备选不足|PARTIAL|J08 + G3，来源后来变为可用|
|T41 原创改删|PASS|J14，源 CAS、改正文/附件与删除分别有证|
|T42 编辑来源块|PASS|J14，预留话从通用表单转专页|
|T43 预留话改删|PARTIAL|J14/G5，源写与消费分离，专页未逐态穷尽|
|T44 删除派发竞争|PASS|J09，预留话在途先后|
|T45 编辑部分失败|PASS|J12，本地编辑关联回执不二次写源|
|T46 编辑权限与源删除|PARTIAL|J12/14/G5/G6|
|T47 语义过滤|PASS|J08，最后一轮的普通 1 入朋友圈，耗尽轮不入|
|T48 工具拒抽连续性|PASS|J05/18，已测工具拒抽同 ID 尾部与自然续接|

## 实际工具目录

新窗 direct 首包 15 个业务工具及两个发现入口。按需定义可使同窗后续请求增加已激活工具。deferred 首包只有 tool_catalog、tool_define、tool_invoke，执行时须持有效定义。SDK 经 MCP 名称投影及同一目录/执行资格。下表“合格”是有效心跳、源权限/业务状态/预算齐备时的任务资格。通话列只表示受限通话模式的描述符开关；后台报价列来自已注入测试报价的隔离装配。执行时还须有效身份、当前来源可见和修订、任务/操作允许及预算。四路查定义成功不代表四路对其每一个动作已写源。

|业务名|所有者|心跳发现/取定义|direct 首包|受限通话可用|预算元数据|必填入口|登记的心跳动作|
|---|---|---|---|---|---|---|---|
|memory_hold|memory|四路合格|是|是|quoted|original_title, categories, text, creation_mode|memory_hold|
|memory_recall|memory|四路合格|是|是|needs-quote/arguments|query|无统一动作标记|
|memory_recall_next|memory|四路合格|否|是|needs-quote/arguments|result_set_id|无统一动作标记|
|memory_read_full|memory|四路合格|是|是|free|memory_ref|无统一动作标记|
|memory_update|memory|四路合格|是|是|needs-quote/arguments|memory_id, expected_version|memory_update|
|conversation_read|conversation|四路合格|否|是|free|依动作/可省|无统一动作标记|
|memory_i_read|memory|四路合格|否|是|free|依动作/可省|无统一动作标记|
|plans_read|memory|四路合格|否|是|free|依动作/可省|无统一动作标记|
|memory_i_write|memory|四路合格|否|是|needs-quote/arguments|action|无统一动作标记|
|plans_write|memory|四路合格|否|否|needs-quote/arguments|action|无统一动作标记|
|memory_open|memory|四路合格|否|是|needs-quote/arguments|action|无统一动作标记|
|memory_correct|memory|四路合格|否|是|needs-quote/arguments|action|无统一动作标记|
|deletion_review|memory|四路合格|否|否|needs-quote/arguments|action|无统一动作标记|
|episode_read|memory|四路合格|否|是|needs-quote/arguments|依动作/可省|无统一动作标记|
|episode_apply|memory|四路合格|否|是|needs-quote/arguments|action, reason_code|无统一动作标记|
|content_post_create|content|四路合格|是|否|needs-quote/arguments|text, idempotency_key|post|
|content_comment_create|content|四路合格|否|否|needs-quote/arguments|post_id, text, idempotency_key|comment|
|content_posts_list|content|四路合格|否|否|needs-quote/arguments|依动作/可省|无统一动作标记|
|creation_save_artifact|content|四路合格|否|否|free|format, content, client_operation_id|creation|
|wake_manage|wake|四路合格|是|否|free|operation|wake|
|background_complete|turn|四路合格|否|否|free|outcome|无统一动作标记|
|chat_send_text|conversation|四路合格|否|否|free|text, idempotency_key|chat|
|media_import|media|四路合格|否|否|needs-quote/arguments|source_url|无统一动作标记|
|chat_send_attachment|conversation|四路合格|否|否|free|asset_id, presentation|chat|
|call_control|voice|四路合格|是|是|needs-quote/arguments|action|无统一动作标记|
|oido_analyze|oido|四路合格|否|是|needs-quote/arguments|依动作/可省|无统一动作标记|
|chat_send_voice|voice|四路合格|是|否|needs-quote/arguments|text|chat|
|media_search|media|四路合格|否|否|needs-quote/arguments|query|无统一动作标记|
|oido_get|oido|四路合格|否|是|needs-quote/arguments|analysis_id|无统一动作标记|
|transcript_read|voice|四路合格|否|是|needs-quote/arguments|依动作/可省|无统一动作标记|
|oido_capabilities|oido|四路合格|否|是|needs-quote/arguments|依动作/可省|无统一动作标记|
|oido_view|oido|四路合格|否|否|needs-quote/arguments|analysis_id|无统一动作标记|
|oido_find|oido|四路合格|否|否|needs-quote/arguments|audio_ref, query|无统一动作标记|
|oido_compare|oido|四路合格|否|否|needs-quote/arguments|left, right|无统一动作标记|
|identity_milestone_write|identity|四路合格|否|否|free|operation|无统一动作标记|
|wishstar_write_star|wishstar|四路合格|是|否|quoted|text, visibility, idempotency_key|star_write|
|wishstar_read|wishstar|四路合格|否|否|needs-quote/arguments|what|无统一动作标记|
|wishstar_start_session|wishstar|四路合格|否|否|needs-quote/arguments|special_date_id|无统一动作标记|
|wishstar_confirm_session|wishstar|四路合格|否|否|needs-quote/arguments|session_id|无统一动作标记|
|wishstar_take_star|wishstar|四路合格|否|否|needs-quote/arguments|session_id|无统一动作标记|
|wishstar_finish_session|wishstar|四路合格|否|否|needs-quote/arguments|session_id|无统一动作标记|
|wishstar_request_star|wishstar|四路合格|是|否|needs-quote/arguments|依动作/可省|无统一动作标记|
|wishstar_respond_request|wishstar|四路合格|否|否|needs-quote/arguments|request_id, decision|无统一动作标记|
|wishstar_offer_star|wishstar|四路合格|否|否|needs-quote/arguments|star_id|无统一动作标记|
|wishstar_accept_offer|wishstar|四路合格|否|否|needs-quote/arguments|offer_id|无统一动作标记|
|context_review_complete|context-review|排除：仅换窗评审|否|是|free|review_id, decision|无统一动作标记|
|memory_words_write|memory|四路合格|否|是|needs-quote/arguments|action, memory_id, refs|无统一动作标记|
|conversation_archive|archives|四路合格|是|否|needs-quote/arguments|kind|archive|
|memory_relations|memory|四路合格|否|是|needs-quote/arguments|action|无统一动作标记|
|image_generate|imagegen|四路合格|是|否|needs-quote/arguments|prompt, client_operation_id|image|
|content_albums_read|content|四路合格|是|否|free|依动作/可省|无统一动作标记|
|content_album_entry_write|content|四路合格|是|否|free|kind, asset_id, idempotency_key|album|
|media_view|media|四路合格|是|否|free|asset_ref|无统一动作标记|
|content_creations_read|content|四路合格|否|否|free|依动作/可省|无统一动作标记|
|archives_search|archives|四路合格|否|否|needs-quote/arguments|query|无统一动作标记|
|heartbeat_draw|heartbeat|四路合格|否|否|free|card_number|selection|
|wishstar_reply_star|wishstar|四路合格|否|否|quoted|reply_ref, text, idempotency_key|star_reply|

六个仅旧窗或旧协议登记的名称为 episode_list、episode_get、wishstar_hidden_stars、wishstar_special_dates、wishstar_list_offers、wishstar_notifications。不能仅凭新窗未见就删除旧回放所需映射。

抽查完整度按真实行为界定。回复原星、写星、保存和编辑记忆、预约、正式发话、发布帖子及评论见 A 的源/投影对账。写计划、锚点、申请星及 memory_i_write 见 05/06。chat_send_attachment 有正式消息身份。其余未逐一执行的条件式写操作包括 memory_open、memory_correct、deletion_review、episode_apply、memory_words_write、memory_relations、拆星/确认/结束/offer 等星仪式和 call_control。分别用合法 read/write 分支、真实可见对象及提交回执判定是否应产生用户可读事实。只读查询、打开工具定义、受理中未提交操作不能显示为写入成功。

本次合成 direct 样本首包 wire tools 6,673 B，deferred 为 1,454 B。模型实际收到的精简目录 5,316 B。写星内部回执 216 B、模型投影 67 B；回复原星 106 B，保留回复及原星标识；新卡结果 211 B，早期缺回复目标的旧结果 189 B。memory_hold 83 B、发送正文 62 B、完成 35 B、同批未执行 48 B。不同样本文本长度会改变字节数。模型协议保留唯一投影，内部权威回执承担幂等和来源事实。不得通过删去可行动标识减少体积。

## 生命周期、正本与旧路径

|入口/旧行为及消费者|当前正本、替代与实际状态|尚保留的原因、退出或复验条件|
|---|---|---|
|原生聊天、心跳气泡、朋友圈|Host 正式消息/规范协议各有身份；朋友圈以 Content 一条引用投影表现当轮。聊天只展示灰邀请和正式话，卡与动作在朋友圈；有正文缺口 01|模型收到的卡面和原始协议要按实际派发保存一次。编辑 display_revision 不应改写已发历史|
|成功、沉默与完成后再追问|background_complete(done/noop) 复用，已提交动作/卡消费保留。正常同批晚工具以同 ID 未执行，终态后没有第五次请求|context_review_complete 与星仪式结束各有独立目的。保持旧窗恢复和未送尾部，拒抽不补 1|
|取消/已失败/未知/恢复|同会话让位、调度门与 outbox 独立。可复验的终态错误见 07/08；真正未知跨 31 日仍隔离|释放持有回合的资源。仅凭时间不能退款，恢复只补同一事件；外部副作用已提交时只查回执|
|首页示意上传和旧弹窗|当前首页 → /home/album → React → 正式资产/成员 HTTP；53 条分页和失败提示实测。旧主页脚本仍在静态路径|在确定历史 HTML/外链消费者消失后再删。仅可下载脚本不能证明首页执行它|
|旧 PNG 写代码作品、代码截图假迁移|新普通位图作品 POST 422；真实 HTML 作品可导入/预览/撤除。既有作品 ID、旧修订和原件仍有历史消费者|保留纪念/旧记录读取和合法代码作品写入口；生产 7+4+1 未迁完，墓碑不复活|
|同资源再次上传|已获资产确认则只补成员关系，M 是字节正本；首次回执未抵达刷新仍有 10|持久化同一操作到获原回执，不能删唯一上传暂存。错误 tab 撤关系另见 03|
|朋友圈拼正文、模型重写、回灌聊天|原生日常有自己的正本，来源型条目只持引用，不发第二次模型请求。原“只收聊天”的旧行为已补常用动作，06 仍有漏|保留真实源回执、编辑版本、outbox 墓碑及规范协议；无消费者之后才删旧读兼容|
|另开抽卡会话、抽完立刻结束、写记忆即终结|API/SDK 走长期会话内多请求；SDK 保存优化仍有普通聊天消费者，新心跳顺利继续|按实际 session、同 turn、已确认请求和预算验证。普通聊天优化不能不分 purpose 扩展到心跳|
|拒抽或无候选强行回 1、隐藏维护 1|只在十个号码均确认交付后下一轮进入耗尽，真实 ack 可见一次，计入上下文容量，零朋友圈|正常路径已退出旧语义。首发确认后强停的历史另有 02|
|预留话优先、通用表单代写、用户代设自主闹钟|预留话使用同一候选池和 Content 源命令，管理移至心跳页，朋友圈跳转。自主 wake_manage 与普通提醒保持不同资格|保留必要源修订和已有预约，不建第二内容服务或调度器|
|旧 content/body、重复转义、冻结工具/生成产物|新自然语言入口 text 在代表性四路逐字一致。内部 DB/source 的特定字段、旧窗 schema 和 SDK 历史仍有消费者|旧窗按冻结定义转同一业务服务。须核仍可恢复的活动窗/历史后再退六个旧名，不能热改 prefix。生成的资源由首页实际加载|
|客厅、family 与新增源、无主 worker|客厅适配器默认关，关闭后不影响授权历史阅读。既有调度及源装配支持第七来源，未发现 family 同步或候选 worker|扩展凭权威身份和读取资格接至同一副牌。测试进程组均退出，未对无关生产 worker 作全系统无残留保证|

## 执行复验

交接包附带此次独立探针及运行说明。01—10 修复后，先回放各项正反例，再在同一候选提交上运行四种适配组合的发话/沉默、逐号 10+1、强停后首次自然输入及 53 张浏览分页。保留 source、正式聊天、projection、规范轨迹、sent_at、下一真实构造的请求这几个独立观察面。只读已有 usage 的结论单列。
