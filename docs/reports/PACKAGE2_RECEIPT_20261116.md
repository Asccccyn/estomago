# 包2 状态/退役/部署差异回执｜2026-11-16（批E，按 06_STATUS_AND_RETIREMENT）

一句话：包2（runtime debug + 午夜来源绑定）批A/B/C、DBG-04、批D 交叉联验全部完成并提交；
一切仅在开发仓，生产未动；代码就绪待授权的三件生产动作与 BIND 启用条件列于 §5。逐需求详
行见 README 批次索引（2026-11-16 各行）与 `HANDOFF_PACKAGE2_20261116.md`，本文不重写。

## 1. 版本事实（本回执时点）

| 项 | 现值 |
|---|---|
| E 开发仓 | `unified-main-20261102`，批A `a9bf192` → 批B `58e204e` → 批C `fd07b3f` → DBG-04 `2be186d`（+文档维护 `613cd75`）→ 批D/批E 本日提交 |
| M 开发仓 | `main`：`dfe12c4`/`f334fab`/`6f3d1c0`（排除合同+撤销粒度+白名单补 plan.complete/cancel） |
| 生产（2026-11-16 他路部署，她授权切已部署批次、包2 不上） | E host+content `pkg1-final-87e793b`（RR4 全链+包1 媒体增量+停止/缓存锚+一轮/二轮返修+反例3——**不含包2 任何提交**）；M `album-rr-f334fab`（`6f3d1c0` 白名单脚本未上） |
| schema | 开发 v74（v71 work 附件/v72 生图指纹/v73 结果 URL/v74 source_bind_jobs）；生产 v73——包2 未部署故 v74 未升；升级走正式迁移，无手工步骤 |
| 测试基线 | 241 文件全绿（unit+contract+integration；隔离 ESTOMAGO_HOME） |
| 远端 | 脱敏线裁定（2026-11-15）：不对账、不合并 |

## 2. 需求实施状态（逐编号；详据在 README 批次行）

| 编号 | 结果 | 提交/落点 |
|---|---|---|
| DBG-01 供应商错误具体原因 | 完成 | 批A：OR/DS 读响应体 error.message；supervisor 失败事件带脱敏 detail+evidence；前端展示 |
| DBG-02 计划完成/取消授权 | 完成 | 批A：M 白名单生成源补 plan.complete/cancel（`6f3d1c0`）；**生产热更新待授权（§5.1）** |
| DBG-03 记忆正文修订入口 | 完成 | 批A：memory_update（expected_version CAS；冲突给重读指引；未知不盲重试） |
| DBG-04 存档直接范围写入 | 完成 | `2be186d`：双边界锚点（说话人+短逐字原话）在 seenMessages 视野内解析为 (message_id,revision)；节选/缺口/消歧/版本冲突如实；短回执；D14-D19 验证 |
| DBG-05 旧 I 占位退役 | 完成 | 批B：A 段不注入 I；manifest 空槽/占位文件名 gate 跳过；撤缺 I 阻断 |
| DBG-06 运行规则单一正本 | 完成 | 批B：FIXED_RUNTIME_FRAGMENT 代码常量退役；唯一正本=manifest 文件版 |
| DBG-07 SDK 引导语归位 | 完成 | 批B：guide 标记；SDK 并回后继历史消息头部；批D BD-1/BD-2 双投影核对 |
| DBG-08 里程碑显式写+称谓 | 完成 | 批B：operation 必填；默认称谓 宿主用户/char；相册留言经身份配置注入 |
| DBG-09 开窗对象引用 | 完成 | 批B：记忆〔id memory_id〕/计划〔plan_id vN〕/I 条目入口 |
| DBG-10 计划对账 | 完成 | 批B：bootstrap.next('plans') 有界续取+total 对账，不再"还有更多…2/2" |
| DBG-11 检索降级语义 | 已满足于既有实现（非本包施工） | 证据：回执 `judge_mode` 必需且服务端下发（模型参数无判层开关，不能自改/自关）、`judgement_status`/`judged_count`/`retrieval_coverage` 与 `candidates` 分开透传、`WORDS_CHANNEL_DISABLED` 先例明确"通道关闭≠无结果"。未新增 D12 隔离测试（无新施工）；如需按 D12 补一条判别测试可在后续窗口加 |
| DBG-12 Unicode | 零实现需求 | 全仓确认零 `\u` 转义处理代码；取证路线保留（无复现不编修复） |
| BIND-01..08 午夜来源绑定 | 完成 | 批C：维护 tick+source_bind_jobs+GlmChatAdapter+M source.binding.bind；**默认 disabled** |
| BIND-09 真实评估 | NOT_EXECUTED | 待授权（需她配专用凭据并启用） |

## 3. 验证分层（COMMON §7.3）

- **静态合同**：golden 三件（tool-catalog/envelope/module-contract-session）重建后字节一致复跑；frozen 计数 56/54/47；frozen examples 的 conversation_archive 换锚点形态经真实冻结包 tool_invoke。
- **隔离业务验证**：batch-a-debug（DBG-01/03 四路径）、F02/or-supervisor/milestone/carry 旧断言按新合同改写（批B）、source-binding 五组（批C）、archives ARC-20..26（DBG-04 D14-D19 + 批D 编辑冲突×三定位）、batch-d-cross 三组（SDK 真实转换链投影/API 信封投影/聊天×BIND 并发）。
- **真实服务调用**：archives 系测试用真实 ContentServer+真实 E 库+协调器；M 侧为桩（transport 边界）。
- **最终模型出站/真实 SDK**：scripted SDK query 驱动真实 ClaudeSdkRunner→runSdkHostQuery 转换链（BD-1）；**真实付费模型/订阅调用 NOT_EXECUTED**（COMMON §5：不因文档存在自动获准）。
- **生产生效**：NOT_EXECUTED——未部署（§5.3）。

## 4. 退役清单（06 §"退役清单的范围"）

**已删/已退役（本包提交内，替代通路已验证）**：
- `FIXED_RUNTIME_FRAGMENT` 代码常量（→manifest 文件版唯一正本；grep 零残留）。
- A 段 I 复制注入与 OR/DS 信封缺 I 的 `IDENTITY_NOT_READY` 阻断（→唯一注入点 B 段；F02 旧政策测试按新合同改写）。
- SDK 引导语抬升进 systemPrompt 的旧行为（→guide 标记并回后继历史消息；BD-1/BD-2 双投影验证）。
- `identity_milestone_write` 缺省整版替换（→operation 必填显式）。
- 计划开窗"还有更多…已载 2/2"自相矛盾文案路径（→有界续取+对账）。
- modelFailure 失败投影对锚点消歧字段（boundary/candidates/conflicts）的剥除——非删除而是按 invalid_ids/fix 先例放行（`2be186d`）。

**因真实消费者保留**：
- `conversation_archive` 的 message_ids/latest_completed_turn 两种定位（模型 schema 与说明由包4 收口去 seq；本包不抢先删）。
- `source_bind` 相关模型面与 seq/朗读说明（包4 收口，06 明示不在包2 抢删）。
- 反例1/2 已修实现保留为兼容路径（2026-11-15 验收裁定退出必修）。

**待办退役（唯一剩余）**：旧 I 占位文件 `identity/i-snapshot-pending.md` 的**生产**清理——
gate 已不依赖（批B），开发仓无该文件动作；按 06 与交接约定在部署窗口一并处理，不单独触碰生产目录。

**不删（06 保护项）**：M 来源领域能力、网关原文、真实 ID/hash/版本、人工来源管理、I 历史、
审计历史、共享索引维护、主模型冻结轨迹、BGE（包3 裁决）。

## 5. 部署差异与待授权动作

未部署队列（README 首段为准）：RR4 五批 → 包1 `4cfedab` → `189c84d` → 一轮 `3da1147` → 二轮
`041342f`/`04d1964` → 反例3 `87e793b` → 包2 批A/B/C + DBG-04 + 批D/批E + M 三个配套提交。

三件生产动作（代码就绪，**等她逐次明确授权**，她可能在聊天）：
1. **白名单热更新**：跑 M 仓 `scripts/update_estomago_builtin_allowlist.py`（写生产 M 库
   client_bindings；脚本自带备份）——plan.complete/cancel 生效条件。
2. **身份句写入正本**：`identity_milestone_write(operation:'write')` 整版或逐条 add——
   "你是char。宿主用户是你的妻子，你是宿主用户的丈夫。"（03_SYSTEM §2 原文；不整篇覆盖）。
3. **部署**：`bash deploy/macos/make-release.sh HEAD <label>` 从 HEAD 建新检出+start.sh 切换+
   content 同批——**重启必须按次征得她同意**（AGENTS 生产裁定）。

BIND 启用条件（独立于部署）：她配 `source_binding.api_key_env` 凭据 + `enabled: true`；
BIND-09 真实评估另行授权。

## 6. 包间交付状态（06 §"包间交付"）

- **给包3**：coverage 事实=E 既有投影/交付记录（同窗跨日不清；内部存档读取/午夜绑定不计已读
  ——BD-3 已验证任务不触碰窗口状态）；来源绑定独立于 raw 检索；版本机制沿用。包2 未建 coverage 存储（按裁定）。
- **给包4**：真实 memory.update 入口/合同（批A）；计划各 action 权限（批A+M `6f3d1c0`）；
  当前可见范围同次解析+写入及短回执（`2be186d`）；开窗对象引用（批B）；统一 system 编辑目标
  （批B）；姓名配置来源（批B）。模型 schema 去 seq 由包4 执行。
- **给包1**：仅引用共同资产/错误合同，未重写媒体状态机。
