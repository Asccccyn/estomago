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

## 覆盖与限制（如实）

- 29/29 验收项 PASS 的证据种类均为 OFFLINE_CONTRACT（见 ACCEPTANCE_RESULTS.json）。
- A12 两件事分开陈述：**排队电话取消**（call-stop-queued-turn，此前已覆盖）与**准备阶段断线**（本轮批次 1 修复+新集成测试，见上）。
- NOT_EXECUTED：真实收费模型/ASR/TTS/embedding/Mariposa/oído/Siren 调用（07 §6 第 4 层）；生产部署/真实缓存命中/真实通话延迟。
- 未运行：无。本轮为全量 188 文件（含前端 react 渲染测试）。
