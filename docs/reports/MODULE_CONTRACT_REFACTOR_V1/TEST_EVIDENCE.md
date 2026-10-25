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
- 不变量：holdVerified=true、bookmarkAdvanced=true、toolRound2=true、cacheObsRequests=5；provider_requests 5 发 5 达。
- 证据：`evidence/ds-smoke-live-20261025.json`（key 不落任何文件/日志——已检查产物）。
- 前置修复：ds-smoke fake 模型参数补必填 creation_mode（脚本过时——基线 4dfa709 即必填；非产品回归）。dry-run 先行通过后才跑 live。

## 覆盖与限制（如实）

- 29/29 验收项 PASS 的证据种类均为 OFFLINE_CONTRACT（见 ACCEPTANCE_RESULTS.json）。
- A12 两件事分开陈述：**排队电话取消**（call-stop-queued-turn，此前已覆盖）与**准备阶段断线**（本轮批次 1 修复+新集成测试，见上）。
- NOT_EXECUTED：真实收费模型/ASR/TTS/embedding/Mariposa/oído/Siren 调用（07 §6 第 4 层）；生产部署/真实缓存命中/真实通话延迟。
- 未运行：无。本轮为全量 188 文件（含前端 react 渲染测试）。
