# 工具目录与心跳资格

这份目录来自四条隔离链实际冻结的 catalog、真实 tool_catalog 返回和装配根注册的描述符。新窗有 56 个业务定义，正常心跳可发现 55 个；另有 6 个只供历史窗使用的描述符。切换时的真实旧活动窗也有 56 个定义，但它保存 memory_source_bind，缺 heartbeat_draw。相同数量不能证明同一目录。

下表的“可见”取实际心跳列表，“通话”取 memoryOnlyAllowed 元数据。实际执行还需当前回合未结束、调用合法、该源按当时身份可用且有预算。报价一列是用实审注册表取 quote 的结果，动作可影响报价；“需价”包括读取时须有可信报价的能力。“已配”仅表示测试配置给该工具报价。未为盘点而执行打电话、删除或付费等副作用。每个名字都核对了登记、参数、资格路径；逐个真实外部执行并非本表证据。

direct 中除任务组外以冻结业务名调用，另有 tool_catalog / tool_define；deferred 中走 tool_catalog / tool_define / tool_invoke，下发完整定义/definition_id 并在同一注册执行器校验。SDK 将 wire 工具投影为 mcp__est__ 名称，经原生 MCP 和 hooks 记录 call ID。direct 的实际 define 可回 already_available；本次 SDK direct 经 MCP 也可返回完整定义。参数列为冻结 schema 的顶层必填项，其他可选项和按动作要求的字段保存在同一 schema。

|能力|所有者|心跳可见|通话元数据|报价|必填参数|执行边界或观察|
|---|---|---|---|---|---|---|
|memory_hold|memory|是|允许|已配|original_title, categories, text, creation_mode|真实已建 effect；M 假回执匹配 operation_id，返回 memory_id。|
|memory_recall|memory|是|允许|需价/按动作|query|按记忆查询合同、源可用性与读取预算。|
|memory_recall_next|memory|是|允许|需价/按动作|result_set_id|限定前次 result_set_id。|
|memory_read_full|memory|是|允许|免费|memory_ref|仅可用的记忆引用，全量/删除资格由源核对。|
|memory_update|memory|是|允许|需价/按动作|memory_id, expected_version|源记忆与 expected_version；正文已有 text。|
|conversation_read|conversation|是|允许|免费|按动作或可省略|会话内已发布范围。|
|memory_i_read|memory|是|允许|免费|按动作或可省略|按 what/可见区块读取。|
|plans_read|memory|是|允许|免费|按动作或可省略|读取可见计划。|
|memory_i_write|memory|是|允许|需价/按动作|action|按 action、修订与来源约束，内部正文按动作区分。|
|plans_write|memory|是|关闭|需价/按动作|action|按动作校验目标计划与版本。|
|memory_open|memory|是|允许|需价/按动作|action|仅限可见记忆及指定动作。|
|memory_correct|memory|是|允许|需价/按动作|action|仅现行纠错类型，手工 binding 已退。|
|deletion_review|memory|是|关闭|需价/按动作|action|由删除评审业务合同核准具体操作。|
|episode_read|memory|是|允许|需价/按动作|按动作或可省略|按列表/详情选择报价和权限。|
|episode_apply|memory|是|允许|需价/按动作|action, reason_code|按 actor/scope 及可见锚点。|
|content_post_create|content|是|关闭|需价/按动作|body, idempotency_key|原帖写入仍要求 body。|
|content_comment_create|content|是|关闭|需价/按动作|post_id, body, idempotency_key|按源帖权限；正文仍要求 body。|
|content_posts_list|content|是|关闭|需价/按动作|按动作或可省略|源可读的日常帖。|
|creation_save_artifact|content|是|关闭|免费|format, content, client_operation_id|content 是 SVG/HTML 源码，应保留结构语义。|
|wake_manage|wake|是|关闭|免费|operation|schedule 须自约开关；absolute/relative 和 operation_id 分动作校验。|
|background_complete|turn|是|关闭|免费|outcome|本轮活动 attempt；done/noop，已接受结果可幂等重放。|
|chat_send_text|conversation|是|关闭|免费|text, idempotency_key|实测发话；心跳 purpose 受理，模型可见 text。|
|media_import|media|是|关闭|需价/按动作|source_url|受既有导入和来源策略约束。|
|chat_send_attachment|conversation|是|关闭|免费|asset_id, presentation|须可发送资产与合法 presentation。|
|call_control|voice|是|允许|需价/按动作|action|须合法通话状态；按动作执行。|
|oido_analyze|oido|是|允许|需价/按动作|按动作或可省略|须合格会话音频和服务能力。|
|chat_send_voice|voice|是|关闭|需价/按动作|text|须语音配置及合法来源；本次未实际合成。|
|media_search|media|是|关闭|需价/按动作|query|chat/photos/stickers/creations 范围，受目录、索引、可读性限制。|
|oido_get|oido|是|允许|需价/按动作|analysis_id|按 analysis_id 及来源资格。|
|transcript_read|voice|是|允许|需价/按动作|按动作或可省略|只读当前会话合法转写。|
|oido_capabilities|oido|是|允许|需价/按动作|按动作或可省略|读服务可用能力。|
|oido_view|oido|是|关闭|需价/按动作|analysis_id|按分析引用读允许的视图。|
|oido_find|oido|是|关闭|需价/按动作|audio_ref, query|音频引用及查询。|
|oido_compare|oido|是|关闭|需价/按动作|left, right|两份可见音频引用。|
|identity_milestone_write|identity|是|关闭|免费|operation|读/修订由 operation 决定。|
|wishstar_write_star|wishstar|是|关闭|已配|content, visibility, idempotency_key|实测用 content 成功，text 被拒；源验回执。|
|wishstar_read|wishstar|是|关闭|需价/按动作|what|按 what 聚合读；不提供对共享星写回应。|
|wishstar_start_session|wishstar|是|关闭|需价/按动作|special_date_id|真实特殊日资格。|
|wishstar_confirm_session|wishstar|是|关闭|需价/按动作|session_id|已存在的合法仪式。|
|wishstar_take_star|wishstar|是|关闭|需价/按动作|session_id|仪式取星，有副作用，不可当历史候选读取。|
|wishstar_finish_session|wishstar|是|关闭|需价/按动作|session_id|只结束相应仪式。|
|wishstar_request_star|wishstar|是|关闭|需价/按动作|按动作或可省略|开星请求，与回复已共享星不同。|
|wishstar_respond_request|wishstar|是|关闭|需价/按动作|request_id, decision|接受/拒绝别人开星的 request_id。|
|wishstar_offer_star|wishstar|是|关闭|需价/按动作|star_id|须可递交的 star_id。|
|wishstar_accept_offer|wishstar|是|关闭|需价/按动作|offer_id|须有效 offer_id。|
|context_review_complete|context-review|否|允许|免费|review_id, decision|只有活动换窗评审可发现/执行；心跳目录剔除。|
|memory_words_write|memory|是|允许|需价/按动作|action, memory_id, refs|业务参数是已见引文引用，不是自由正文替代品。|
|conversation_archive|archives|是|关闭|需价/按动作|kind|按归档类型与当次可见范围。|
|memory_relations|memory|是|允许|需价/按动作|action|根据 action 校验可见记忆与关系。|
|image_generate|imagegen|是|关闭|需价/按动作|prompt, client_operation_id|用户预算与资格仍适用；仅跑假图服务测试。|
|content_albums_read|content|是|关闭|免费|按动作或可省略|仅所选可读集合，支持游标。|
|content_album_entry_write|content|是|关闭|免费|kind, asset_id, idempotency_key|向既有 asset 建/改成员，权限/落正/幂等与 UI 共用。|
|media_view|media|是|关闭|免费|asset_ref|需要有效 asset_ref，回传真图片块。|
|content_creations_read|content|是|关闭|免费|按动作或可省略|读作品与原资源，受源状态约束。|
|archives_search|archives|是|关闭|需价/按动作|query|会话可读存档。|
|heartbeat_draw|heartbeat|是|关闭|免费|card_number|仅 keepwarm 的当前有效 draw 轮，整数选号，经真实后继请求才消费。|

## 可发现与可执行的差异

- tool_catalog 和 tool_define 为只读发现入口；deferred 的 tool_invoke 再按真实名称映射，不能绕过冻结版本、目的和参数检查。新 direct 心跳冻结的业务工具 55 个，另有两个发现入口；deferred wire 仅三个。合格目录的实际短列表在这次样本为 5,013 UTF-8 字节。
- 现有回复星缺口没有登记行。源服务已有 stars/{star_id}/responses，真实目标、actor、type、text 及重试身份是其写入所需事实。wishstar_respond_request、wishstar_offer_star 都是其他业务。
- 当前实际长链执行了 draw、星写入、记忆写入、聊天发送、完成和终态后的合法未执行回执。调用 tool_catalog/define 并看到另一个能力只能证明发现；剩余条目的条件依据装配与既有单能力证据。无 background_tool_prices 时，wishstar_write_star 与 memory_hold 可列出，却会在报价门停下。产品的预算门需要保留。
- 旧窗兼容描述符为 episode_list / episode_get（由 episode_read 取代），wishstar_hidden_stars / wishstar_special_dates / wishstar_list_offers / wishstar_notifications（由 wishstar_read 分项取代）。已核对切换时活动窗，这六个名字均不在其冻结目录。同一快照里每个名字均出现在 2 个 CLOSED 窗的历史目录。执行器的旧别名可在确认没有可恢复旧执行后分别退出；两个历史窗仍需能原样解码/回放，不可改写其协议。

## 投影体积与下一步引用

合成样本按紧凑 JSON 的 UTF-8 字节计。写星的源服务回执 180 B，模型回执 67 B，保留 id / visibility / state；确定写记忆的模型回执 83 B，包括 saved、memory_id、version、source_status；发送文字 62 B（含生成的消息 ID），完成 35 B，同批未执行 48 B。同一合成共享星列表行 112 B，卡面模型协议 189 B，加入了卡号和数据权威标志，却没有后续回复目标。源文本仅在已交付协议中保留一次，动作引用应采集成功源回执，不逆解析模型文本。

同一业务的 deferred 定义回执实际为 draw 342 B、写星 1,036 B、写记忆 3,004 B、聊天 632 B、完成 395 B；API direct 对应“已提供定义”回执为 96、101、93、96、101 B。SDK direct 返回完整定义的实际结果为 342、1,388、3,356、736、395 B。后续修订要保留可操作目标、版本、错误码和真实剩余号。当前没有旧生产版本相同输入下的通用“瘦身率”；源回执与模型回执、不同目录交付模式分别比较，不混作升级前后跑分。
