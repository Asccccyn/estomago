# 独立审计裁决（以代码为准）— refactor/module-contract-v1 @ 15fb87b（冻结 6587029）

审计者：独立审计模型会话（ZCode/GLM）。全部结论基于自跑命令输出与代码行号；实施者报告仅作索引。
工作树：/Users/owner/Projects/devspace-workspace/worktrees/estomago-module-contract-v1

## 冻结与入口验证
- HEAD=15fb87b（分支 refactor/module-contract-v1）；`git diff 6587029..HEAD --stat`（全仓）= 仅本审计指令 md（75 行插入）；`-- apps/ scripts/ tests/ packages/` = 空。冻结成立（且强于声称：services/ config/ deploy/ 亦零变更）。
- 全量测试（审计者自跑，隔离 ESTOMAGO_HOME）：**188/188 文件通过，0 失败，exit 0**。typecheck（tsc --noEmit）exit 0。
- golden 防重录：tool-catalog-baseline.json 仅 1 次提交（9862d00），module-contract-session-baseline.json 仅 1 次提交（49a17ad）；两文件 blob 采集时=HEAD 逐字节一致；工作树 tests/golden/ 零未提交变更。**无重录**。Q3 的 `770e9fef…` 为 golden 文件内 toolsSha256 字段（:109），非文件哈希——恒定成立。

## 十问裁决

**Q1 唯一执行路径 — PASS**
supervisor.ts:831 为唯一工具执行调用（d.tools!.execute）；executeRegisteredCapability 全仓唯一调用方=model-bridge.ts:190。model-bridge.ts executeInner:177-196：discovery 三名走 executeDiscovery，非 registry 名一律 TOOL_NOT_IN_ALLOWLIST（:195）——无旧业务分支、无按名硬编码路由。D39 资格判定单点 isMemoryOnlyAllowed（:164-168）被 execute 预门（:104-109，effective name 含 tool_invoke 解包）、catalog 过滤（:145-146）、executor.ts:26-29 最终边界三处共用。48 业务工具+deferred 3（golden 实测）。

**Q2 身份只走可信 ctx — PASS**
注入唯一：supervisor.ts:840 toolCallId: t.tool_id。基线反例（849b1d5）：supervisor:836 注入 args；host-tools.ts:1950 派生 args.__tool_call_id 优先于 ctx；:928 校验跳过/:1776 白名单放行——模型自报可抢占身份。现 `__` 前缀 args 拒收（model-bridge.ts:157）；memory/service.ts:917 防御性剥除并覆写 ctx 派生值。es-* 8 键公式与 849b1d5 逐字一致（memory/service.ts:239/326/367/700/769/838/916；es-an=oido/service.ts:98），仅身份源换 ctx。

**Q3 冻结与缓存红线 — PASS**
tool-discovery.ts:19-33 已存即返（:20）+INSERT OR IGNORE（:32）+旧窗从 provider_requests 恢复精确已发 tools（:23-29）。registry.currentCatalog 按 baselineOrder（registry.ts:97-99）。mood 跟随=audit-1005b 行为断言（新词过门/旧词拒/失败保快照）。会话 wire golden 经 module-contract-session-snapshot 消费，通过。

**Q4 电话准备阶段取消 — PASS（重放双向）**
4dfa709 worktree+拷入测试重跑：1 pass/2 fail（expected 'cancelled' actual 'admitted'）——与留档 batch1-before-fix-4dfa709.log 形态一致（control ok，子测 2/3 not ok）。HEAD 定向：3/3 pass。取消链=routes/voice-stream.ts（prepareAbort:94、res.on('close')+!writableEnded:113、signal 贯穿:126-165、estTurnId 接线:174）。

**Q5 消息生命周期 — PASS**
service.ts:29 构造只收 MessageLifecycleHooks|null；SurfacingMessageHooks/legacyCompatView/lifecycleFromLegacySurfacing 全仓 0 命中。bindMessageLifecycle=application/message-lifecycle.ts:15，app-context.ts:162 装配 surfacing+activity。afterCommit 只唤醒（lifecycle.ts 合同）。surfacing-seam 40 断言全行为级。

**Q6 P07 路由迁移 — PASS**
http.ts 实测 364 行，通读验证结构=认证门+health+静态+voice 预认证分派+12 精确路由表委托+尾 404（:298 未知路由）+13 模块导入/re-export。逐字搬迁：13/13 模块语句行（剔 import/签名/注释头、缩进不敏感）对四基线并集（4dfa709/849b1d5/2b59251^/0ad841a^）0 缺失；voice-stream 唯一 30 行差异全部=e4d48ba 批次1修复本体（存在于迁移前基线 0ad841a^）——迁移零改写。未列出子路径实测 16/16 全 404 未知路由（含指令示例 PATCH /api/v1/background/xyz），exit 0。SSE：events.ts:14 正本→http.ts:357/360 re-export→aud-08-09-29 合同测试经 http.ts 引用，通过；handleVoiceChatStream re-export 供 b8/reaudit 直调（import 实证）。"1874→364"核实：http.ts@47c8c17=1874 行→0ad841a=364 行，准确。

**Q7 扩展局部化 — PASS**
核心目录（supervisor.ts/messages//capabilities/）diff 中 "probe" 命中 0。registerProbeMemoryConsumer 仅 tests/helpers/probe-module.ts:65+drill:219，经 memoryPublicRead.iRead→memoryIRead 公共只读方法，无 DB 直连。drill 断言行为级（冻结目录不含探针/逐项不变/新窗采用/真实执行）。

**Q8 真实层证据对账 — PASS（Siren 子项未验证，如实披露）**
ds-smoke-live JSON 内部自洽（cache_read 0→11904→12160→12416 递增、es-hold-<40hex> 与代码公式一致）。real-integration JSON：vocab 7 类/analyze partial+1 观察/embedding 768 双模态，与声称逐项对上；脚本输出字段一一对应（real-integration-smoke.mjs:39/78/101/116）。key 零入仓：sk-(or-)?v1- 与泛 sk- 模式均 0 命中。Siren：8790 两次确认未监听，未补跑（证据本身如实记 ECONNREFUSED）。

**Q9 无生产污染 — PASS**
63 提交（849b1d5..6587029）触碰文件顶层全集={docs,apps,scripts,tests}；LaunchAgent/.plist/deploy/生产 config 命中 0。

**Q10 报告对账 — PASS**
validate_delivery.py formatValid=true exit 0。ACCEPTANCE_RESULTS 29 项全 PASS；抽 10 项（A01/A02/A03/A12/A15/A22/A25/A26/A28/A29）与审计者独立验证对账——除 A28（见 B1/C1）外全部一致；A12 两场景命令原样重跑 exit 0。188/188=审计者自跑结果。

## 发现

- **A 级（阻断）：无。**
- **B1（应修）**：`wireOidoCapabilitiesForTest`"删除"声明不成立。GLM_DELIVERY.md:10 声称已删（assembleTestTools 显式装配——该部分属实，helpers.ts:138 用生产 registerOidoCapabilities），但 tests/helpers/module-contract-session.ts:118 与 tests/unit/call-stop-queued-turn.test.ts:34 仍解构该已删除导出（得到 undefined，从未调用）。行为无影响（188/188 不受扰），但"已删除=全仓命中 0"不成立。应删两行死引用。
- **C1（记录）**：`resolveQuoteRefs`"外层包装版"未删除而是逐字迁至 model-bridge.ts:45（与 4dfa709 host-tools.ts:311 同文），唯一外部消费=quote-seen-scope.test.ts 桥缝调用；P04 注释声明为有意窄委托。机制无违规，与清单字面不符。
- **C2（记录）**：HostToolExecutor/MEMORY_ONLY_TOOLS/TOOL_LABELS/SILENT_TOOLS 等仅在注释/测试标题中残留提及（非代码引用）；__tool_call_id 在 memory/service.ts:917 为防御性剥除（安全增益，非注入）。

## 裁决

1. 可否批准"专项完成+合并 refactor/module-contract-v1"：**可（有条件）**——条件：合并前（或合并后首个提交）删除 B1 两处死引用，使"已删除"声明与代码一致。无 A 级发现，B/C 均无行为影响。
2. 未覆盖清单：Siren 真实验证（8790 未运行；补跑路径已在审计指令 Q8 留档）；真实 OR 调用（范围外，key 属用户）；DS live 冒烟未由审计者复跑（仅做证据一致性+脚本逻辑对账，未消耗 API）；est 仓之外（跨仓合同只验 est 侧调用形状）。
