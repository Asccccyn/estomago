# estómago 修复复审：0632d8c

实际 HEAD：`0632d8c0bd393a1d179cf7c4b44251183f76705b`，分支 `refactor/module-contract-v1`，开始与结束工作树均干净。对照上一轮审计候选 `15fb87bffbbb1293537be50598d3c0d7b9289357` 检查全部 12 个变更文件。本轮是修复复审，不重新审计没有变化的 48 个业务 handler。

结论：A1、B1、B2 已关闭；B3 原先吞异常仍 PASS 的路径已修，但合法 running 票据仍会被计为整体 PASS，故 B3 仅部分关闭。没有发现本次修复新增生产运行回归；当前剩余项在验收脚本及报告，不需要再改生产取消链或重新做大规模重构。

| 上轮项 | 本轮裁决 | 代码与实际验证 |
|---|---|---|
| A1 未知 memories 多段路径挂起 | 关闭 | `server/http.ts:196` 已与 `routes/conversations.ts:18` 同用单段匹配。真实 Host HTTP 用例确认目标路径恢复完整 404；其他被测未知路径不超时，content 原有未配置 503 保持。 |
| B1 通话 define 政策不一致 | 关闭 | `model-bridge.ts:151–153` 按真实业务名称核资格，位于免费准入和 already_available 之前。真实 HTTP 建呼、正常消息、Supervisor 模型续轮实际收到拒绝码；获准记忆工具 define 对照通过。UI 入口条件未扩大。 |
| B2 取消测试未释放 gate/未查回执 | 关闭 | 测试现在释放三个 gate，派发/完成分开计数，查询真实 receipt。四场景通过：正常、取音频时断线、分析已派发时断线、ingest 完成但分析前断线。生产取消代码本次未改。 |
| B3 smoke 误 PASS/范围措辞 | 部分关闭 | HTTP/transport 分析失败现在 exit 1；合法 running 票据仍 exit 0 并输出 REAL_SMOKE_PASS。已通过实际脚本+全 fake 外部 transport 复现。范围澄清增加，但旧 NOT_EXECUTED 文字仍冲突。 |

B3 的剩余根因与最小复现：

- `scripts/real-integration-smoke.mjs:71` 用 `'analysis_id' in res` 识别结果；`:73` 只要求 analysis 非空。
- `integrations/oido/adapter.ts:7–14,91,113` 明确区分 ready/partial 结果和 queued/running 票据，二者都有 analysis_id。等待窗口内分析尚未完成是当前支持的正常返回，不是伪造异常状态。
- 本次没有执行真实 smoke。仅在当前提交的 git archive 临时副本中，用 `--import` 预加载一个完全替换 fetch 的外部边界 fake，再执行未经修改的 `scripts/real-integration-smoke.mjs`。未替换 Adapter 或脚本成功判断，没有复制该判断到测试。
- 控制一：partial＋1 条观测 → 脚本 exit 0 / REAL_SMOKE_PASS，符合预期。
- 控制二：分析 HTTP 503 → 脚本 exit 1 / REAL_SMOKE_FAIL，证明原错误路径已修。
- 待完成：合法 `{analysis_id:'analysis_audit',state:'running'}` → 脚本 exit 0 / REAL_SMOKE_PASS，尚不能证明分析产出。
- 日志：`evidence/smoke-offline.log`。复现源：`reproductions/audit-smoke-verdict.test.ts` 与 `reproductions/audit-smoke-fetch.mjs`。日志中的服务结果全是合成 fake，不可引用为真实服务证据。

最小收口：让“分析已完成”的 smoke 成功只接受 `ready` 或 `partial`；queued/running 保留实际状态并使本次检查非成功。不增加轮询、自动重试、观察数下限、费用策略或下游修改。若只想验证受理，则应另行明确报告为 accepted/incomplete，不能继续使用它证明分析完成。

报告同步事项（不作为新增生产缺陷）：

- `TEST_EVIDENCE.md:56` 已澄清 DS smoke 的 Mariposa 为 fake，5 次是缓存观测、其中 4 次正读数；`:72` 已区分 adapter 直连与完整 Host/Registry 链。这些更正有效。
- 同文件 `:92` 仍把真实模型/embedding/Mariposa/oído 等整体写为 NOT_EXECUTED，与前面的历史真实 smoke 记录矛盾。
- `GLM_DELIVERY.md:22–24` 仍笼统写未执行真实收费。应标清“本批离线回归未调用”与“此前单列 smoke 的报告状态”，不需要重跑付费测试。
- 电话排队取消证据应引用 `reaudit-entry-boundaries.test.ts` 的 REV-E03；`call-stop-queued-turn` 主要验证通话状态和权限联动。当前 TEST_EVIDENCE 末尾仍有旧引用。
- 新回归文件实际列了 13 条未知路径，另有 content 的 503 对照；不要把注释里的“16 条全 404”当事实。此计数不影响修复正确性。

实际执行：

```sh
/opt/homebrew/bin/node scripts/run-tests.mjs --unit \
  --file=tests/unit/b2-memory-only-gate.test.ts \
  --file=tests/unit/tool-discovery-supervisor.test.ts \
  --file=tests/unit/full-audit-tool-budget.test.ts \
  --file=tests/unit/module-contract-session-snapshot.test.ts

/opt/homebrew/bin/node scripts/run-tests.mjs --integration \
  --file=tests/integration/audit-router-and-call-define.test.ts \
  --file=tests/integration/codex-voice-preparation-disconnect.test.ts
```

上述命令均用清空凭据的进程及独立临时 ESTOMAGO_HOME，通过既有 runner 串行执行。unit 4 文件/10 用例、integration 2 文件/6 用例，均退出 0；日志在 evidence/unit.log 和 evidence/integration.log。

另执行：TypeScript `--noEmit` 退出 0；`node --check scripts/real-integration-smoke.mjs` 退出 0；check_boundaries report 退出 0，运行时环为空，仍有原已记录的 supervisor→bootstrap-pages 1 项边界违规。本次没有修改 golden 或测试 runner。

临时副本运行 `scripts/run-tests.mjs --unit --file=tests/unit/audit-smoke-verdict.test.ts`：2 个控制用例通过，running 用例按“不得认证完成”的断言失败，runner 退出 1。所有网络请求均由 preload fake 返回，未调用真实服务/模型、未读取凭据、未产生实际费用。

本轮未修改被审工作树；未部署；未执行无选择器全量测试；未审计 Siren/oído 服务内部。审计报告及一次性复现只保存在独立审计目录。

合并判断：生产行为修复复审通过；“四项全部关闭、验收全部完成”的交付结论仍需先补齐 B3 判据与报告同步，再做相应小范围复核。

