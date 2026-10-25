# TEST_EVIDENCE（审计指令 7 批次后统一冻结候选）

代码冻结候选：`refactor/module-contract-v1` 分支 HEAD（本报告提交的父提交；完整 HEAD 见 RESUME/GLM_DELIVERY 顶部）。本报告提交本身只含文档与证据文件。

## 最终统一回归（批次 7）

命令与结果（真实记录，无占位）：

```
ESTOMAGO_HOME=$(mktemp -d /tmp/estomago-test-home.XXXXXX) /opt/homebrew/bin/node scripts/run-tests.mjs
→ 188/188 个测试文件通过，退出码 0（2026-10-25；代码冻结 HEAD b453cc9f357daa067dc07e76caa33c0622b346ae）
```

- 全量选择器（无 --file）为本轮新增覆盖面；此前冻结政策只跑 49 文件定向选择器。
- 其中 4 个 react-* 前端测试需 `apps/web/react` 下 node_modules（本轮 `npm ci --prefix apps/web/react` 安装，46 包，不触碰任何跟踪文件）；缺依赖时报 Cannot find module 'react'，属环境而非代码。
- `npm run typecheck` → exit 0（2026-10-25）。

## 批次 1：电话准备阶段取消失效（修复根因）

根因：`handleVoiceChatStream` 在幂等接纳后**没有**建立取消处理（断线监听安装太晚），且旧实现把 `req.close`（正常请求体读完也触发）一律当取消；音频取回/ingest/analyze/模型请求在客户端断开后照常执行。

修复前证据（父提交 4dfa709 上运行同一复现测试，退出码 1）：
`evidence/batch1-before-fix-4dfa709.log`
- `disconnect-audio`：`abortedAtRelease:false, ingests:1, analyses:1, modelRequests:1, stream:completed`（断线后三条外呼照跑）
- `disconnect-after-ingest`：ingest 已发 1、stream 停在 admitted

修复后证据（e4d48ba 起）：`evidence/batch1-after-fix-e4d48ba.log`
- control：ingest/analyze/model 各 1（正常路径不受伤）
- disconnect-audio：`abortedAtRelease:true, ingests:0, analyses:0, modelRequests:0, stream:cancelled`
- disconnect-after-ingest：`ingests:1`（回执保留）、analyses/model 0；同键重试 replayed+prior_state:cancelled

复现测试已迁入正式目录：`tests/integration/codex-voice-preparation-disconnect.test.ts`（真实 Host/HTTP，仅外部 Siren/oído/DS transport 为 fake）。

## 批次 2-6 证据（定向命令，均 exit 0）

- 批次 2（投影正本唯一化）：model-results/model-wire-measurement/invite-reaction-scheduling 等定向通过（78e3cbf）。
- 批次 3（Registry 单一来源）：tool-catalog-golden 逐字节恒定（sha256 770e9fef…）；mood 词表跟随验证（currentCatalog 之前/之后词表对比，21f2725）。
- 批次 4（身份只走 ctx）：72416b6+2dacbc9+47c8c17 收尾——runtime/host-tools.ts 已删除（git rm），全部 19 处消费者迁移；d2 操作键序回归通过。
- 批次 5（生命周期+HTTP 叶）：surfacing 6 文件 52 用例通过（bindMessageLifecycle 显式包装 + 装配形状守卫）；dial-request-flow 通过（47c8c17）。
- 批次 6（演练收尾）：probe-module-extension-drill 演练A + 演练A27（absent bound:false 进 tool 消息、memory 公共只读消费者恰好一次、正式发布落库）通过（036b401）。
- 批次 7 前清扫：统一回归暴露 18 个测试装配过时（目录来源/lifecycle 形状/身份 ctx/adapter 接线），全部修复，无生产行为改动（b453cc9）。

## P07 后续批次（2026-10-25 第二轮，用户继续指令后）

- 第二批（6df168b）：content 薄代理+后台 settings/tasks/runs 组迁 server/routes/（content.ts/background.ts；精确路由表委托，未列出子路径照走链尾 404，不被前缀抢占）。
- 第三批（80fd59f）：会话/消息/浮现视图组（conversations.ts 逐字）+深听 UI 组（oido-ui.ts）迁 routes/；estimateContextFor 下沉 http-leaf（结构化参数，leaf 零反向依赖）。
- 定向 7/7（message-history/snapshot/mock-turn/records-api/aud-ops/wp4-http/wp5-content）；全量回归 188/188 exit 0。
- 仍留 http.ts：events SSE、runtime-settings、time/calendar、assets 上传/导入、dial/invites、token-estimates、system-alerts、turns、voice/status+transcribe——P07.2 未尽部分如实登记（BLOCKERS）。

## 真实付费冒烟（用户 2026-10-25 授权 DS key；OR key 未使用）

命令：`ESTOMAGO_DS_SMOKE=1 DEEPSEEK_API_KEY=<环境变量传入> node scripts/ds-smoke.mjs` → **SMOKE_PASS，退出码 0**。

- mode=live，model=deepseek-chat，endpoint=https://api.deepseek.com（DS 官方直连，不经 OpenRouter；OR key 全程未读）。
- 三步全 completed：chat 基线 / 工具往返（memory_hold 经 registry→executor→memory 域真实执行，effects=[hold:committed]）/ append-only 续轮。
- 不变量：holdVerified=true、bookmarkAdvanced=true、toolRound2=true、cacheObsRequests=5（5 次缓存**观测**，其中 4 次正读数——审计 B3 更正：该计数含 0，不得表述为 5 次命中）；provider_requests 5 发 5 达。- 范围澄清（审计 B3 更正）：ds-smoke 的 Mariposa 为 **fake transport 回执**——hold/书签验证的是 est 侧真实工具往返与账本，未写真实记忆库；DS 模型为真实付费调用。
- 证据：`evidence/ds-smoke-live-20261025.json`（key 不落任何文件/日志——已检查产物）。
- 前置修复：ds-smoke fake 模型参数补必填 creation_mode（脚本过时——基线 4dfa709 即必填；非产品回归）。dry-run 先行通过后才跑 live。

## P07 收官（2026-10-25 第三轮）

七批全部完成：routes/ 十三模块（voice-call/content/background/conversations/oido-ui/runtime-settings/context-selection/calendar/assets/dial/system/events/voice-stream）；http.ts 1874→364 行（认证门+Origin 门+health+静态+入口委托+链尾 404）。全部逐字搬迁+精确路由表委托（未列出子路径照走 404）。提交链 7dfdcb9→e3f6492→0ad841a；每批定向通过；收官全量 **188/188 exit 0**。提取脚本三次拍平事故（readlines/split 混用、贪婪正则）均当场从 HEAD 重提修复并录入教训。

## 真实集成冒烟第二轮：本机 loopback 真实服务（用户授权非 OR 凭据）

命令：`source <secrets env>; unset OPENROUTER_API_KEY; ESTOMAGO_REAL_SMOKE=1 node scripts/real-integration-smoke.mjs` → **REAL_SMOKE_PASS，退出码 0**。

- Mariposa（127.0.0.1:18780）：bootstrap.get ok（profile=estomago）+心情词表 7 类——经 MariposaClient，42ms。
- oído ASR（127.0.0.1:8791）：真实合成语音（say+afconvert，126KB WAV）ingest→analyze：state=partial、1 观测——经 OidoAdapter，1133ms。（先前的 8 字节假头只能过合同门、真分析后端拒——换真语音后通过。）
- embedding worker（127.0.0.1:8792）：仓内真实 PNG+真实中文文本→embeddinggemma-2 双模态 768 维向量——经 MediaEmbedWorkerClient，362ms。（截断假 PNG 会被真实后端断连——教训已记。）
- Siren（127.0.0.1:8790）：ECONNREFUSED——服务当前未运行；只读探测、绝不建呼（防真实电话）。如实登记未验证。
- 范围澄清（审计 B3 更正）：real-integration-smoke 经 est 的 client/adapter 层直调真实服务——证明适配层合同与真实后端兼容；**不是** Host→Registry→正式消息授权的全链验证（全链离线合同由 188 套测试覆盖）。
- 凭据纪律：OR key 在 mariposa.env 中存在但运行前显式 unset，全程未用；所有 token 经 env 名间接引用，证据 JSON 已扫描零泄露。

## 双审计结果与修复（2026-10-25 第四轮）

两份独立审计（裁决原文见 review-findings/）：
- **ZCode 会话审计**：Q1-Q10 全 PASS、零 A 级；条件=删两处 `wireOidoCapabilitiesForTest` 死引用（已删）。
- **Codex 审计**：Q2-Q5/Q7 PASS；**Q1/Q6 FAIL**（A1 路由回归、B1 define 门缺失）+ B2 证据空洞 + B3 判据过松；裁决"先修再合并"。

四项修复（全部落测试）：
- **A1**：conversations 委托正则 `(.+)`→`([^/]+)`——多段子路径（memories/a/b）回归 404 完整响应。回归=tests/integration/audit-router-and-call-define.test.ts（13 条未列出子路径全 404 实测+content 未配置 503 对照——Codex 复审计数更正）。
- **B1**：model-bridge tool_define 分支补通话 memory_only 门（D39 四处同政策补齐；旧版仅 invoke/直接执行设门）。b2-memory-only-gate 期望改为"非记忆 define 拒绝 TOOL_UNAVAILABLE_IN_CALL、记忆 define 保留"；回归=audit-router-and-call-define 第二用例（真实 HTTP+Supervisor，定义结果进入下一模型请求且为拒绝码）。
- **B2**：codex-voice-preparation-disconnect 换入 Codex 四场景修正版（放行迟到响应、派发/完成分开计数、查 oido_ingest_receipts、补"分析派发中断线"）——生产取消链经独立复现本就正确，修的是仓内测试的证据空洞。
- **B3**：real-integration-smoke 成功判据收紧（ingest/analyze 任一失败即 FAIL）+ 本文件三处措辞更正（见上）。
- 顺带：check_boundaries 余 1 项 supervisor→bootstrap-pages 边界违规（Codex C 记录，迁移期已登记项）；bindMessageLifecycle activity 参数未消费=活动锚点实际走 MessageService 发布事务（行为正确，报告此前描述已在 GLM_DELIVERY 注明）。

## Codex 修复复审（0632d8c）与 B3 终收口

复审原文=review-findings/audit-codex-rereview-0632d8c.md：**A1/B1/B2 关闭**；B3 部分关闭（running 票据仍计成功）+四项报告同步。

本轮收口（本笔提交）：
- **B3 终收口**：real-integration-smoke 分析完成态只认 `ready|partial`；queued/running 票据如实记录 `analyze_state` 且不计成功（受理≠完成；不轮询不加时——按复审最小收口口径）。离线三对照验证（预载 fake fetch，零真实调用）：partial→exit 0 PASS；HTTP 503→exit 1 FAIL；**running 票据→exit 1 FAIL 且 state 如实上报**（复审指出此前会误 PASS）。
- 报告同步四项：TEST_EVIDENCE 未执行清单与真实冒烟记录对齐（TTS 未单列执行如实注明）；GLM_DELIVERY 改"29 项验收=离线合同，真实层另列单列 smoke"；A12 排队取消主证据改指 reaudit-entry-boundaries REV-E03（call-stop 为联动佐证）；回归路由计数更正 13 条+content 503 对照（原误写 16）。

## 覆盖与限制（如实）

- 29/29 验收项 PASS 的证据种类均为 OFFLINE_CONTRACT（见 ACCEPTANCE_RESULTS.json）。
- A12 两件事分开陈述：**排队电话取消**（主证据=reaudit-entry-boundaries.test.ts REV-E03 排队取消恢复；call-stop-queued-turn 为通话状态与权限联动佐证——Codex 复审指向更正）与**准备阶段断线**（本轮批次 1 修复+四场景集成测试，见上）。
- 未执行（更新于 Codex 复审：与上文真实冒烟记录对齐）——**真实 Opus/OR 调用**（OR key 属用户，切生产自测）；**Siren 真实合同**（服务未运行，见上文如实记录）；**生产部署/真实缓存命中/真实通话延迟**。
- 已单列执行的真实层（本文件上文两节，不在此重复为未执行）：DS 官方付费冒烟、本机 Mariposa/oído ASR/embedding loopback 冒烟——均为**单列 smoke 脚本**证据；专项验收 29 项本体仍为 OFFLINE_CONTRACT（离线回归不调用外部服务）。TTS 未单列执行（oído 冒烟覆盖 ingest→analyze 听析链，未覆盖 TTS）。
- 未运行：无。本轮为全量 188 文件（含前端 react 渲染测试）。
