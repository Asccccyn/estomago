# BASELINE

来源路径：`/Users/owner/Projects/devspace-workspace/worktrees/estomago-integration-20261024`（分支 `integration-voice-keepwarm-20261024`）
来源SHA：`849b1d51da7ff4c245c30d4786bcf1edaaa3d121`（与包内观察基线 `849b1d5` 完全一致，`exact_observed_baseline`）
来源dirty：仅两项已知未提交前端构建产物 `apps/web/dist/chat-app.js`、`apps/web/dist/index.html`（preflight `knownDistOnly=true`）。未发现其他生产源码 WIP。两项产物原地保留：未删除、未 stash、未卷入本专项提交。
隔离工作树：`/Users/owner/Projects/devspace-workspace/worktrees/estomago-module-contract-v1`，分支 `refactor/module-contract-v1`，从 `849b1d5` 提交创建；工作树干净，未携带源树 dist 改动。最终发布候选将重新构建自己的 dist，明确为新候选构建，不吸收源树产物。
Node/依赖：`/opt/homebrew/bin/node` v22.23.3（02 号文档给出的同一可执行文件，未升级全局工具）；npm 10.9.9；`npm ci` 按现有 package-lock 安装 106 包，未升级版本、未改 lock。
原有有效测试与基线失败：测试集合尚未分类（TEST_INVENTORY.json 初稿为空，分类在 P01/P02 按测试政策 07 执行）。基线 `npm run typecheck` exit 0，无基线类型失败。测试选择器：`node scripts/run-tests.mjs --file=tests/unit/<文件>.test.ts`（runner 自带 test-guard 与独立临时 ESTOMAGO_HOME）。
是否触及生产：否。未运行产品测试（productTestsRun=false），未读取生产聊天/凭据/数据库，未调用真实模型或付费服务，未改动源树、生产配置、LaunchAgent。
基线推进差异：无。开工时 HEAD 与包内观察基线完全一致，无需“基线推进清单”。
preflight 证据：`scripts/preflight.py --repo <来源>` exit 0，输出 `BASELINE_OBSERVED_NOT_PRODUCT_VALIDATED`，无 blockers，锚点文件全部存在。
