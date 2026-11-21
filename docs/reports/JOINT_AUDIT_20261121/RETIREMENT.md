# 退役、兼容和复验

“已退出”在这里指已经查到实际消费者和替代路线；删除文件与停止业务写入分别记录。没有为审计删除代码。

|旧入口/消费者|当前替代与执行证据|状态、依赖及退出条件|
|---|---|---|
|首页相册示意上传，home/app.js 的 objectURL 和相册弹层|现行首页 index.html 装载 seasons.js、home-navigation.js；热点进入 /home/album；React 上传和业务 HTTP 已用浏览器实测。旧 feature?feature=album 也转同一应用。|旧业务入口退出当前首页，app.js 仍在静态白名单；能下载 JS 不等于页面执行。核对历史外链与 HTML 消费者后移除旧脚本/白名单。其他仍属示意的首页功能不在本轮退役范围。|
|新图片继续写 creations|image_generate 假传输测试和静态 SVG 支持子集走正式相册；遗留直接 POST creations 的普通 PNG 却返回 201 并可列出。|未退完，F07。保留有权威来源的纪念桶语义和历史作品只读回放；收口新纯图片来源与静态但暂不可渲染的 SVG。|
|资产上传后重走上传而非补关系|uploadAlbumEntry、sessionStorage 回执和 Content 协调器；B 的归类故障、刷新恢复实测只上传一次。|该场景已退出重复上传；不同用途重用同键的冲突尚未处理。M 正本、E 待同步暂存、媒体回源及衍生视图继续使用。|
|朋友圈拼正文、让模型重写或重新回灌聊天|heartbeat-moment:<run> 唯一操作，Content 以 reference 存结构；Host 读引用。不执行第二次模型。原生帖仍自行持有正文。|已测路径上未见模型重写或双份业务正文。旧“只根据消息”是仍在使用的不完整实现；F02 完成前不得退掉源业务回执、历史协议或把工具原始日志当正文。|
|心跳另开 session、抽完即结束|同 conversation/window/turn/run，S1—S4 中四次请求、两路 SDK resume；memory_hold 终结优化限定 chat 和已发正文。|该链已退出“一次工具即完成”的行为；SDK 的普通聊天旧优化有实际调用者，不要求删除，需专测心跳和聊天各自资格。|
|无候选、拒抽、只认领就机械回 1|HeartbeatCards 的十个不同 delivered 号码，冻结 run.mode；draw 1、普通 1、真实 exhausted 三类有隔离证据。|正常入口已退出提前兜底；短源失败不会创造新牌或维护成功事实。完成后可见 ack 仍是正本。|
|过滤维护 1 / 排除规范上下文|publishHeartbeatInTx 与轨迹/manifest 事务；T38、C08、R33。纯维护不推进 L，同时进下次输入和容量。|所测路径已退；不可删除规范协议、checkpoint 或 provider 已派发游标。|
|第二套完成工具与终态后补句|当前目录只登记 background_complete，支持 done/noop；同批晚动作返回同 ID 未执行，下一轮无旧锁。|未发现同义完成工具或已完成后额外请求。context_review_complete 属换窗评审，wishstar_finish_session 属星仪式，均有独立契约。|
|预留留言优先队列及朋友圈代写|新 choose 对合格来源桶等概率抽取，预留话无优先级。专页已走同一个 Content 命令。|未见优先队列；通用朋友圈编辑 reserved_note 依旧可写，F05。关闭此入口不删除来源修订、已投和未知事实。|
|用户代建自主唤醒与真正自设混在一起|wake_manage 自设保留；旧聊天管理“预约”和 owner HTTP 命令仍会生成 self_schedule。|未退出，F06。已有定时器、普通 reminder、一次自由活动有各自消费者，不一并删除。先盘点既有任务创建者。|
|词元/多次转义与旧正文名|四路均经实际校验和模型投影；复杂文本在星、记忆、聊天的实测写入逐字匹配。|未见这三个动作的二次解码。写星仍用 content，发帖/评论仍有 body；仅新窗升级自然语言外层合同，代码作品 content、身份、预算与幂等内部字段按业务保留。已冻结的 tools/system 不热改。|
|旧描述符、冻结发现与生成产物|切换快照中活动窗 deferred，有 memory_source_bind，未含本版 draw；新窗将旧绑定从可执行映射中移除。当前 6 个 legacyOnly 名见 CAPABILITIES。dist 与实际运行包 JS 哈希一致。|历史协议继续回放；六个别名未在该活动窗出现，单个窗不证明历史和恢复都不再依赖。以仍可用旧窗与恢复单的实际枚举为退出条件；不凭文件名退休 API 或 SDK。|
|第二套调度、重复 worker / 遗留配置|实际装配为 scheduler → 同一会话串行执行 → heartbeat/outcome；恢复消费者按 outbox key、版本和上限处理。family 没有来源登记、同步 worker 或定时器。|在本次触达路径未发现第二个模型调度器。旧首页静态 JS、旧创建和自约入口见上。全仓无关配置不作无人使用断言。每一测试执行组均退出。|
|旧图片创建记录与迁移命令|planner/apply、raster_creation_album_migrations、成员与历史创建 ID 仍用于回放和幂等。|继续保留原件、源修订、墓碑和旧 ID；迁后列表排除已迁 creation，旧引用仍可读。历史数据退出条件见 ALBUM_CLOSEOUT。|

## 隔离复验

在本仓根运行下列审计脚本。Node 22.23.3；本轮使用 macOS、当前锁定的本地依赖及已安装 Chrome，不需要下载包。模型和业务源一律使用合成数据。仓内脚本选文件、前台串行、每文件独立进程组；复验不指向生产库，不调用外部订阅与模型。浏览器从首页通过实际按钮进入页面，文件选择使用浏览器自动化的文件输入。

```sh
python3 docs/reports/JOINT_AUDIT_20261121/probes/run_batches.py turn content album revisions retirement
python3 docs/reports/JOINT_AUDIT_20261121/probes/probe.py normal extra unknown clock album
python3 docs/reports/JOINT_AUDIT_20261121/probes/browser.py
python3 docs/reports/JOINT_AUDIT_20261121/probes/gif.py
```

probe.py 输出本次临时结果目录。也可用 ESTOMAGO_AUDIT_OUTPUT 指向自选的审计输出目录。脚本只在测量无法完成时返回执行失败；产品是否符合裁定应对照 MATRIX、下列观测与 AUDIT 的修后验收条件。不要将脚本退出 0 解释为产品通过。

|复验组合|当前基线观察|修正后的判据|
|---|---|---|
|normal：S1 API direct、S2 SDK direct、S3 API deferred、S4 SDK deferred|每轮 4 个 provider 请求；卡、星写、记忆、发话或沉默、同批停止都成立。回复原星无可调用工具。两条无文字组只显示“本轮没有留言。”|修复后把当前被阻断的“按交付引用回复原星”加入真实目录→源回执链，再次验证每步的可操作引用、原修订和动作渲染。需要单独模型决定的场景按批准的累积预算验收。|
|extra：预算到界、无工具报价、用 text 写星|第 5 次请求在传输前被拒；无报价卡已交付而写入未开始；旧 schema 拒绝 text。|清楚呈现部分成功和预算原因；缺报价如实终结，不能松门；新窗 text 与实际源正文相同。|
|unknown、clock、短源、midnight|第 31 天未知星重新合格；关/开、无文字后继、临界新聊天与跨午夜均可区分；补源后仍是原 occurrence。|未知不自行释放；日账本、冻结窗口和有效维护回执维持既有正确行为。|
|album、browser、gif|相册删除后状态仍列 1 号；选中才失效。归类失败重试没双传；同键变用途 201/201；纯位图建作品 201。双帧 GIF 作为图片块进入 MCP/API/SDK 回放。|移除后立即撤可选号；同键异参 409，旧位图写入收口；现有集合/原件/回放均可读。|
|R33、T38、T44、内容编辑故障|真实子进程终止可恢复、预留话删除门区分派发前后、源写成功只补显示关联。|新动作映射沿同一恢复身份，重复回调既不重写源，也不覆盖墓碑和用户更新。|

审计组结果和合成样本摘要见 [EVIDENCE.json](EVIDENCE.json)。历史盘点的可重查方法为对主报告列明的**离线成对备份**运行仓内 planner，将 items 按 action 与 creation_id 分组，并交叉核对主资产权威 hash；无需复制消息正文。回退快照的可访问性不代表批准应用真实迁移。
