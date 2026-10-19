# BASELINE_RECONCILIATION.md · EST_MARIPOSA_AUTO_SURFACING_V1 / WP0

- 生成：2026-10-19（preflight 11:59Z，本机 UTC-7，本地 04:59）
- preflight：`RECONCILIATION_REQUIRED`（退出码 3，`repo_writes: 0`），报告 `/tmp/surfacing-preflight.json`
- 结论：**无同文件在途冲突，分包施工不阻塞**；需在两仓 HEAD 新版之上施工，禁止用包内基线哈希覆盖现场。

## 1. 基线时序对账（包为什么报 RECONCILIATION_REQUIRED）

| 事件 | UTC | 本地(UTC-7) |
|---|---|---|
| 包基线观察（est HEAD=e8bed72、mari HEAD=8c8f131） | 11:01Z | 04:01 |
| 包打包（MANIFEST created_at） | 11:28Z | 04:28 |
| 换窗分层+JSON 瘦身批落库 E=d3b24b0 / M=e022196 | 11:49Z | 04:49 |
| 本批 preflight | 11:59Z | 04:59 |

包记录的 est dirty（supervisor.ts、config/schema.ts、records.ts、README、dist、App.tsx、SelectionControls.tsx、chat-client.ts、remediation-batch5.test.ts）正是当时在途的换窗分层批——包警告的"supervisor.ts 新增未提交改动"即此批，**现已随 d3b24b0 提交入库，supervisor.ts 当前工作树干净**（`git diff` 空，最后触碰=d3b24b0）。

## 2. 两仓 HEAD 移动与接缝文件变化

- **estómago** e8bed72 → **d3b24b0**（114/114 绿）。接缝文件被改：`runtime/supervisor.ts`(+21：手动换窗 skipReview/manual_no_review、选集确认即换窗)、`runtime/host-tools.ts`(75 行改动：conversation_read 条目 seq 寻址)、`app-context.ts`(2 行)。→ 本批 WP5 依**当前版** supervisor 符号施工（runTurn/assembleContext/orMessages/onBeforeDispatch/成功轨迹 replace 位置现场重定位），只加薄接口调用，不复制旧整文件。
- **mariposa** 8c8f131 → **e022196**（1240 绿/2 在途批遗留）。接缝文件被改：`recall/service.py`、`recall/paging.py`、`recall/shared.py`（候选卡瘦身：单 `resource_ref`+`content_version`，reject 回执反查补全）。→ WP2 提取候选生成时以**瘦身后的卡形**为准（resource_ref 寻址），不复活 candidate_ref/representation 等已删字段。

## 3. 当前在途（他人在途，归属与承诺）

- **est**：`apps/web/src/home/`（app.css/app.js/scene.html/index.html/latest-interactions.js/两个 svg/preview css）+ `?? tests/unit/home-cords.test.ts` —— 首页场景批，d3b24b0 提交信息明示"未卷入"。**不 stash/不 reset/不卷入我的提交**。
- **mariposa**：`?? scripts/run_browser_checks.py`、`?? tests/e2e/` —— e2e 浏览器检查批在途。同上。
- 与本批接缝（est memory-surfacing 新目录+supervisor 薄接点；M surfacing/ 新目录+recall/retrieval/capabilities）**零重叠**。

## 4. 迁移号现场分配

- est：`db/migrations.ts` 现行 SUPPORTED=**v28** → 本批 surfacing 运行表自 **v29** 起（不硬编码 schema+1，以现场数组尾为准）。
- M：正式库 DDL/migration 在 `schema.py`+`migration.py`；运行库（recall 会话先例在 `recall/store.py`）——WP3 现场核对运行库迁移入口，沿用既有 runtime DB，不建第二正式事实库。

## 5. 施工纪律（对齐 GLM_START_HERE）

- 只暂存本人文件；他人 dirty 永不 `git add -A`。
- supervisor.ts 若施工期间再现在途改动：先读当前版、更新本文件、未协调前该文件标依赖阻塞，独立新模块照常。
- 不启动生产服务、不重启、不动凭据/隧道；测试用 synthetic fixtures+临时库。
