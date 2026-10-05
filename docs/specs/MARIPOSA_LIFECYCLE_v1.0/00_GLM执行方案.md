# estómago × Mariposa：语义事件生命周期与自主 hold · GLM 执行方案

版本：v1.0 · 2026-10-05  
整理：林石见；执行对象：GLM；业务决定者：宿主用户  
状态：**基于架构包与真实源码的实施设计，尚未实施、部署或运行产品验收。**

## 0. 任务目标、基线与执行边界

把“主模型判断一件事是否仍在继续／暂停／已经结束”接到现有 Mariposa，和 estómago 的原文保存、自主 hold、换窗提醒正确衔接。不要另建记忆库，不复制 claude-mem 的后台摘要链，不要求每段聊天都生成一个事件或一个桶。

本次确定采用：**主模型判断语义；estómago 管技术会话、消息、提醒和调度；Mariposa 管正式记忆、原文证据及可选的跨入口语义事件状态。**“所有生命周期都放 Mariposa、estómago 只是运输”不作为实施要求。

实际核对的基线：

| 材料 | 本次状态与用途 |
|---|---|
| `estomago_architecture_v0.2.1.zip` | 已解包核对主架构、执行规章和修订说明；是设计包，不是已运行代码。 |
| `estomago_OR1h_self_hold_checkpoint_GLM_v0.3_2026-10-05.md` | 已读取；对自主 hold、无摘要、换窗检查、56k/64k、6h 和 OR 1h 缓存的后续口径优先。 |
| Mariposa 本机 checkout | `/Users/owner/Projects/mariposa`，`main`，`90d730ec2ba1fdaba1f73daa471630afd7c3b33c`；检查前后工作区干净。 |
| estómago 本机实现 | **未在本次审计中读取或验证。**下文 `apps/host/...` 来自架构包，是建议落点；GLM 开工先映射现场，不能覆盖已有代码。 |
| 生产数据库、模型调用与测试 | 未读取生产记录，未执行迁移，未运行 pytest、SDK、OR 或模型烟测，未修改配置、凭据、VPN、Tunnel。 |

证据范围及文件 SHA256 在 `01_源码证据与差距.md`。附带的架构文本只是来源，不与本文冲突条款并列执行。效力顺序：宿主用户最新明确决定 > 本任务本文明确的增量 > v0.3 未被修改的条款 > 当前 Mariposa 业务合同 > 旧架构参考。源码描述用于说明已有实现，**不是自动批准把所有现状变成业务规则**。

本轮不重做检索、Jev、COUNT 预算、分类、衰减、明开回温、心情/回忆权限、删除申请或四域关系纠错。不实施新的通用关系图、事件自动合并、记忆自动删除、Keeper、小模型巡检、定时 LLM 保温。新的接口与表名均为设计目标，不能写成已经存在。

## 1. 先把四类东西分开

| 对象 | 它回答什么 | 所有者 | 不能拿它推导什么 |
|---|---|---|---|
| room／conversation、turn、context epoch、SDK session | 这条消息在哪里处理、使用哪个上下文、请求是否结束 | estómago | 不证明一件生活事件已经结束 |
| semantic episode（下称 episode） | 被明确跟踪的一次事情是继续、暂停还是闭合 | Mariposa；主模型做语义裁决 | 不证明必须 hold、不能改变 plan 终态 |
| memory／hold | 主模型决定正式记下什么 | Mariposa | 写好桶不等于事件结束；没有桶不等于失败 |
| Recall Session | 一次检索及其轮次、拒绝、接受、额度 | Mariposa 的既有 recall 运行域 | 不能当聊天 session 或 episode 使用 |

`CLOSED`、`hold 成功`、`review 完成`、`window 已换`是四个独立事实。允许事件已结束但不 hold，也允许事件未结束先 hold 已发生的部分。真正跨多天的待办继续使用现有 `plan`；不要把“直到计划做完”当所有相关 episode 的结束条件。

最小路径无需 episode：普通聊天 → 主模型自行决定是否调用 `memory.hold` → 真正需要换窗时做一次提醒。**没有 episode 也必须能聊天、hold 和换窗。**完整交付包含 opt-in episode 能力，但它不能成为普通聊天的必经步骤。

## 2. 语义闭合如何判定

### 2.1 主模型有判断权，也有不操作的权利

只在主模型明确认为一件事情值得跨回合/跨窗持续跟踪，或用户明确要求跟踪时创建 episode。普通回合没有状态变化，就不调用事件工具，不返回强制隐藏 JSON，不创建“等待补记”任务。

判断参考即时目标、场景、因果连续性、明确收束和原文证据。不用关键词规则、embedding 阈值、沉默时长或另一个模型代替裁决。无法判断时保持现状；确实是暂时离开、等待后续时可标 `QUIESCENT`。

三态：`OPEN`（正在延续）、`QUIESCENT`（暂停而未宣告结束）、`CLOSED`（已经作出明确闭合判断）。

### 2.2 转移合同

| 动作 | 当前状态 | 结果 | 必要条件 |
|---|---|---|---|
| `start` | 不存在 | `OPEN` | 主模型或获授权拥有者明确选择跟踪；真实来源锚点 |
| `continue` | `OPEN` 或 `QUIESCENT` | `OPEN` | 同一次事情；可以追加新的不连续来源片段 |
| `pause` | `OPEN` 或 `QUIESCENT` | `QUIESCENT` | 暂停/等待；没有闭合证据 |
| `close` | `OPEN` 或 `QUIESCENT` | `CLOSED` | 模型明确认为本次事情收束；指定截至何处与判断依据 |
| `correct` | 已存在 | 经校验的纠正状态/范围 | 明确 `boundary_error`；保留原决定与修订，不改原文、不自动改桶 |

所有动作都有稳定 `operation_id`。除 start 外携带 `expected_revision`；版本冲突先读取新状态再判断，不能自动把旧判断盖到新版本上。同一操作重试返回同一结果。不同操作重复 pause 可以返回 no_change，不制造无意义状态历史。

`CLOSED` 不接受普通 continue。后来提起旧事通常是新事件或普通引用，根本不一定要建新 episode；确为先前误判，则经 correct 纠错恢复。禁止把每次“又聊到了”都当纠错，禁止自动 merge 原桶。

### 2.3 需要纠正此前讨论的两个推导

**新话题出现，不自动等于旧事件结束。**A 讨论到一半去聊 B，A 可暂停，之后恢复。允许同一 scope 同时存在多个 OPEN/QUIESCENT episode，不能加“每房间只有一个未闭合事件”的唯一约束。宿主可记录当前关注的 episode，但这个 UI/运行指针不支配其他 episode 的状态。

**技术断开不自动等于语义暂停。**关闭页面、网络掉线、一次 Stop、旧窗退出只写宿主运行状态，不群发 pause，更不能群发 close。尤其不能让一个客户端掉线暂停另一个入口正在继续的同一事件。主模型主动表达暂停才写 episode.pause；没有语义操作也不影响技术窗口休眠。

### 2.4 时间、来源与“不连续”

服务端记录 `created_at`、`updated_at`、`closed_recorded_at`；最后一项是“何时记录了闭合决定”，不是事件实际结束时间。`terminal_source_ref` 指明本次事情的最后一个有效原文位置；`decision_source_refs` 指明作出判断所依据的原文。次日才判断昨日已结束时，两者日期可以不同。

A 的话在 m1–m3，B 插入 m4–m8，A 在 m9–m11 继续：A 的范围必须是两个片段，不准自动扩成 m1–m11 把 B 全吞进去。每段内部仍遵守既有 parent 路径与 Unicode code point 半开偏移规则。缺可靠时间时留 unknown，不把服务端时间硬填为发生时间。

### 2.5 不创建第二套“故事摘要”

episode 第一版只保存短标签、状态、修订、来源片段、闭合依据、作用域和审计信息。短标签建议上限 80 个 Unicode code point，仅供列表导航，不承担叙事，不参与记忆搜索；不增设 current_story、running_summary、scene_summary、未完故事等长文本槽。

真正的记忆写原有 hold，真正待办写原有 plan。episode 不保存独立事件正文，不复制 plan 状态，不持有新的永久 memory↔episode 业务关系。正式桶的来源仍通过 `memory_source_bindings`。模型需要详细前情时读取获授权原文/记忆，不用一份自动滚动卡片顶替历史。

## 3. 真实代码要求先补的接口缺口

### 3.1 原文不是现成的在线追加服务

目前 `source.import`、`source/importer.py`、`source/archive.py` 是导出文件快照导入链。`source_messages` 有发布门、parent 与 hash；`source_message_versions` 保存的是版本 hash 和批次定位，不是直接可读的每版正文。导入同 UUID 的不同内容会留版本证据，但不覆盖首次保存的主行。

因此不能把“每条聊天落库”直接说成调用现成 append；也不能每轮重写一个越来越大的伪 Claude 导出，再调用 source.import。新增窄范围实时入口，复用 Source 存储与可重建索引，而不是重建第二套原文库。

### 3.2 hold 有事务内写入，但还没有同事务完成回执

`memory/service.py::hold_in_tx` 已能在调用方事务内写正式桶。`relations/corrections.py::atomic_write` 已能把业务写入与 `op:` 完成记录一并提交。

然而当前 `memory.hold` schema 无 operation_id，handler 未走领域 atomic_write，`transport.py::_DOMAIN_IDEMPOTENT_CAPS` 也没有 memory.hold。现有传输幂等能保护通常的重复请求，但业务事务提交后、外层完成记录写入前崩溃，仍可能只得到 OUTCOME_UNKNOWN。这是新增自动化前必须补足的恢复缺口，不等于本次已跑出重复建桶事故。

### 3.3 绑定接口可以复用，但要补全版本钉住

`source.binding.bind(..., conn=...)` 已支持复用事务；`query.validate_range` 当前却自行打开读连接。hold 与来源绑定合并提交时，需要增加同事务校验路径，不能在写锁内读另一份旧快照或找不到本事务新记录。

绑定现在钉住首尾 hash。在线编辑场景还必须保护**中间每条消息**的修订与次序。新增 pinned selection/manifest；现有首尾兼容字段保留，不能把“首尾 hash 一样”当整段来源未变的证明。

### 3.4 客户端授权与开窗 profile 也需要接线

当前身份由 bearer token 对应 `client_bindings` 解析，registry 主要按 principal 授权；不是现成的房间级在线归档授权。bootstrap 当前只接受 `claude_chat`／`cc` 对应 entry_source。

在线归档需有绑定到 stream/scope 的受限服务凭据。主模型业务调用则使用批准的 jiaming 绑定。不能让普通 worker 代写正式记忆，也不能用参数 `actor_id=jiaming` 冒充身份。estómago 的新 entry/profile 应明确登记，不伪装成 cc 绕过校验。

## 4. WP1：在线原文同步与不可变引用

目标逻辑能力名：`source.ingest`、`source.ingest.status`。新增前检查真实名称冲突；HTTP/MCP 如暴露同能力均走 registry 的相同 handler、schema 和权限，不建旁路 API。自动归档由宿主代码执行，不要求模型逐条调工具。

### 4.1 宿主写入顺序

真实用户提交、助手正式发布 → 同一本地事务写 message/revision 与 outbox → 返回本地已保存 → outbox 按固定 operation_id 同步 → Mariposa 验证、提交 → 宿主记录远端 ACK。

尚未发布的草稿、thinking、工具内容、控制事件、时间包、提醒、SDK 原始 transcript 不进入这条原文投影。音频沿既有 Siren 语义，只同步符合正式消息边界的转写/文本和授权资产引用。保留原发生时间与发布/接收时间，服务器序号用于排序。

断网时消息仍可本地持久保存，界面显示“原文同步待完成”，不得显示已经入 Mariposa。没有同步成功的来源不能冒充可被 Mariposa 全库检索；不要求因所有闲聊没绑定就阻止换窗。

### 4.2 建议的最小 Source 扩展

采用既有 Source 表作为原文实体；在线来源用真实 `provider=estomago` 和明确 live ingest kind，不冒充 Claude 导出。复用批次/归档/发布基础设施时，需区分 `export_snapshot` 与 `live_delta`，后者是有限追加事务而非整房间快照；不要每条消息复制全部会话快照成员，造成平方级增长。

推荐新增一个在线来源谱系索引 `source_live_revisions`：

- `(stream_id, origin_message_id, revision)` 唯一，对应一个不可变 `source_messages.id`。
- 保存原会话 sequence、前版引用、canonical source hash；消息 revision 不与 episode revision 混用。
- 每个修订都有实际可读正文/资产引用，优先复用 Source 的不可变行与 Raw Archive。不是只记录 hash 却无法读回该版。
- 物理 Source ID/provider_message_id 必须将实例、房间、逻辑消息和修订做无歧义命名空间编码；用规范化结构 hash，不裸拼字符串。业务 room 不因换窗/跨日/SDK 与 API 模式切换而改名。
- 当前在线消息投影按明确最新有效 revision 选择；旧版保留用于证据读取，不能使普通原文搜索同时返回所有历史改稿。

在线新修订可拥有自己的不可变 Source 行，不覆盖旧 Source 行。GLM 若采用等价的版本正文表，可以调整物理落表，但必须在 WP0 说明映射，满足本节所有测试；不能靠省略原文修订来缩小工作量。

`source_conversations` 与 `source_messages` 现有 batch 字段非空。实时入口要实际生成对应的 live batch 元数据、归档 hash/路径和完成态，或做明确兼容迁移；不能填一个并不存在的 completed 批次 ID。原有 export importer 的发布门、失败重试、母本保护均不能取消。

### 4.3 原子性、乱序与幂等

每个 ingest 请求有固定 op、有限条数/字节和每条来源身份。先完成受控原文字节保存及 hash 核对，再在短正式库事务中写来源行、谱系、投影、审计和完成 ACK。磁盘与 SQLite 不是同一个事务；磁盘残留只可成为待核对孤立资产，不能存在“ACK 已成功但原文母本还没写成”的正常路径。

同 op 同 payload 重放原 ACK；同 op 不同 payload 冲突。同 `(stream,msg,revision)` 同内容去重，不同内容拒绝，不能静默修改。同 room 并行消息以 Host 的 authoritative sequence 为准，不由接收时间重新排序。

初版按每 stream 有序 outbox 处理；缺 predecessor / 缺前版时明确返回可重试依赖缺失，或停留未发布候选，不把断链来源纳入可绑定范围。崩溃重启按源身份恢复，不能换 operation_id 盲建新记录。

### 4.4 精确片段合同

通用 `source_selection` 是若干**有序、版本固定的片段**，不是一条故事摘要。每个片段有 conversation、明确的成员 Source ID + content_hash，必要时有首尾字符偏移。多段允许间隙，客户端不能靠 `min/max sequence` 伪造连续覆盖。

Source 层验证成员同属获授权 scope、published、parent 路径/分支一致、修订有正文、hash 正确、偏移合法。TS 与 Python 均采用 Unicode code point，不用 JS UTF-16 length 直接传入。支持明确旧修订证据读取，但不能将旧内容混入默认“当前消息”投影。

建议新增 `source.selection.open`，或对现有 range.open 作有版本的向后兼容扩展，支持按此 manifest 读回。本包用前者作逻辑名。旧 range.open / source.binding.bind 继续按旧合同工作；新写入路径保存全部成员 manifest，旧记录不回填猜测的证据版本。

正式 hold 的绑定可为每个片段写一个既有 binding，并增加绑定成员证据表/manifest 指针；绑定纠错依旧走既有 Source 纠错接口与 `binding_error` 语义。原文编辑不触发自动解绑，不覆盖既有桶、不改其“我们的话”。

## 5. WP2：把 memory.hold 补成可安全自动化的写入

扩展既有 `memory.hold`，不另设 `auto_hold`、不另起模型。新增 `operation_id` 与可选 `source_selections`。旧字段、九分类、creation_mode、mood、our_words、plan_ids 继续走当前业务校验；旧调用不提供新增字段时保持兼容。**宿主新自动化路径必须提供 operation_id。**

执行形态：

```text
认证 + schema + capability/scope 校验
→ 统一构建规范化 payload
→ atomic_write(principal, memory.hold, operation_id, payload, fn)
   fn(conn):
     同事务验证所有已同步来源及所需 plan
     hold_in_tx(conn, ...既有字段)
     bind(..., conn=conn) + 固定每段全部成员修订
     写必要 audit
     返回最小完成回执
→ 同事务存 completed operation
→ 提交后返回 ACK
```

已有 atomic_write 可以窄范围复用，或提取为中性的共享模块、让旧 import 重导出兼容；不要为这一任务重构整个能力框架。正式库与 source 都按当前实际数据库边界实施；若未来拆库，不能仍宣称这是一笔跨库原子事务。

扩展 `input_schemas.py`、`registry._hold`、`transport._DOMAIN_IDEMPOTENT_CAPS` 及 payload builder；hash 默认值处理、参数剥离、重放比较共用同一规范化函数。op 与 transport 的 `op:`／`t:` 名字空间继续分开。同一个领域操作换了外层重试 key 仍只能生成一个桶。

完成回执至少有 operation_id、memory_id、version、binding_ids、committed_at；不把整段私人正文存成可无限重放的出站缓存。增加受权限保护的 `memory.hold.status(operation_id)` 或等价已证明可定位的回执查询，以解决 ACK 丢失。没有记录只表示该操作尚无提交证据，不代表别的 operation 没写过同一件事。

已经提交后再删桶，原操作重试不得重新造桶；回执表达历史成功与当前资源状态分别处理，不重放已删正文。OUTCOME_UNKNOWN 仍适用于不能由领域回执证明的其他旧能力，不全局删除这个保护。

来源绑定失败或哈希不符时，整个“本次带来源的 hold”回滚，不能先留半个桶再说绑定成功。没有 source_selections 的既有手工 hold 继续合法。显式选择要带来源的本次写入，不得在失败时偷偷去掉来源重试。

### 5.1 和 episode 的关系

第一版不增加 memory↔episode 的第五套正式绑定域。两者通过明确原文范围与宿主操作相关 ID 追踪，桶↔原文继续用既有绑定。episode.close 与 memory.hold 是独立命令，不暗中互相调用。

因此“事件已 CLOSED、一次已选择的 hold 正在恢复”可以是真实状态。UI 必须分别显示；有未确认的 hold 意图时不允许用 no_new_hold 掩盖失败。模型可以后来明确放弃一个**已确认未提交**的写入意图，但不能取消一个结果未知的副作用来假装没发生。无需建立跨服务大事务来强迫两者同成同败。

## 6. WP3：可选 episode 服务，只保存最小状态

建议新增 `backend/mariposa/episodes/service.py`；第一版能力收敛为：

| 能力（拟新增） | 用途 |
|---|---|
| `episode.apply` | start／continue／pause／close／correct；明确动作和版本 |
| `episode.get` | 按 ID 返回当前状态及必要证据引用，无正文默认展开 |
| `episode.list` | 在明确 scope 内分页读取状态；不给全库未完故事 |

三者经同一 registry 暴露 HTTP/MCP。apply 只准拥有者主体；主模型正常使用 jiaming，宿主用户可明确纠错。worker、在线归档受限凭据、其他 scope 一律拒绝。读写、重放、列表分页都先验当前授权，不能靠已缓存结果绕过撤销。

### 6.1 逻辑数据模型

新增一张 `semantic_episodes` 当前态表即可起步：

```text
episode_id, scope_id, label, state, revision,
source_selections_json, terminal_source_ref,
decision_source_refs_json, last_reason_code,
created_by, created_at, updated_at, closed_recorded_at
```

不建长期模型任务队列。操作完成记录复用 idempotency_records；变化审计复用 audit，记录动作、前后状态/版本、来源身份、绑定身份和简短原因，不复制聊天正文。纠错必须可从 audit 找回被纠正的边界与决定。确需独立 history 表才能满足现有审计保留策略时，GLM 说明理由再做等价实现，不默认扩成一套事件总线。

scope 是经服务端授权映射的真实关系/会话范围，不能只是任意模型字符串。列表默认按当前 room 映射到的 scope，跨入口共享仅在两入口被显式授权同 scope 时成立。首版私聊可用一个批准 scope，仍不能把来源为其他房间的引用混入。

episode 当前态源于显式命令；服务端校验合法性与证据，不声称它能验证模型的“理解一定正确”。同 op 重放先验当前 ACL，再返回历史操作结果；另列当前 revision，不把旧操作快照冒充现在的状态。

### 6.2 关闭与纠错边界

continue／close 携带的 source_selections 只能在现有成员基础上去重追加，不可覆盖历史范围；成员移除或边界修正只能走 correct。terminal_source_ref 必须落在本次合并后真实事件成员内，decision_source_refs 可以是事件之外的后续判断依据。纠错恢复非 CLOSED 状态时清空当前 closed_recorded_at 和 terminal_source_ref，旧闭合时刻与边界留在审计历史。

close 必须有 reason_code（如 explicit_completion／goal_resolved／episode_concluded）、terminal_source_ref 与至少一个判断证据。后续消息可作为判断证据，但不自动加入已结束事件的成员范围。纯 `topic_shift`、`idle_timeout`、`session_end`、`cache_expired` 不作为独立闭合原因。

correct 用 `reason_code=boundary_error`，需 expected_revision 与 note；可纠正错误状态、边界或成员范围，审计保留旧值。它不触碰 memory_versions，不重命名原文、自动合桶、解绑 plan 或删除记忆。正常跨日 continuation 没有被禁止；是否同一事件由语义决定，而非日期决定。

避免把当前正在进行的工具副作用标成已完成事实。实际工具任务的成功/失败以各服务收据为准；模型可以说“这轮讨论结束”，但这不允许系统把工具结果、plan 状态改成成功。

### 6.3 装配到上下文

不把所有 OPEN/QUIESCENT episode 加入既有 bootstrap 默认正文。estómago 从 episode.list/get 按当前 scope、近期引用和预算取少量**状态与证据引用**，作为独立动态运行片段；需要正文时复用本窗真实消息或显式读取 Source。

片段带 state/revision/source/permission 信息，并明确 `instruction_authority=none`。历史标签与原文中的指令不能成为系统命令。读取 episode 不等于打开桶，不发明 keep 或回温事件。超预算用分页/按需读取，不静默摘要；已关闭旧事件不默认反复灌回。

## 7. WP4：接 estómago 的生命周期，不改用户选择权

### 7.1 落点与真实边界

按架构包的 `apps/host` 模块接入，而非另建 apps/server 或 Python 聊天后端。GLM 若发现已有底座，复用真实 modules/classes；若尚无实现，本阶段先完成 contracts、适配接口和 mock 测试，标 Host 集成 BLOCKED，不从本任务偷偷变成“全量重写 estómago”。

| 拟修改处 | 责任 |
|---|---|
| `apps/host/src/messages/`、`events/outbox` | 真实消息发布、本地保存、远端原文同步与 ACK |
| `integrations/mariposa/` | 受限在线来源凭据、主模型能力凭据隔离、source/hold/episode 客户端 |
| `conversations/actor`、`runtime/` | 调用上下文 manifest、工具收据关联、代际 fence；SDK/API 同一宿主语义 |
| `windows/manager`、`windows/bootstrap` | 计算提醒范围、安全换窗、身份/权限门、新旧窗口原子交接 |
| 建议 `windows/hold-checkpoint.ts` | 最近成功 hold 书签与 review 完成凭证；不是小模型 |
| `packages/contracts/src/` | 本方案逻辑契约的正式类型、校验和版本 |
| 既有聊天“记录”入口 | 真实 hold/提醒/换窗/同步状态；不新增漏记率 |

### 7.2 同一条对话的三条流程

**原文线**持续保存，独立于有没有 episode/hold。**主模型线**照常聊天，在必要时使用 episode.apply 和/或 memory.hold。**换窗线**由宿主容量/回合/版本/静默条件触发，不由 episode CLOSED 触发。

已有 plan 仍通过 plan.* 调用；不要为待办再造 episode 内部 unresolved 文本清单。发生意外断流，回合 finalizer 记录技术中断，未发布增量丢弃，已发布消息和已提交工具副作用保留。

### 7.3 主模型已见 manifest 与 hold 书签

每次实际模型请求保存一个受保护的 dialogue_manifest：真实 message ID、revision/hash、序号、scope，以及本次实际装入的内容；区分历史聊天、显式检索资料、控制事件、工具结果和模型协议块。

收到 memory.hold 正式提交 ACK 后，只推进**发起这次 hold 的那个请求／旧窗**对应的“模型已见聊天高水位”书签。不用桶的发生日期、不用所绑原文最大 ID、不用 ACK 到达时房间最新消息。后台导入、其他 room、其他入口的 hold 不自动移动本窗书签。

同一 op 的重复 ACK 不再次推进；同窗多个 ACK 乱序到达不能让高水位后退。迟到 ACK 只更新原窗口运行记录，不污染新窗口。宿主为模型输出的稳定 tool_call 创建一次 op，重试沿用；模型发起两个不同 op 并不保证服务端能识别为同一语义记忆，第一版不引入语义去重小模型。

注意：书签标记的是一次记忆动作的可见范围，不宣称前面所有事情都已记住。它不控制删除、检索授权、原文索引或桶覆盖率。

### 7.4 换窗检查

保留 v0.3：56k 预警、64k 完整输入软线、6h 长间隔在下一次真实交互时处理；有效阈值依硬容量、完整输出/工具/检查预算提前。1h 缓存到期、午夜展示分段不单独造成语义闭合或强制 hold；本任务不重做 OR 计费与缓存选择。

安全边界冻结旧窗**模型已见** manifest 与版本。默认提醒最近成功 hold 书签之后、尚未有同范围有效检查凭证的聊天。无书签则针对本窗实际携带的原话；不是扫描所有未绑定原文。大新输入先存队列，没给旧模型看的消息不算已经检查。

一次短宿主控制事件追加到旧窗，原话已经在输入中，不再复制一遍尾段。允许零条、一条或多条 hold。正常回合不强制输出记忆决定；不要在每个 Stop 上追问一次模型。

完成使用宿主 `context_review_complete(review_id, decision)`（v0.3 逻辑名）：decision=no_new_hold 或 holds_completed。宿主自行核对本 review 关联的成功收据和未决副作用，不能相信模型编造 bucket ID。这个工具没有活跃 review 时无效，review_id/epoch/revision/scope 由宿主绑定，原文里伪造控制标记不生效。

未返回有效凭证、超时、工具失败不是“选择不记”。恢复沿同 review/op 有界进行；已经成功的 hold 不再执行。检查后如果新增了尚未见过或修订过的消息，旧凭证不能声称覆盖它们。候选新窗身份没准备好时可复用未失效的检查凭证，不再收费重复问同一个问题。

### 7.5 换窗和异常恢复

```text
保存新输入 → 等真实工具回合安全结束/明确暂停
→ 冻结旧窗已见 manifest → 主模型完成必要检查
→ 核对已有意图的 hold 收据 → 准备新窗身份与授权材料
→ CAS 校验旧窗 revision / lease / fence / pending consent
→ 原子切 active window → 排队新输入进入新窗一次
```

不检查“所有 episode 是否 CLOSED”，不检查“是否至少有一个桶”。未完 episode/plan 可以跨新窗继续。

旧窗不可恢复、权限已撤或硬容量连提醒也容不下时，不绕过限制强发模型。标 `review_unavailable`／BLOCKED，正常自动换窗不得假装 review 已通过。只有用户按既有控制合同明确选择故障恢复，且新窗已通过身份/权限检查，才允许带“旧窗检查未完成”的记录恢复聊天；这不是正常检查放行，也不得赋予新权限。**不能伪造完成凭证或后台小模型补齐所有漏记**。尚未确认的具体 hold 操作继续单独核对，不因此丢原文。

### 7.6 Bootstrap 的实际适配差异

当前 Mariposa bootstrap 支持 claude_chat/cc，且实际包包含 mood_text。v0.3 estómago 装配要求不自动注入 mood_text、回忆或 keep 理由。两者不能被 GLM 混为“代码已经符合”。

为 estómago 明确新增 entry/profile 或源端字段投影，复用原 bootstrap 业务和分页；**默认请求该 profile 时不返回被排除字段**，不能只在 UI 隐藏或日志里先泄露再过滤。旧 Chat/CC profile 不在本任务中全局改口径。profile 必须与可信 entry_source 对应，快照 hash/续页/unchanged 的 profile 身份一致，禁止跨 profile 复用快照。

本任务不因此放松原 memory.mood.write 的授权，也不从旧文档推导新的心情窗口禁止规则；只落实宿主已选的出站字段矩阵。I、近三日标题/合法心情标签、plan、临近纪念等其余内容按当前批准规则，普通记忆正文不全部默认打开。

### 7.7 其他 MCP 入口的实际能力边界

Claude.ai、CC 可使用相同 Mariposa episode/hold 能力，共享的是经授权的**状态正本**，不是自动共享整段聊天。MCP 本身不通知宿主“网页刚刚关闭”，也不保证平台会调用结束工具；没有宿主 hook 的入口只能按其实际能提供的调用/原文同步能力接入，缺失标 unavailable。

不能为了所谓全入口一致性，让 Mariposa 模拟所有平台的窗口管理。API 模式没有 Claude Code hooks 时，由 estómago 自己的 turn finalizer/Window Manager 产生技术检查点；SDK 的 Stop/PreCompact 只是额外信号，不是唯一真源。

## 8. 权限、可见性、资源与迁移要求

在线 ingress 采用新受限 binding 的 capability/scope allowlist，或等价独立窄服务认证。现有 owner/editorial token 不发给自动归档 worker；受限 token 即使 principal 映射同 owner，也必须在 registry 分发前拦住 memory.hold、I、删除等所有非白名单能力，工具列表同样过滤。不能只限制 tools/list 而 HTTP 仍可调用。

每个在线 stream 预先绑定 origin instance、room、允许 speaker 与拥有者 scope；客户端参数只提供定位，不授予权限。并发或重放都必须重新检查 binding 撤销。跨 scope Source ID、episode ID、review ID 不得成为探测私人内容的手段。首版只接批准的私聊 stream；群聊/第三方房间没有真实 ACL 之前不开放自动归档。

schema 使用有限条数/字节和 strict additionalProperties；所有长原文、来源列表和输出分页，不能靠全库扫描解决范围校验。每个写事务内只做本地校验和短写入，不调用 LLM、不等网络。模型调用数正常聊天不增加；状态更新及读取自身不调用任何模型。

新增 migration 不覆盖既有编号。当前源码可见 formal 编号到 28、recall runtime 到 13；这只是**源码定义**，不是已查询到的生产 schema 版本。GLM 开工以现场 HEAD 与实际隔离库迁移结果为准，分域选下一个编号。

不执行生产导入/补桶/扫描全量聊天；现有 memories 不因这次升级补 OPEN 状态。新功能关闭时旧接口继续可用，新增保存数据不删除。回滚先关闭新写入/轮转扩展，再运行兼容代码；有新 schema 的库不能靠 git checkout 强退旧版本。正式库变更需独立授权、验证一致性备份与恢复，不在交付设计时顺手迁移。

## 9. 工程工作包与退出条件

| 包 | 要做的修改 | 退出条件 |
|---|---|---|
| WP0 | 固定 HEAD/工作区/合同映射，阅读 AGENTS；确认 estómago 是否已有底座；列实际 API/数据/权限差异 | 提交 `00_baseline_map.md`；本次计划不被伪报成已实现 |
| WP1 | live ingest、受限 binding、不可变修订与 pinned source selection；复用原文域 | 原文重放/乱序/编辑/ACL/母本恢复用例通过，旧 import 回归通过 |
| WP2 | memory.hold 领域 op、同事务回执、同事务来源绑定、status 与 transport 恢复 | 提交后崩溃可按原 op 恢复，零重复桶，失败无半桶；旧 hold 兼容 |
| WP3 | opt-in episode.apply/get/list、CAS、scope、来源和边界纠错 | 闲聊零事件、交错话题不误关、已关纠错留痕；不更改 plan/phase/删除 |
| WP4 | estómago manifest、hold 书签、review、源端 bootstrap profile、gated rotation、记录面板 | 零 hold 放行，迟到 ACK/编辑/新窗失败/多入口/身份撤销行为有证据 |
| WP5 | 离线联调、契约验收、逐批回归、运行限制与恢复说明 | 每项 acceptance 有 PASS/FAIL/BLOCKED/NOT_EXECUTED 和证据；无假线上验收 |

WP2 的幂等核心与 WP1 可并行开发；带来源的完整 hold 联调须等 WP1 完成。WP4 可以先写宿主协议和 mock，不需要等全部 episode 完成才允许基础聊天。上线按可靠原文+hold、再宿主换窗、再 opt-in episode 的依赖逐项开启，不能先开强制自动闭合再补基础设施。

### 9.1 实际文件修改地图

| 项目 | 已有可复用文件 | 增量职责 |
|---|---|---|
| Mariposa | `memory/service.py` | 保留 hold_in_tx 与字段校验，接 op 与原文绑定封装 |
| Mariposa | `capabilities/registry.py`、`input_schemas.py`、`transport.py` | 新能力注册/严格 schema/受限 binding 授权/领域回据恢复 |
| Mariposa | `relations/corrections.py` | 复用 atomic_write；不改关系纠错的业务 taxonomy |
| Mariposa | `source/archive.py`、`importer.py` | 抽取必要通用归档/投影能力；新增 live ingest，不修改 export 语义 |
| Mariposa | `source/query.py`、`binding.py` | 同事务校验、固定成员修订、当前/历史证据分离、来源读回 |
| Mariposa | `identity/service.py`、`schema.py` | 窄 binding/stream scope、增量 migration、episode 数据 |
| Mariposa | `bootstrap/core.py`、`service.py`、`pages.py` | estómago entry/profile 与出站字段/分页/快照隔离 |
| Mariposa 新增建议 | `source/ingest.py`、`source/selections.py`、`episodes/service.py` | 单一职责实现；名称以 WP0 映射为准 |
| estómago 设计落点 | §7.1 表内 `apps/host` 与 contracts | 在真实底座中接入，不声称这些源文件已存在 |

不要为减少一次文件改动，把所有代码塞进 registry；不要把 episode 实现在 recall/state_machine.py；不要把回执变更扩散成重做所有现有能力的幂等系统。

## 10. 验收与交付

本包 `02_验收矩阵.csv/json` 给出 58 项离线/隔离联调验收，初始全部 NOT_EXECUTED。必须重点证明：

1. 普通闲聊零 episode/零 hold 仍成功保存原文、正常换窗；模型无须说明每段不记原因。
2. Stop、断网、午夜、6h、缓存过期、主模型换窗不自动 CLOSED；A→B→A 不错误合并/截断。
3. 任何已启动的 hold 在重试、崩溃、晚 ACK 后都能被明确定位；只凭真实完成回执推进正确窗口书签。
4. 带来源写入不伪造未同步 ID、不忽略中间消息修订、不跨 scope；原文和历史修订始终保存。
5. 新功能不改变 plan 独立状态、现有关系纠错、删除、phase、recall 预算或 mood/回忆写权限。

测试按项目 AGENTS：指定文件、`-x -q`、前台等待、显式超时、独立临时数据路径、模型/网络 mock；全量回归分批。不得使用生产 tokens、生产 Source 或本人聊天材料做破坏性夹具；禁止跑本机 dense 模型/无界 pytest/常驻新监控服务。实际 SDK/OR、生产接口、移动端联调单独授权，不用 mock 全绿冒充上线。

GLM 每个 WP 提交：修改文件、commit、契约变化、迁移范围、测试命令/退出码/数量/耗时、失败或未执行项、隐私与副作用声明。最终交付 `IMPLEMENTATION_REPORT.md`、已执行验收矩阵、schema/API 示例、故障恢复说明和差异清单；报告必须能让下一位审计者按文件/行号复核。

最终完成条件不是“自动存了多少桶”，而是：**该保存的原文可靠保存，主模型的选择被尊重，已经选择执行的写入可核实，语义状态不被技术会话误改，换窗后不靠伪造摘要维持连续性。**

## 11. 参考 claude-mem 的取舍

本次重新核对了其公开 `plugin/hooks/hooks.json`：Stop 调 summarize，SessionEnd 调 session-end。官方 Claude Code 文档把 Stop 定义为主代理完成响应的 hook，而非生活事件闭合。这里只借技术检查点的挂载思路；不引入后台 observation 压缩或 session summary，不复制其 Completed 为本项目 episode 的 CLOSED。

公开来源（2026-10-05 读取，main 与在线文档会变化，GLM 如依赖运行细节需再次固定版本）：

- https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/hooks.json
- https://github.com/thedotmack/claude-mem/blob/main/docs/public/architecture/hooks.mdx
- https://code.claude.com/docs/en/hooks#stop

本方案的表、字段、API 名称、episode 状态与验收是本项目设计，不冒称上述项目已有实现或官方推荐业务架构。
