# estómago 模块接口独立复审裁决

审计日期：2026-10-25。实际 HEAD：`15fb87bffbbb1293537be50598d3c0d7b9289357`；分支 `refactor/module-contract-v1`；开始与结束均为干净工作树。代码冻结点 `6587029` 到 HEAD 的 apps/scripts/tests/packages 差异为空。本报告不把实施者的数字或 PASS 当证据。

用户在本轮明确选择保留已分类的定向测试，因此没有执行 188 文件全量。没有修改被审工作树，没有访问真实模型/外部服务，没有读取生产数据或凭据。一次性复现只写入 git archive 创建的 /tmp 副本；本报告和证据存放在独立审计目录。

| 问题 | 裁决 | 独立证据与限度 |
|---|---|---|
| Q1 唯一执行与四处资格 | FAIL | 48 项均实际进入 Registry/Executor，未发现旧 handler 回退；但真实通话中 tool_define 返回禁用业务定义，未落实四处同政策。复现退出 1。 |
| Q2 可信 ctx 身份 | PASS | supervisor.ts:840 从 t.tool_id 注入；参数注入/转发/回填/校验特例已删除；memory/oído 操作键前缀、顺序、截断和 null 分支与基线一致。hold-quote 11 个用例通过。实际剩余死兼容只作 C 记录。 |
| Q3 冻结与缓存 | PASS | 两个 golden 自创建后内容未变；工具目录/定义 ID/会话 wire 测试通过；新窗调用 currentCatalog，旧窗仍优先持久快照，执行校验使用冻结 schema。见下方范围限制。 |
| Q4 电话准备取消 | PASS | 同一原始复现在 4dfa709 失败，在当前源码通过。独立补查释放所有迟到响应，数据库 receipt 保留，后续分析/模型不再启动，未创建消息或 turn。 |
| Q5 消息生命周期 | PASS | 旧形状适配已删，构造只接受通用 hooks；事务/outbox/afterCommit 次序保留；三个 surfacing-seam 用例实际通过，验证同轮、跨轮不重加和最终准入。 |
| Q6 路由迁移 | FAIL | 13 模块完整静态比对后，域内语句搬迁成立；总入口新增 memories 正则比 handler 宽，造成请求无响应。相同请求旧版 404，当前超时；复现退出 1。 |
| Q7 扩展局部化 | PASS | probe 通过正常旧窗/新窗、真实 Supervisor define→invoke 进入后续模型请求；memory 消费者只调公共读取方法。两个演练用例通过。未覆盖的 catalog 发现步骤不冒充已跑。 |
| Q8 真实层证据 | UNVERIFIABLE | 已核脚本/JSON内部对应，未重新访问真实服务。DS smoke 的 Mariposa 是 fake，真实集成脚本直调 adapter，不等于 Host/Registry 全链；总 PASS 判据有缺口。 |
| Q9 无生产污染 | UNVERIFIABLE | 当前 Git 及审计期间未修改工作树可确认，63 个提交与受检查配置/运维文件差异已核；Git 不能证明过去仓外命令没有改生产。未读取生产状态来补签。 |
| Q10 报告对账 | UNVERIFIABLE | JSON 确为 29 PASS，格式校验通过；本轮 16 个定向文件 47 用例通过，但额外复现揭示 Q1/Q6 问题。按用户范围未重跑 188，不能认证该数字或全部验收。 |

A1：路由迁移引入请求挂起，阻断签署“全部等价迁移完成”。

- 位置：`apps/host/src/server/http.ts:196` 使用 `(?:\/(.+))?`；`apps/host/src/server/routes/conversations.ts:18` 使用 `(?:\/([^/]+))?`。
- 入口：已通过正常 owner 认证的 `GET /api/v1/conversations/primary/turns/example/memories/a/b`。
- 根因：外层接走并 return，内层没有匹配分支也不写响应，总入口尾部 404 不再执行。
- 复现：真实临时 Host、真实 HTTP/socket；普通会话列表先返回 200 证明认证有效。旧 `4dfa709` 对该请求返回 404“未知路由”；当前没有响应，测试用 1 秒超时结束等待。源码证明不是服务变慢，而是 handler 返回后未结束 response。
- 影响限度：只确认未列出的多段子路径被吞；未发现正常已列出路由失效，也不是权限泄漏。另 12 个有限未知路由返回 404；content 沿原前缀代理合同在未配置时返回 503，不误判成新问题。
- 证据：`evidence/router-and-define.log`、`evidence/router-before-migration.log`；复现代码 `reproductions/audit-router-and-call-define.test.ts:65`。

B1：通话 define 资格未收口。

- 位置：`capabilities/model-bridge.ts:102` 仅对 tool_invoke 解出业务名；`:148` 的 tool_define 分支返回定义前不检查业务资格。`model-bridge-meta.ts:8` 只表明协议入口可用。
- 最小正常操作：POST /v1/calls 建立 active 通话；通过正常 HTTP 提交消息；fake 模型返回 tool_define(wishstar_list_offers)；检查真实 Supervisor 下一次模型请求的工具结果。
- 预期：沿专项 D39 返回 TOOL_UNAVAILABLE_IN_CALL。实际：返回 name/definition_id/parameters，模型请求计数为 2，证明完整定义确实进入下一请求。
- 后续 invoke 仍会被拒；不报告业务执行越权。此问题旧版已有，本轮要求修复但没有修到。
- `tests/unit/b2-memory-only-gate.test.ts:66–69` 仍断言 define 成功，测试与现行专项合同不一致；不能用该测试全绿证明四处统一。
- 证据：同上两份路由/通话日志；复现代码 `reproductions/audit-router-and-call-define.test.ts:97`。

B2：仓内取消测试第三例存在证据空洞，但生产修复已由独立测试确认。

- `tests/integration/codex-voice-preparation-disconnect.test.ts:38–39` 创建 releaseAnalyse；`:55` 等待它；全文件没有释放它。analyses 在等待之后才递增，第三例靠悬挂 fake 得到零完成数。
- 该例在分析请求已进入后才断线，不能把分析完成数 0 表述成派发数 0；它也没有查询 oido_ingest_receipts，ingests===1 不能证明持久回执存在。
- 本次只在临时副本修正审计 fixture：放行全部迟到响应、分别记录分析派发和完成、查询真实 receipt，并增加“ingest 成功、转写补挂暂缓、断线、迟到返回”一个有限场景。
- 独立结果：音频取回阶段断线 → ingest/分析/模型全 0；ingest 后、分析前断线 → receipt 1、分析派发 0、模型 0；分析已派发时断线 → receipt 1、已派发 1、完成 0、模型 0。三种取消均没有正式消息/turn，接纳 cancelled。正常对照通过。
- 不要求修改当前正确的生产取消链，只应修正仓内测试和证据措辞。
- 证据：`evidence/independent-reproductions.log` 中前两个文件；代码 `reproductions/audit-phone-late-receipt.test.ts`。原始两场景修复前日志为 `evidence/phone-before-fix.log`。

B3：真实 smoke 的总 PASS 不足以证明全部步骤成功。

- `scripts/real-integration-smoke.mjs:72` 捕获 ingest/analyze 错误只写字段；`:84` 只因 capabilities 失败设置退出码。因此存在 ingest/analyze 失败却仍打印 REAL_SMOKE_PASS 的路径。
- 不把 `:106` 只检查 image dims 另外报成缺陷：进一步追踪 `media/index/service.ts:58–68` 后确认，真实 worker client 已检查结果数量、ID 唯一且属于请求、768 维、有限非零向量；两项请求成功返回时文本项不能无故缺失。这里不需要重复校验。
- 当前证据 JSON 的具体字段本身记载 ingest 成功、partial/1 observation、图文各 768 维；没有发现数字矛盾，也没有证据可称造假。问题在脚本成功判据和报告结论的适用范围。
- `scripts/ds-smoke.mjs:74–81` 明确注入 mariposaFake。其 committed hold/书签是本地模块接收 fake 回执；DS 可真实出网，不代表该脚本写入真实 Mariposa。
- `cacheObsRequests` 统计非 null，包括 0；证据有 5 次缓存观测，其中 4 次正缓存读数，不能写成 5 次命中。
- real-integration-smoke 直接 client/adapter 调用，只证明相应适配层；没有经过 Host→Registry→正式消息授权全链。Siren 明确未验证。

C：记录，不据此新增防御。

- `ModelToolBridge.resolveQuoteRefs` 外层包装仍在 `model-bridge.ts:45`，由 quote-seen-scope 测试消费。memory 正本的同名业务方法仍必须保留；不能按符号名一并删。
- `memory/service.ts:917` 仍解构丢弃 __tool_call_id，但该字段已不能通过 schema 进入身份派生；不是身份绕过。
- 两处测试动态解构已删除的 wireOidoCapabilitiesForTest 但没有使用；若干旧名称只出现在注释、测试标题/类型标注。它们不证明旧执行路径还在，不能机械按全仓 grep 命中判生产失败。
- 导入环已消失；结构检查仍有 1 项 supervisor→mariposa/bootstrap-pages 边界违规。report 模式退出 0 不等于零违规。
- bindMessageLifecycle 的 activity 参数未消费，真实活动锚点仍在 MessageService 发布事务内执行。未发现活动记录丢失，报告应描述实际路径。
- B/旧窗准备仍有多次 currentCatalog 取样。进一步查真实入口后，默认初始可见工具为静态 identity，未找到 pending 建好后旧窗再刷新词表的可达顺序；不构造手改 DB/竞态夹具要求新增防御。
- 新扩展测试已实际 define→invoke，但没有 tool_catalog 步骤；保留该覆盖限制，不否定新模块接入结论。

实际执行记录：

1. `git diff 6587029..HEAD --stat -- apps/ scripts/ tests/ packages/`：退出 0，无差异。
2. `/opt/homebrew/bin/node node_modules/typescript/bin/tsc --noEmit`：退出 0。
3. `/opt/homebrew/bin/node docs/specs/MODULE_CONTRACT_REFACTOR_V1/scripts/check_boundaries.mjs --repo . --mode report`：退出 0；cycles=[]；violations=1（上述 bootstrap import）。没有执行指令中错误的 Python 调 mjs 再 `|| true`。
4. `python3 docs/specs/MODULE_CONTRACT_REFACTOR_V1/scripts/validate_delivery.py --results docs/reports/MODULE_CONTRACT_REFACTOR_V1/ACCEPTANCE_RESULTS.json --evidence-root .`：退出 0；formatValid=true；productCorrectnessCertified=false。
5. 两个 golden 分别执行单路径 `git log --follow`，都只有创建提交；创建提交和当前 Git blob ID 分别相等：tool-catalog=`2fc50b6237d02da40ff97fe41121c62070811a2d`；session=`7c2973027f384c0d0ce822f839cae2ab17621f2c`。
6. `git rev-list --count 849b1d5..6587029`：退出 0，63。指定 key 形状 git grep 无匹配（退出 1），不输出或读取任何凭据值；这不是所有秘密形态的完整泄漏证明。
7. 已分类 unit 14 文件、42 用例通过，退出 0；integration 2 文件、5 用例通过，退出 0。下面保留完整选择器。
8. 独立原电话复现：旧源码 control PASS/cancel FAIL，退出 1；当前源码两例 PASS。独立扩充电话回执测试当前 4/4 PASS。当前路由/define 两个行为断言均 FAIL，退出 1；旧源码同文件路由 PASS/define FAIL。

定向命令（所有命令均在临时 ESTOMAGO_HOME、清空外部凭据的进程执行；runner 给每个文件再分配独立临时根）：

```sh
/opt/homebrew/bin/node scripts/run-tests.mjs --unit \
  --file=tests/unit/probe-module-extension-drill.test.ts \
  --file=tests/unit/tool-catalog-golden.test.ts \
  --file=tests/unit/surfacing-seam.test.ts \
  --file=tests/unit/dial-request-flow.test.ts \
  --file=tests/unit/hold-quote.test.ts \
  --file=tests/unit/call-stop-queued-turn.test.ts \
  --file=tests/unit/oido-get-registry-host-wiring.test.ts \
  --file=tests/unit/b2-memory-only-gate.test.ts \
  --file=tests/unit/invite-reaction-scheduling.test.ts \
  --file=tests/unit/model-results.test.ts \
  --file=tests/unit/model-wire-measurement.test.ts \
  --file=tests/unit/module-contract-session-snapshot.test.ts \
  --file=tests/unit/audit-1005b-root-cause.test.ts \
  --file=tests/unit/full-audit-tool-budget.test.ts

/opt/homebrew/bin/node scripts/run-tests.mjs --integration \
  --file=tests/integration/codex-voice-preparation-disconnect.test.ts \
  --file=tests/integration/background-product-chain.test.ts
```

复现文件放在当前提交的临时 git archive 副本的 tests/integration 下，复用已有 node_modules 和 runner；不要放回被审工作树。用同样的 `--integration --file=tests/integration/<文件名>` 运行。原工作树与临时副本的生产源码没有修改。

日志诚实性说明：独立路由/define 夹具初版误将新消息的正确 201 Created 限为 200/202；查看既有 HTTP 合同后只修临时测试。最终 Q1 结论采用修正后的 `router-and-define.log`，不是该前置断言错误。`independent-reproductions.log` 的后半保留这个调试失败，不计为生产问题；前半的电话观测不受影响。

源码位置均相对 `/Users/owner/Projects/devspace-workspace/worktrees/estomago-module-contract-v1`。该目录本轮未修改；所有 fake 数据和测试根均与生产隔离。后续修复应针对 A1/B1 和证据缺口进行，不因本报告扩展 Siren/oído 全量审计。

1. 可否批准“专项完成＋合并 refactor/module-contract-v1”：否；先修 Q6 路由回归和 Q1 define 政策，纠正两项证据脚本/测试并定向复核。
2. 未覆盖清单：按用户选择未执行 188 全量；未重跑真实服务/付费模型；未审计 Siren/oído 服务内部；未认证仓外历史运维或生产部署状态。

