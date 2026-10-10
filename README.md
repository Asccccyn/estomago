# estómago

> 自建聊天宿主：统一聊天入口 + 模型驱动宿主（OpenRouter 主用 / **DeepSeek 官方直连** / Claude Agent SDK 保留）+ Mariposa 唯一正式记忆。产品显示名 **estómago**；仓库/进程/配置键用 ASCII `estomago`。

三个模型驱动（身份映射互相隔离——session 命名空间与上下文指纹分域，切换强制换窗）：
- **OpenRouter**：规范 §6 主接入；凭据待她授权（A1 门）
- **DeepSeek 官方直连**：2026-10-05 她裁定新增（`runtime.provider: deepseek` + `config.deepseek` 段），独立驱动直连 api.deepseek.com，不经 OpenRouter、payload 零 OR/Anthropic 专属字段（无 cache_control/session_id/provider/plugins）；**当前唯一完成真实外网验证的通道**（DS 官方 key 冒烟 SMOKE_PASS）
- **Claude Agent SDK**：保留；她的 Claude 账号 1005 被封，实测凭据暂不可用（mock/合同层回归不受影响）

## 当前基线（唯一现行规范，2026-10-05 冻结）

**现行规范正文：`docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md`**（规范标识 `ESTOMAGO_OR_SELF_HOLD`：OpenRouter 主接入、原文全存+主模型自主 hold、换窗前一次提醒、一小时 Prompt Cache、前台"记录"面板）。实施状态与逐模块"复用/接线/新增/退役"判定见 `docs/specs/IMPLEMENTATION_MAP.md`；应用验收以 `docs/specs/ESTOMAGO_OR_SELF_HOLD/ACCEPTANCE.json` 逐项为准（未执行=`NOT_EXECUTED`，不拿测试总数冒充）。

版本口径（审计从这里进，不要并行引用多代文档）：

| 文档 | 地位 |
|---|---|
| `docs/specs/ESTOMAGO_OR_SELF_HOLD/` | **现行**：唯一规范正文 + 验收 + WP0 映射 |
| `docs/specs/MARIPOSA_LIFECYCLE_v1.0/` | **现行联合契约**：estómago×Mariposa 生命周期（source.ingest/memory.hold op/episode）；estómago 侧按 §4.1/§7 执行，Mariposa 侧由林石见在 mariposa 仓库实施 |
| `docs/architecture/v0.2.1/` | **历史存档**（v0.2.1 设计包，只读；其安全/隐私/测试硬约束经 AGENTS.md 继续有效） |
| `reports/` | 运行证据区（gitignore；测试日志、doctor、截图、备份清单） |
| `docs/v0.2.2-remediation-selftest.md` | 历史自检报告（已并入基线状态，不再单独维护） |

## 实施进度（对照 03_施工与交付 的工作包）

| 工作包 | 状态 |
|---|---|
| WP0 现场映射与冻结副作用 | **完成**（`docs/specs/IMPLEMENTATION_MAP.md`） |
| WP1 OR 专用驱动与配置 | **完成（离线）**：OR 配置段+硬规则、换窗预算初值、SSE/payload/用量驱动（fake transport 31 用例；全量 36 文件全绿）。真实外网仅 WP6 |
| WP2 原文同步 / MCP / 正式收据 | **estómago 侧完成（离线）**：outbox 消费者→`source.ingest` 幂等批量同步（崩溃同 op 重放/依赖缺失停流不跳过/冲突 dead/50 条与 1MiB 切批/编辑修订链）+ `memory.hold(operation_id)` 客户端与回执查询 + 迁移 v7。**Mariposa 侧接口已落地**（2026-10-05，ingest/hold/status 全链形状核对兼容）；**端到端联调待**：mariposa 内置服务绑定（她已裁定"内置感觉"，那边批次实施）+ archive.enabled 生产开启 + 凭据签发 |
| WP3 启动装配 / 轨迹 / 书签 / 一次提醒 / 自动换窗 | **完成（离线）**：策略移植（提醒范围/成功书签/评审完成/换窗调度）+ OR 工具循环（memory_hold→真实收据→书签；context_review_complete 宿主核验）+ 56k 预警/64k/6h 触发 + 换窗前一次提醒 + 跨窗继承。Mariposa bootstrap 分页 BLOCKED（等接口）；粗估 token 已标注精度 |
| WP4 缓存与工具续请求集成 | **完成（离线）**：每窗 append-only 协议轨迹（成功才推进）+ 断点规划 A/G（B 待 bootstrap）+ 跨轮 previousPayload 断言；真实命中观测=WP6 |
| WP5 前台"记录"与设置接线 | **完成（离线）**：records 两个只读端点（快照+白名单事件分页）+ 聊天顶栏"记录"面板（桌面侧栏/窄屏底部，零新依赖，打开不触发生成）；设置页 UI 待真实凭据联调批 |
| WP6 真实验收 / 发布候选 | **DS 通道已实测**：官方 key 直连冒烟 SMOKE_PASS（三步：基线聊天/工具往返/append-only 续传；自动缓存命中被正确观测；四道熔断，全程几厘钱）。OR 实测仍待预算授权；SDK 实测凭据不可用；estómago↔真 Mariposa 端到端待联调（见下） |

## 当前生产状态（2026-10-07 晨）

生产四链全通：**记(hold)→存(归档 epl-3, 14 条 acked)→忆(bootstrap B 点)→查(recall+judge typesafe_jev FOUND+正文交付)**+episode 事件跟踪（生产探针通过）。LaunchAgent 常驻（凭据经 ~/Data/estomago-secrets/start.sh wrapper 注入 env，不落 plist）。聊天模型待她配置（IDENTITY_BLOCKED 如实降级：消息仍保存、时间线仍可看、归档照常）。

## 2026-10-05 深夜批次（在上述 WP 状态之后；按时间序，多路并行）

- **e3babaa**：DS 官方直连驱动 + 身份映射隔离 + 第三方审计 P1/P2 修复（块级 cache_control 族判断、评审失败重试上限 3 次/窗、评审停止键）。
- **9b08046**：memory_hold 契约对齐（标题必填≤30 字/九分类数组/补记日期），**引用=模型指认**——模型给 quotes 片段，网关在已见原话里逐字核对（失配整单拒·零副作用），说话人自动映射（owner=qiaosheng/assistant=jiaming），按 mariposa source_selections 钉住（收据+内容 hash+句内 offset）。
- **ba41c18**（并行批）：mood 参数接入她冻结的七大类词表终版（mood_tags 枚举≤3 + mood_note 自由文字）。
- **0422aeb**：送审前自审修复——quotes 的 char offset 按码点计（mariposa 契约），emoji 前置不再错位。
- **909bd99 + 4a61003**：Codex 审计 3655d60 全量 28 项修复（9 P1/18 P2/1 P3；含 DS thinking 续传、重启恢复、按实际已见清单核对引用、归档 published_kind 映射、5xx→unknown、前驱闭锁等）；51/51 绿。审计简报与逐项对照见 `reports/audit-brief-20261005-ds-hold.md` 与 IMPLEMENTATION_MAP。
- **c084103/ef1ecf9/9765086/c04a963/6c98a71/9306550/68067b5**（联合审计返修 B2–B5）：B2 工具 epoch 冻结+无轨迹评审范围=实际装载+追赶进范围+skipped_empty 依据（v14）+retrospective 预拒+typecheck 基线清零（36→0，tsconfig+锁依赖）；B4 跨仓契约防漂移测试（读 mariposa 实码、突变必红）+outbox 受控恢复脚本（dry-run 默认）+批次字节口径对齐（跨语言黄金夹具）+错误码清单副本移除；B5 停止键/编辑修订入口/加载更早（服务端 before= 翻页）/坏JSON 400·超限 413/SSE 活锁与字节背压/ready 脱敏/换窗原因如实/面板绑定事实化。全量 56/56 文件+typecheck 0 错误。
- **e8948f6**（episode 工具面）：episode_list/episode_get 模型按需查询（她批 2026-10-07"做吧"）；契约测试 13 能力+路径改 owner。
- **ce67926**（尾批 F-J-34/52/51）：用量 purpose 分列+面板 esc 加固+时钟边界 3 条。
- **c30a531**（终批六项）：D3 凭空建房 404/F-J-45 URL token 退役/D5 sticker_voice 归档/D7 envelope 死链 v15/F-J-32 gDropped 事件/F-J-33/37/56。
- **5405ed2**（D2+G-J-01）：开窗资料 B 点注入+memory_recall 按需召回工具（她批"能收口的都收了"）。
- **c8f2bae**（联合审计返修 B1）：跨仓 P1 三项——quotes 引用身份改 source_msg: 前缀（F-J-01，修复带引用 hold 必被拒的跨仓断裂）/书签高于清单改合法空范围防换窗死锁（F-J-02）/回执绑定 1:1 校验（F-J-54）；真实双端探针 R01/R02 通过（审计包 probes/b1）。
- **36fd6df**（mariposa-1005B 并行批）：接口根因适配——classifyError 按 httpStatus 优先分类（修 mariposa 结构化 429=RATE_LIMITED 被判永久 dead 的真根因）、mood 需配 creation_mode 的前置拦截、心情词表改 `memory.mood.vocab` 动态拉取（正本唯一，不再硬编码）；52/52 绿。
- **WP0（2026-10-08，glm/manual-handoff-20261008 分支）**：现行正本修订 `MANUAL_HANDOFF_JUDGE_SWITCH_V1` 落档——新窗装配改人工选集（§5/§5.5，12k 自动携带与容量预警展示退役）、DS 日结整链退役条款（§5.6）、判断总开关纯消费合同（§8.4）、原文回读 conversation_read（§8.5）；本批只改文档，代码施工 WP1-WP7 逐批推进。
- **WP2（2026-10-08）**：`memory_recall_next` 宿主工具——只消费 Mariposa 冻结结果集（memory.recall.page；零检索/零判断/零 COUNT），`memory_recall` 去 slice(0,20) 并透传页合同字段（judge_mode/pagination/retrieval_coverage）；RECALL_POLICY_CHANGED 如实上抛；refine 与分页游标分槽。65/65+tsc 0。
- **WP3（2026-10-08）**：人工历史选集换窗——`context_selections`（迁移17）四态选集（awaiting≠空选），全部换窗入口统一选集门（手动/容量/静默/身份失效/SDK/无活动窗），rotate 切换事务原子消费，新窗轨迹严格按选集装配（不再自动 12k），preview/confirm 端点+确认后原输入恢复一次，网页勾选栏；H 系列 7 新测试+全套件 66/66+tsc 0。
- **WP4（2026-10-08）**：`conversation_read` 只读原文回读——锚点前后/序号范围/游标三模式，片段级已见（码点范围）经"实际进入下一请求"才转正并入 manifest，resolveQuotes 范围门（已读可引用/未读不放行），sync_state 如实、思考/草稿零命中、零副作用；O01-O08 共 9 新测试，全套件 67/67+tsc 0。
- **WP5（2026-10-08）**：DS 日结与自动 12k 携带**整链退役**——digest 服务/注入/配置段删除（迁移 18 DROP daily_digests，旧键 retiredKeys 披露），新窗历史唯一来源=人工选集，旧窗评审重建保持证据单源，容量预警事件退役；D01-D05 退役测试+全套件 67/67+tsc 0。
- **WP7（2026-10-08）**：I01/I03 双端合同穿透——M 真实 registry 三模式包经 E 真 client/工具层字段保真（68/68+tsc 0）。I02 真浏览器操作与 live 项（Codex 实机/生产重启）单列待执行。
- **2026-10-08 晚间（她裁定）**：6h 静默换窗触发删除（换窗唯一自动基线=64k 软线；醒来继续原窗）；无轨迹窗 12k 评审回退删除（如实阻断 ROTATION_RANGE_UNKNOWN，不猜范围）——7 个测试改容量触发/阻断断言，68/68+tsc 0。
- **2026-10-08 晚间二批（她裁定）**：聊天窗内置换模型/思考深度——`runtime_settings`（迁移 19）持久 override，GET/PUT /api/v1/runtime-settings；换模型=运行边界变化走受控换窗（指纹按生效视图，WindowManager 经 provider 存新窗指纹），思考深度（OR reasoning.effort 七档）=逐请求参数立即生效**不换窗**（reasoning 退出 contextFingerprint）；聊天窗顶部常驻设置栏（模型输入+档位下拉；UI 美化她统一后改）；4 新测试。
- **2026-10-08 晚间三批（她 catch 修复）**：思考档位按模型真实支持生成（OR 公开元数据 supported_efforts/mandatory 驱动下拉+PUT 校验；fable-5.1/opus-5.5 实测五档无 none/minimal；无旋钮模型只剩 default；元数据不可达=未验证如实标注）——`c5c3ad1` 已部署生产。
- **WP-03（2026-10-09，联合审计返修 run-160858）**：测试债清偿+配置退役披露——三死键全链退役（6h/零点/bootstrap_target：类型/默认/SHAPE/校验删净，RETIRED 六键+启动 `retired_config_keys` 日志）；records.ts `effectiveWarning` 残尾切除（tsc 0）；选集无活动窗死锁修复（GET awaiting 端点、preview 认哨兵源、前端锚回落+幂等键会话复用+confirm 刷新重取，B12）；or-config/audit-d-fixes 两红测试改退役断言；全套件 69/69+tsc 0。
- **WP-04（2026-10-09，联合审计返修 run-160858）**：消费层正确性+运维有界性——memory_recall_next 补透传 judge_policy_revision/judged_count+off 首页 pagination 形状门；conversation_read 真 UTF-8 字节预算+游标按最后已推送收缩（跳过行续页可达）；PUT runtime-settings 两字段原子写+or_model 形状门；SDK 无活动窗同锚 awaiting；sticker/voice 纳入回读面；mariposa base_url loopback 纪律；hold unknown 同窗防盲重发；SOURCE_SELECTION_TOO_LARGE 减半重切；元数据 URL 双拼修复+minimal 档位如实+长 I bootstrap.next 续取；/health/ready 503 语义；prune 轮转（payload/事件，脚本+审计留痕）；备份 meta/config+token(600)+轮转 keep=10；launchd wrapper 模板（秘密零落 plist）；8 新测试全套件 71/71+tsc 0。
- **WP-09（2026-10-09，联合审计返修 run-160858）**：restore 两侧同 canonical 空间（prodRoot/目标侧均过 realpath——HOME 别名与尾分量 symlink 不再把库写进"生产根别名"，四例 probe 全绿）；备份 meta/（config+token）随恢复进隔离根（token 600）；2 新测试全套件 72/72+tsc 0。
- **WP-05（2026-10-09，联合审计返修 run-165858）**：结构清理——rotate FENCE 切换事务内复检（E06，封 prepare 期 TOCTOU）；example.yaml 对齐 schema（死键清零+补 reminders/model_options/probe_evidence）；loadContents 缺修订差异披露（B13）；exactModel 经 runtime settings 生效值（B14）；迁移数组 16-19 升序+upTo(17) 回归（B15）；previousEnvelope 剔除 reasoning（B16，effort 逐请求）；元数据负结果 60s 短 TTL（B17）；usageByPurpose 房间过滤（B18）；policy.ts 占位追踪头（D17）；OR 网络错误按 cause code 分类（D19）；wp7 fixture 再生成脚本入库（C04）；全套件 72/72+tsc 0。
- **WP-06（2026-10-09，五项她已裁）**：D-6 estomago 开窗桶渲染消费——近三日桶渲染含时间/心情标签+心情文字/事件正文/我们的话/关系注释行（明细走 relations.list；spec §5.3 字段权限条款同步——撤销 D2 的 mood_text 排除口径）；全套件 72/72+tsc 0。
- **收尾批（2026-10-09，run-160858 补遗）**：B11 恒真 CAS 分支删除（windows.revision 从不递增，确认防护由恢复路径承担）；safeErrorFields 零引用删除（D17 后半）；**双仓时区键固化**（C11）：E `business_timezone` 与 M `RELATIONSHIP_TIMEZONE` 同值 Asia/Shanghai——改任一侧必须同步另一侧。**生产已重启载新码**（bind 0.0.0.0 局域网可用，手机经 `ownerdemac-mini.local:18787` 访问）；上线基线备份 1 份（含 meta/config+token）。72/72+tsc 0。
- **I/计划只读批（2026-10-10，她排期"继续"+林石见复核序）：E 工具面 8→10**——新增 `memory_i_read`（读"我"：what=current/items/item/item_history/doc_history 五路，M 的 i.get/i.items.list/i.item.get/i.item.history/i.versions.read 透传；缺 item_id 明确拒；NOT_FOUND 如实上抛）与 `plans_read`（列表可筛 states 透传 / 单计划明细走 plan.get 薄实现入口）。写操作（I 新增修订恢复、计划创建修改完成放弃）属下一批；i.suggest 是她的入口不进模型面。六测（wp3-i-plans-read.test.ts）；76/76+tsc 0。
- **找话第二批：Round2 原文深搜接通（2026-10-10 晚，"先找话、不足再查原文"闭环）**：`memory_recall` 新增 `deep_search`+`deep_reason`（闭集枚举）——走 M 的 `memory.recall.round2` **独立入口**（不经 channels:['raw'] 绕）；宿主派生 `es-r2-*` 幂等 operation_id；S13 门拒绝（ROUND2_GATE_DENIED）如实上抛带指引；深搜结果 channel='raw' 回显+专用 note；round2_raw 提示从"暂未接入"改为指向真实参数。装包提取 `assembleRecallPacket` 共享（start/refine/round2 三路同门）。深搜四测+第一批⑤按新合同更新，10/10；75/75+tsc 0。
- **找话第一批（2026-10-10，她排期+林石见复核口径）：`memory_recall` 新增 `channel`（event|words）**——我们的话首轮/续查/翻页接通：首轮省略=event 旧行为不变；**续查必须显式携带 channel**（M 对省略缺省 ['event']，静默缺省会把找话续查变查事件——E 明确拒绝+提示，client 类型层强制）；结果回显目标、找话专用 note；M 的 round2_raw（原话证据不足→深搜）不再压扁成"改问题续查"；words 禁用=如实"通道关闭非查询无结果"。验收六测全落（wp2-words-channel.test.ts）+旧 R02 夹具按新合同更新。75/75+tsc 0。
- **三次回访 A+B 批（2026-10-10，Codex 三次回访 run-230814：23 PASS/2 FAIL 后她裁"先改计量再做 JSON 瘦身"）**：E 侧配套——`windowBootstrap` 的 our_words 消费改**展平双形状容错**（M 新分组形状 `[{speaker,texts[]}]` 展平后渲染，文本与旧逐条形状逐字一致；旧形状也接受，回滚/混布安全）；分节消费 guard 32→64（event/words）。M 侧（mariposa 仓）：word 计量改完整条目对象字节（A 批，700 条单字首包 26064B→预算内）+ 分组形状瘦身（B 批，2800 条 27 页→3 页）。73/73+tsc 0。
- **死表清退批（2026-10-10，程知行执行：复审开放项她批"删吧"）**：迁移 v20 DROP 零读零写死表 wakeups/effects+1 写 0 读的 members（写入点 ensureConversation 同步移除，建房只落 conversations）；**audit_events 勘误保留**——WP-04 prune 维护审计已在写，破坏性维护的审计账本非死表（审计期"4 死表"口径过时）。fresh=v19 升级同码收敛；3 新测试（fresh 终态/升级路径/建房幂等）。tsc 0。
- **二次回访根因修复批（2026-10-10，Codex 二次回访 run-073728：19 PASS/6 FAIL 后她点名"不要补丁叠补丁"）**：按口径根因修，不再对反例打补丁——RRA-014：`conversation_read` 尺寸判定统一**真实 JSON 字节单口径**三段式（整装≤本页剩余/≤空页预算顺延整条/超整页折半分片；废除残留 `cpLen≤3000` 码点门——3001/4000 ASCII、4000 中文"能放空页"曾既不整装也不分片，range 静默结束+older 同游标空页活锁）；显式空游标=诚实空续页（翻尽即终止后链式探测不 4xx）；FU-001：PUT 按**合并后真实生效 (model,effort) 对**校验（`or_model:null`/`reasoning_effort:null` 清除回落配置默认的组合入检）。自查去补丁层：未完分片判定 4 处实现与 `{fragment,resume}` 组装 4 处重复各收敛为 `isOpenFragment`/`openFragmentCursor` 唯一实现（9abec0d→d25a15e）。断言补强：older 精确拼回改实际文本+区间相接、wp7 失败景必须断言披露、bc 按新契约。审计员 probes 复跑：e-followup2 7/7、e-followup 8/8、e-settings-null 2/2、e-settings-http 3/3、e-bootstrap2 4/4。73/73 文件+tsc 0。生产已重启载 d25a15e。
- **RRA 回访返修批（2026-10-09 深夜，Codex 回访 run-035424：15 PASS/10 FAIL 的 10 项残项+2 项新 P2）**：RRA-006 E 侧——`windowBootstrap` 真实消费 `event_text_next`/`our_words_next` 分节续取（有界循环；失败/未尽如实披露游标+已载长度，不再静默把首节当全文）+`memory_days` 多桶续取披露；RRA-014——`conversation_read` 交付协议重写：older 方向按取序（降序）交付保方向与原上界（不再翻向无界 newer_than）、range 续页携带 `up_to`（3..7 恰好到 7）、锚点**预留优先**（不再被前邻长文永久挤掉）、分片预算=转义后真实 JSON 字节（\u0001×4000 整页 18479B→≤16000，宽度折半）、页内至多一个未完分片（fragment+resume 链，先出现者尾段不再搁死）；FU-001——runtime-settings PUT 按**候选配置**校验（候选 model 元数据校验候选 effort，含 model-only 继承）；FU-002——`setMany` 单事务两字段（trigger 拒第二写→500 且 model 不变，真实 SQLite 事务实测）；T4/T5b/d/j2 断言升级为真实行为（elapsed 上界、HTTP/事务级）。73/73 文件+tsc 0。
- **RRA 返修批（2026-10-09 晚，Codex 复审 run-000112）**：P1×3——回读交付前沿统一（RRA-014：range/older 翻尽零丢失零重复——older 页内预算跳过行先续装再向更早；回归 range10 翻尽=10）；无活动窗恢复分支迁移 pending bootstrap 缓存（RRA-015：连续模型恢复不再复用旧 B）；reasoning 退出 append-only 稳定前缀比较键（RRA-017：合法 effort 换档不再零派发）。P2×5——restore config.yaml→estomago.yaml 应用名映射（019）；安装器 __HOME__ 替换+占位残留校验（020）；doctor 新增诊断移入报告（021）；prune dry-run 同一筛选谓词（022）；restore 最近存在祖先 canonical 化（023，不存在末段也防别名绕过）。RRA-016 验收拆分：bootstrap 503=无 B 降级不阻塞（D2 语义明示测试）；WP04-d/j2 改真实形状判定断言；72/72+tsc 0。
- **WP-07（2026-10-09，联合审计返修 run-160858）**：选集/换窗状态机家族——追赶投影窗口归属（`catchupEntries` 按 `pr.window_id` 过滤，明确空选换窗后新窗 payload/轨迹不再含未选旧原文）；初始轨迹写入 rotate/createWindow **切换事务内**（选集消费+窗口指针+轨迹三位一体，prepare 失败整体回滚不动旧窗）；无轨迹 fallback 携带选集装配（全量 dialogue 路径根除）；切模型并入选集状态机（指纹失活落 `csel-src-model-change` awaiting+confirm 扩 CONTEXT_ROTATION_REQUIRED 匹配+runtime 面板 awaiting 引用）；confirmed 再确认同键幂等/异键 `CONTEXT_SELECTION_ALREADY_CONFIRMED`（不 null 不 500）；6 新测试全套件 70/70+tsc 0。

> **基线口径**：代码基线=本仓库 HEAD（每批提交即推进，测试数以最新批为准）；`docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md` 为冻结规范正文。任何审计包/交接包/邮件附件里的 source 副本都是**当时的历史快照**（含审计输入包 `~/Documents/Codex/…/estomago-audit-*/source/`），不作为基线引用。

## 快速开始

```bash
npm run doctor      # 只读环境检查 → reports/mac-doctor-*.json
npm test            # 前台、串行、独立临时 ESTOMAGO_HOME（AGENTS.md 测试纪律）
npm start           # 前台启动（127.0.0.1:18787；首次自动复制 example 配置）
# 打开 http://127.0.0.1:18787 ；首次登录粘贴 $STATE_ROOT/config/auth.token 内容
npm stop / npm run status
npm run backup      # SQLite VACUUM INTO 一致性快照 → $STATE/backups/
npm run install-launchagent   # 渲染 LaunchAgent（默认 dry-run，--apply 才写盘）
node scripts/ds-smoke.mjs --dry-run   # DS 直连冒烟自检（零网络）
# 真实冒烟（需她授权）：export DEEPSEEK_API_KEY=<官方平台key> && ESTOMAGO_DS_SMOKE=1 node scripts/ds-smoke.mjs
```

零 npm 运行依赖（Node ≥ 22.18，原生 `.ts` type-stripping + `node:sqlite`）；开发依赖仅 `@anthropic-ai/claude-agent-sdk@0.3.283`（锁定安装，OR 模式不加载）。无凭据/无身份材料时按规格如实 `IDENTITY_BLOCKED`/blocked 降级，消息保存、时间线、SSE、思考通道照常——这是规格要求的形态，不是故障。

## 关键硬规则的代码落点（现行规范 → 现场）

| 规范条款 | 代码落点 |
|---|---|
| 原文全存/幂等提交/修订链/outbox（01 §1.2、§2.2） | `messages/service.ts`（生产者）、`db/migrations.ts`（outbox 表；消费者 WP2） |
| OR 驱动 / 请求控制 / SSE / 重试 / 费用（01 §6、§9） | `runtime/runner-openrouter.ts` + `runtime/or-*.ts`（WP1） |
| DS 官方直连驱动（payload 零 OR/Anthropic 字段；自动缓存=usage 观测，无参数） | `runtime/runner-deepseek.ts` + `config.deepseek` 段（含中文粗估系数 1.5） |
| hold 新契约（标题/九分类/补记日期）+ 模型指认引用（quotes 逐字核对/说话人自动/收据钉住） | `runtime/host-tools.ts`（HOST_TOOLS + resolveQuotes；契约正本=mariposa input_schemas） |
| 三探针 P1/P2/P3（01 §11.1） | `runtime/supervisor.ts`（P1）、OR 驱动序列化后 fetch 前（P2）、usage/终态帧回填（P3） |
| 换窗状态机 + 原子指针 + 降级保旧窗（01 §4.3） | `windows/manager.ts`（review 接线于 WP3） |
| 一小时缓存布局 A/B/auto/G（01 §7） | `runtime/or-payload.ts`（边界构造；规划接线 WP4） |
| 思考隔离：ReasoningProjection 不可进上下文（01 §10） | `context/assembler.ts`（allowlist builder）、`reasoning/*` |
| 用量口径分列、未知不填零（01 §9.3） | `usage/collector.ts` |
| 停止：先 fence 再 abort、迟到 chunk 丢弃（01 §9.2） | `runtime/supervisor.ts` |
| 输入框：Enter 只换行、独立发送键、IME guard（AGENTS.md 硬规则） | `apps/web/src/composer-logic.js` + 服务端只做 `\n` 规范化 |
| SSE 持久 sequence 回放、慢客户端有界队列 | `events/service.ts`、`server/http.ts` |

## 硬边界（AGENTS.md 摘要）

不碰兄弟项目（mariposa/siren/superposition/Zashidele）；不编造验收；秘密不进日志/Git；测试用隔离临时根、前台分批串行；网络/凭据/跨仓库变更需她逐项批准。完整规章见 `AGENTS.md` 与现行规范正文。
