# 要求、入口和证据矩阵

本次结论以本机 54efebf 的冻结源码为准。A/B/D/X/H/S 的边界及 P1、P2、T1、G1—G7 见 [复审报告](REVIEW.md)。以下 PASS 仅针对该行明确的隔离条件。

## J01—J20

|要求|结论|实际入口、数据所有者与回执|
|---|---|---|
|J01|PASS|正式消息与 scheduler：49:59 不派发，到期重开一次，无文字回执接续，插话使旧目标让位。补源后下一次自然聊天再到期确能恢复；原 occurrence 上限见 G3。|
|J02|PASS|Host 实际邀请、当前余号、可拒抽、同窗短提示、滚窗/重复/非法号；撤回原帖及存档后可选号同步更新。|
|J03|PASS|API 原生与延迟定义→抽星→已交付 reply_ref→真实回复原星、写星、记忆、聊天/静默→完成；常规同轮四请求，无第五次。|
|J04|PASS|SDK 客户工厂→MCP、PreToolUse/PostToolBatch→同 turn 连续四请求，保存工具没提前结束。真实订阅传输未调用。|
|J05|PASS|未抽拒抽、已抽后完成工具动作并沉默、后续自然聊天；正式工具发话后的无卡 done 投影另见 P2。|
|J06|PASS|同批完成前动作成立，完成后未开始的工具按 ID 返回未执行。88 组时序均配对；三条同文发言保持三份独立身份。|
|J07|PASS|结构化卡号、重传/异参冲突、同轮一张不限制后续工具。锚点域另验跨请求和 v89 回执兼容。|
|J08|PASS|API/SDK 各十个不同号码实际交付，第十一轮才 ack；最后正常 1 和耗尽 1 在新请求各一次，后者零朋友圈。未知/不足不触发回 1。|
|J09|PARTIAL|最终门前的外部撤回/源修订/离线六例、图片准备后失败、真实派发未知跨 31 天、留言删除竞争通过。G6 的最终跨服务传播边界未闭合。|
|J10|PASS|同日并发换窗保留一副牌，跨午夜运行轮固定旧日、新窗新日产生新牌；旧文章回执延至下一轮后仍只归原事件。两类冷重启另验。|
|J11|FAIL|实际正常核心动作、无文字和多条消息同一篇通过。五种权威写入无对应事实 P1，无卡正常发话的投影 state 错误 P2。|
|J12|PARTIAL|正式源成功与丢回执、晚修订、删除后迟到补写不复活；五次失败上限见 G3。P1 仍缺部分源动作可供补映射。|
|J13|PASS|“我们”后端默认；客厅独立 opt-in/授权读，关掉仍读历史；family 不入默认、显式选择和非法入口。|
|J14|PASS|浏览器从心跳专页管理、朋友圈导航定位；已投与投递未知分别编辑、刷新、删除，保留原协议、冻结与消费事实。|
|J15|PARTIAL|四路中文字面转义/引号/换行/数字一致，实际源计划/I 成功、抽星后仍可凭回执操作。G4 剩余条件式写入未全做跨驱动实写。|
|J16|PASS|首页真实直传、关系故障恢复、资产回应丢失后重选同键、切 tab 迟到再删除、一图多集合及源保护均有 B/A。|
|J17|PARTIAL|53 张首页实翻页，10 张带入及同源 hash、GIF/SVG/代码作品/迁移重放通过。真实历史 7+4+1 仍待数据收口。|
|J18|PARTIAL|正常/静默/耗尽和强停首邀，本地、已发、后续构造的输入分别核对；SDK 两种冷重放通过。当前修复版供应商缓存未实测 G1。|
|J19|PASS|自设预约受理、原 note/due、一处短钩子与终态后无追问；自设动作可映射，受限通话门仍有效。|
|J20|PARTIAL|63 个注册描述、57 个新窗业务名、56 个心跳定义四路实取，第七源扩展实装；G4 单项写入回执未逐一跨四路。|

## 原执行稿 R01—R33 / T01—T48

每行给出原条款关联的本次入口或证据。外部供应商 TTL、真实价格和历史相册迁移分别保留证据边界。

|编号及要求|结论|本次定位|
|---|---|---|
|R01 业务正本|PARTIAL|J11/12，P1|
|R02 E 原生正本|PASS|J05/18，正式发言和原生日常正本|
|R03 缓存/暂存|PARTIAL|J16/G2，唯一暂存、确认与回源|
|R04 媒体分类|PASS|J16/17，新位图创作入口被拒|
|R05 直接上传|PASS|J16，首页直接入库|
|R06 撤成员|PASS|J09/16/17，成员删除与同资产关系|
|R07 同日固定|PASS|J07/08/10，同窗/换窗与上海日|
|R08 上海业务日|PASS|J10，两设备请求与午夜|
|R09 调度/自设边界|PARTIAL|J01/19，G3 失败上限|
|R10 可拒抽|PASS|J05，拒抽无虚假回复|
|R11 提示/纠正|PASS|J02，真实余号与有界纠正|
|R12 数字 1|PASS|J07/08，1 号与文本 1|
|R13 每轮一张|PASS|J03/04/07，抽后仍能继续|
|R14 六源|PARTIAL|J13/20/G6，六源、独立记忆与扩展源|
|R15 消费与未知|PASS|J09，真实送达/未知/未发送的账本|
|R16 滚动冷却|PASS|J09，改正文仍冷却及完整次日牌组|
|R17 首次留言例外|PARTIAL|J11/14，揭牌前话不算回应，未穷尽外部源撤权|
|R18 唯一耗尽兜底|PASS|J08，十号逐次确认|
|R19 同一聊天|PASS|J03/04/05，正式回话与自然续接|
|R20 宿主来源|PASS|J02，邀请来自 Host、来源数据隔离|
|R21 维护 1|PASS|J08/18，耗尽 1 和首邀续接|
|R22 普通聊天可沉默|PASS|J05/06，普通沉默|
|R23 完成复用|PASS|J05/06，完成幂等与复用|
|R24 终态停发|PASS|J06/18，终态停发|
|R25 朋友圈整轮映射|FAIL|J11/12，P1、P2|
|R26 三层|PASS|J13，后端分层及 family 占位|
|R27 星与日常分工|PARTIAL|J03/04，真实回复原星可用；星仪式动作 P1|
|R28 唤醒短提醒|PASS|J19，提醒一处|
|R29 页面接线|PASS|J14/16，真实管理入口|
|R30 退役|PARTIAL|J20，旧冻结目录仍需消费者证据|
|R31 朋友圈改删|PARTIAL|J11/12/14，源改删与墓碑通过，P1 业务引用不全|
|R32 留言管理|PASS|J14，已投/未知专页管理|
|R33 无文字协议|PASS|J05/18，无文字与冷恢复|
|T01 上传无聊天|PASS|J16|
|T02 落正后关系失败|PASS|J16，已有资产回执及丢回执分别实跑|
|T03 移除退出各范围|PASS|J09/16，撤成员与冻结牌状态|
|T04 多集合|PASS|J16|
|T05 历史分类迁移|PARTIAL|J17/G2|
|T06 正常抽卡/一条朋友圈|PASS|J03/04/08，一篇及卡 1—10|
|T07 重选号纠正|PASS|J02/07|
|T08 同操作重传|PASS|J07，抽卡操作|
|T09 选号 1 / 文本 1|PASS|J07/08|
|T10 拒抽|PASS|J05|
|T11 完成跨轮|PASS|J05/06|
|T12 普通沉默|PASS|J05，普通聊天沉默后续聊|
|T13 已说话后完成|PASS|J05/06，正式发言可见，投影分类见 P2|
|T14 同批工具|PASS|J06，未开始的晚工具|
|T15 四路目录/完成|PASS|J03/04/20|
|T16 兜底 1 连续性|PASS|J08/18，1 与首邀确认后的强停|
|T17 L 与维护锚点|PASS|J01，L 与实际维护|
|T18 同窗提示|PASS|J02|
|T19 跨午夜|PASS|J10，午夜旧轮冻结日|
|T20 滚窗/重启|PASS|J10/18，双端确认和 SDK 冷重启|
|T21 十张真实交付|PASS|J08，两条完整十卡链|
|T22 明确未派发|PASS|J09，已知未派发归还号码|
|T23 交付后失败/沉默|PASS|J09，事后失败不退已交付卡|
|T24 派发未知|PASS|J09，已发未知第 31 天仍隔离|
|T25 用户优先、关闭|PARTIAL|J05/09，插话/关闭/准入已测，供应商 G5|
|T26 删除和固定修订|PASS|J09/14，四种 Content 源删除及固定修订|
|T27 三十天跨包装|PASS|J09/17，post 与 media 权威别名|
|T28 预留话首次回应|PARTIAL|J11/14，首次回应与重播资格有证；外部修订组合 G5/G6|
|T29 防重播套娃|PARTIAL|J13/14，类型约束及防递归，未穷尽未来扩展来源|
|T30 一轮一篇|FAIL|J11，P1、P2|
|T31 投影失败与晚到|PARTIAL|J12/G3，含晚回执与五次上限|
|T32 正本与解析|PARTIAL|J16/17/G6，分域与素材回源|
|T33 客厅/family|PASS|J13|
|T34 闹钟短钩子|PASS|J19|
|T35 首页管理|PASS|J14/16，首页|
|T36 退役/进程|PARTIAL|J20，在用路径与历史兼容、测试进程退出|
|T37 完成重传|PASS|J06/18|
|T38 崩溃一致|PASS|J18，两种驱动首发、提交前后和冷恢复|
|T39 来源图|PARTIAL|J09/G6，已知来源别名与环边界|
|T40 备选不足|PARTIAL|J08/G3，九源补齐与自然聊天再到期|
|T41 原创改删|PASS|J14，源 CAS、增删与回放|
|T42 编辑来源块|PASS|J14，通用表单跳源|
|T43 预留话改删|PASS|J14，未知及已投浏览器增改删范围内|
|T44 删除派发竞争|PASS|J09，预留话先后与冻结账本|
|T45 编辑部分失败|PASS|J12，幂等补关联|
|T46 编辑权限与源删除|PARTIAL|J12/14/G6，跨六源各种操作未穷尽|
|T47 语义过滤|PASS|J08，普通 1 和保温 1|
|T48 工具拒抽连续性|PASS|J05/18|

## 当前实际工具目录

下表以一次真实普通心跳的新窗目录为准。四种适配组合的可发现资格与取定义结果逐项列在 EVIDENCE.catalog_lanes。direct 首包上其余工具按需激活，deferred 由定义标识调用。带权限/价格/通话限制的操作仍须满足各自条件。通话列表示在受限通话模式允许登记的能力；表中预算为测试装配在空参数时的观测。混合工具的条件式心跳动作须看具体操作及其权威回执。

|工具|所有者|心跳任务目录|direct 首包|受限通话|预算|顶层必填参数|
|---|---|---|---|---|---|---|
|memory_hold|memory|四路可发现|是|是|quoted|original_title, categories, text, creation_mode|
|memory_recall|memory|四路可发现|是|是|needs-quote/arguments|query|
|memory_recall_next|memory|四路可发现|否|是|needs-quote/arguments|result_set_id|
|memory_read_full|memory|四路可发现|是|是|free|memory_ref|
|memory_update|memory|四路可发现|是|是|needs-quote/arguments|memory_id, expected_version|
|conversation_read|conversation|四路可发现|否|是|free|见操作/无需|
|memory_i_read|memory|四路可发现|否|是|free|见操作/无需|
|plans_read|memory|四路可发现|否|是|free|见操作/无需|
|memory_i_write|memory|四路可发现|否|是|needs-quote/arguments|action|
|plans_write|memory|四路可发现|否|否|needs-quote/arguments|action|
|memory_open|memory|四路可发现|否|是|needs-quote/arguments|action|
|memory_correct|memory|四路可发现|否|是|needs-quote/arguments|action|
|deletion_review|memory|四路可发现|否|否|needs-quote/arguments|action|
|episode_list|memory|仅历史兼容|否|是|needs-quote/arguments|见操作/无需|
|episode_read|memory|四路可发现|否|是|needs-quote/arguments|见操作/无需|
|episode_apply|memory|四路可发现|否|是|needs-quote/arguments|action, reason_code|
|episode_get|memory|仅历史兼容|否|是|needs-quote/arguments|见操作/无需|
|content_post_create|content|四路可发现|是|否|needs-quote/arguments|text, idempotency_key|
|content_comment_create|content|四路可发现|否|否|needs-quote/arguments|post_id, text, idempotency_key|
|content_posts_list|content|四路可发现|否|否|needs-quote/arguments|见操作/无需|
|creation_save_artifact|content|四路可发现|否|否|free|format, content, client_operation_id|
|wake_manage|wake|四路可发现|是|否|free|operation|
|background_complete|turn|四路可发现|否|否|free|outcome|
|chat_send_text|conversation|四路可发现|否|否|free|text, idempotency_key|
|media_import|media|四路可发现|否|否|needs-quote/arguments|source_url|
|chat_send_attachment|conversation|四路可发现|否|否|free|asset_id, presentation|
|call_control|voice|四路可发现|是|是|needs-quote/arguments|action|
|oido_analyze|oido|四路可发现|否|是|needs-quote/arguments|见操作/无需|
|chat_send_voice|voice|四路可发现|是|否|needs-quote/arguments|text|
|media_search|media|四路可发现|否|否|needs-quote/arguments|query|
|oido_get|oido|四路可发现|否|是|needs-quote/arguments|analysis_id|
|transcript_read|voice|四路可发现|否|是|needs-quote/arguments|见操作/无需|
|oido_capabilities|oido|四路可发现|否|是|needs-quote/arguments|见操作/无需|
|oido_view|oido|四路可发现|否|否|needs-quote/arguments|analysis_id|
|oido_find|oido|四路可发现|否|否|needs-quote/arguments|audio_ref, query|
|oido_compare|oido|四路可发现|否|否|needs-quote/arguments|left, right|
|identity_milestone_write|identity|四路可发现|否|否|free|operation|
|wishstar_write_star|wishstar|四路可发现|是|否|quoted|text, visibility, idempotency_key|
|wishstar_hidden_stars|wishstar|仅历史兼容|否|否|needs-quote/arguments|见操作/无需|
|wishstar_read|wishstar|四路可发现|否|否|needs-quote/arguments|what|
|wishstar_special_dates|wishstar|仅历史兼容|否|否|needs-quote/arguments|见操作/无需|
|wishstar_start_session|wishstar|四路可发现|否|否|needs-quote/arguments|special_date_id|
|wishstar_confirm_session|wishstar|四路可发现|否|否|needs-quote/arguments|session_id|
|wishstar_take_star|wishstar|四路可发现|否|否|needs-quote/arguments|session_id|
|wishstar_finish_session|wishstar|四路可发现|否|否|needs-quote/arguments|session_id|
|wishstar_request_star|wishstar|四路可发现|是|否|needs-quote/arguments|见操作/无需|
|wishstar_respond_request|wishstar|四路可发现|否|否|needs-quote/arguments|request_id, decision|
|wishstar_offer_star|wishstar|四路可发现|否|否|needs-quote/arguments|star_id|
|wishstar_list_offers|wishstar|仅历史兼容|否|否|needs-quote/arguments|见操作/无需|
|wishstar_accept_offer|wishstar|四路可发现|否|否|needs-quote/arguments|offer_id|
|wishstar_notifications|wishstar|仅历史兼容|否|否|needs-quote/arguments|见操作/无需|
|context_review_complete|context-review|仅换窗评审|否|是|free|review_id, decision|
|memory_words_write|memory|四路可发现|否|是|needs-quote/arguments|action, memory_id, refs|
|conversation_archive|archives|四路可发现|是|否|needs-quote/arguments|kind|
|memory_relations|memory|四路可发现|否|是|needs-quote/arguments|action|
|image_generate|imagegen|四路可发现|是|否|needs-quote/arguments|prompt, client_operation_id|
|content_albums_read|content|四路可发现|是|否|free|见操作/无需|
|content_album_entry_write|content|四路可发现|是|否|free|kind, asset_id, idempotency_key|
|media_view|media|四路可发现|是|否|free|asset_ref|
|content_creations_read|content|四路可发现|否|否|free|见操作/无需|
|archives_search|archives|四路可发现|否|否|needs-quote/arguments|query|
|heartbeat_draw|heartbeat|四路可发现|否|否|free|card_number|
|wishstar_reply_star|wishstar|四路可发现|否|否|quoted|reply_ref, text, idempotency_key|

## 证据复定位

- 发话与协议用 spoken_tools、speech_counts、boundaries、after_output、commit_gap 核对；纯完成、重复和冷恢复见 normal、extra_chains、sdk_cold_recovery、sdk_deferred_cold。
- 来源竞态与分层用 external_gate、midnight_devices、full_deck_edit、note_ui、cas、ten、outbox 和 reaudit_edges。
- 行为映射用 star_extended、memory_extended、more_receipts、writes、text_all 和 no_card_speech。星源证据是实际 HTTP 路由＋临时库，M 证据是限权 HTTP 能力＋临时库；查询门和结果均可分别复查。
- 历史数与缓存事实用 historical_album、offline_usage。字节正本、协议载荷、本地书写、已确认发送及供应商 usage 仍各自取证。
- T1 的原测试保留失败结果。诊断展开只用于找到陈旧断言的位置，没有纳入通过计数。
