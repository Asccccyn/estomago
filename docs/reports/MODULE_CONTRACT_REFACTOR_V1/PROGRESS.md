# PROGRESS

| 卡/步骤 | 起始SHA | 实际完成的符号与文件 | 验证命令/退出码 | 提交 | 状态/下一步 |
|---|---|---|---|---|---|
| P00 | 849b1d5（来源树，未改） | worktree `refactor/module-contract-v1`@849b1d5；`docs/specs/MODULE_CONTRACT_REFACTOR_V1/`（包文档/合同/脚本）；`docs/reports/MODULE_CONTRACT_REFACTOR_V1/`（BASELINE/PROGRESS/RESUME/BLOCKERS/MIGRATION_MATRIX/TEST_INVENTORY/GLM_DELIVERY/REVIEW_FINDINGS/ACCEPTANCE_RESULTS） | preflight exit 0；`npm ci` 106包；`npm run typecheck` exit 0 | def6db5 | DONE；下一卡 P01 |
| P01.1 | def6db5 | capabilities/contracts.ts 新建（HostToolSpec/SeenRef/ToolExecContext/ToolExecResult/BackgroundToolQuote 原样搬迁）；host-tools/background-tool-cost 纯 type 重导出；supervisor/tool-discovery 消费者改指正本 | typecheck 0；tool-discovery+tool-initial-visible+model-wire-measurement 3/3 通过（ESTOMAGO_HOME 临时隔离） | 53f4092 | DONE |
| P01.2 | 53f4092 | capabilities/validation.ts（validateArgsAgainstSchema+PropSpec）；host-tools.validateToolArgs 缩为 allowlist 解析+委托 | typecheck 0；audit-d-fixes+wishstar-integration+wp7-cross-contract+tool-discovery 4/4 | 见git log | DONE |
| P01.3 | （同上） | tests/golden/tool-catalog-baseline.json（849b1d5 纯净采集，sha256=770e9fef…）；tool-catalog-golden.test.ts；host-tools 48 定义拆 10 域工厂+BASELINE_TOOL_ORDER 装配 | typecheck 0；golden 逐字节一致；tool-discovery+tool-initial-visible+model-wire+tool-discovery-supervisor 通过 | 见git log（golden 与重组各一笔） | DONE |
| P01.4 | 9f183f5 | tool-initial-visible 去反向 import（renderInitialVisibleText(db, specs)）；supervisor 传 buildHostTools()；测试同步 | typecheck 0；tool-initial-visible+tool-discovery-supervisor+golden 3/3 | 073f736 | DONE |
| P01.5 | 073f736 | tests/helpers/module-contract-session.ts（真实装配合成会话）；module-contract-session-snapshot.test.ts；tests/golden/module-contract-session-baseline.json（6 请求 wire+define/invoke 回执+surfacing 绑定+语音投影） | 连续两次运行逐字节一致；P01 全套回归 6/6 文件通过 | 见git log | DONE；下一卡 P02 |
| P02.1+2 | 26f2bc0 | capabilities/registry.ts（显式登记/重复名拒绝/baselineOrder 枚举）；capabilities/executor.ts（取消→memory_only 门→冻结schema校验→背景准入→handler→唯一投影）；contracts.ts 增 CapabilityOutcome | typecheck 0；capability-registry 2/2 | 见git log | DONE |
| P02.3-6 | （同上） | modules/oido/source-repository.ts（SQL 逐字）；modules/oido/service.ts（getEvidence 九步逐字）；modules/oido/module.ts（oido_get 条目，OIDO_GET_DEFINITION 唯一正本）；host-tools 路由+旧分支/方法删除；app-context 装配 | typecheck 0；tool-catalog-golden+8 项回归 8/8（定义搬迁逐字等价） | 见git log | DONE |
| P02.7 | （同上） | tests/unit/oido-get-registry-host-wiring.test.ts（A01 离线合同：真实回合 define/invoke 两链、新handler=1旧handler=0、同定义同结果、D39/D40/CANCELLED） | 12/12 定向回归通过；A01→PASS（ACCEPTANCE_RESULTS.json） | 见git log | P02 DONE；下一卡 P03 |
| P03.1a+2+3 | 04ae4af | modules/oido：analyzeVoice（九步组合用例逐字）+仓库扩展（receipt/intent/sha/transcript/bind/view-artifact）；oido_analyze 条目；旧分支/方法删除；夹具接 registry | typecheck 0；7/7（voice-hearing/reaudit/joint-voice/facade/oido-delete/wiring/golden） | f1cb897 | DONE |
| P03.1b-e | f1cb897 | service capabilities/view/find/compare；四条目+定义正本；旧分支/方法/授权助手删除；artifacts 窄端口 | typecheck 0；10/10（含 b1-view-native-image 原生图块物化） | cb08af2 | DONE |
| P03.4-8 | cb08af2 | modules/voice（transcript-service/call-service/module）；SirenAdapter.createCallFromInternalEnv；ProgramFactsPort；oido 生命周期（删除重试 timer）；isMemoryOnlyAllowed 统一判定 | typecheck 0；P03 全网 18/18 | 本卡提交 | DONE |
| P03 收尾 | （同上） | ACCEPTANCE A02/A04-A09/A11=PASS；MIGRATION_MATRIX 八行填毕；TEST_INVENTORY 增 P03 分类 | A02/A04-A09/A11 证据登记 | 见git log | P03 DONE；下一卡 P04 |
| P04.1 | 8070051 | conversation 域（3 工具）+通用域能力工厂 capabilities/domain-factory | typecheck 0；wp4-executor/wake-keepwarm/full-audit-tool-budget 等 6/6 | c8013ac | DONE |
| P04.2-4 | c8013ac | memory 域 14 工具+projection 正本+mood-vocab+hold-contract；resolveQuoteRefs/recoverUnknownEffects 窄委托；测试夹具实例反射装配（76 处自动接线） | typecheck 0；memory 网 20/20（session-snapshot golden 逐字） | 412f023 | DONE |
| P04.5-10 | 412f023 | wishstar(13)/content(4)/wake(2)/media(2)/identity(1)/context-review(1)；BootstrapPort；plans_write/deletion_review memoryOnly=false 校正；外层投影与全局桥退役 | typecheck 0；跨域净 15/15+11/11 | 3203d59 | DONE |
| P04 收尾 | 3203d59 | MIGRATION_MATRIX 48 行全填；A13/A14 证据（hold-quote/来源核证/recall/三层详情/episodes 离线合同）；PROGRESS/RESUME 更新 | 见 ACCEPTANCE_RESULTS | 见git log | P04 DONE；下一卡 P05 |
| P05 | P04 收尾 | messages/lifecycle.ts（通用事实+inTx/afterCommit+旧形适配）；context/contributions.ts（两类贡献叶合同，现行方法名沿 04 §F）；application/message-lifecycle.ts（浮现+活动锚点装配）；MessageService 六调用点发事实（firstAcceptance 语义）；supervisor surfacing 依赖叶类型化；app-context 绑定 bindMessageLifecycle | typecheck 0；surfacing-core/events/seam/openrouter+joint-audit-surfacing+frontend-lifecycle+session-snapshot+message-retry 10/10；A15/A16/A17=PASS | 见git log | P05 DONE；下一卡 P06 |
| P06 | P05 提交 | application/background-execution.ts（executeRun 逐字迁移+schedulerRef 惰性转发）；P06.3-7 已在前卡达成（registry 唯一路径/单次准入/同信号/窄端口）；P06.8 顺序核对 | typecheck 0；wake-keepwarm/exec-v1-wp4-*/full-audit-wake+wake-wire+tool-budget/keepwarm-sleep 8/8；A18-A22=PASS | 见git log | P06 DONE；下一卡 P07 |
| P07 | P06 提交 | 可验证范围：真实 Host HTTP 集成（records/snapshot/history/mock-turn 4/4）+启停/健康/ops 5/5；启停 owner 核对（oído 生命周期/surfacing/scheduler）；app-context 无 Siren 建呼/多步业务（P03 已抽 adapter）；BLOCKERS 登记 P07.1/2 逐域提取未做 | A23/A24=PASS；零前端改动 | 见git log | P07 部分完成（结构收尾登记 BLOCKERS）；下一卡 P08/P09 |

只记可复核事实。不记录私有推理、凭据、聊天正文、完整请求。
