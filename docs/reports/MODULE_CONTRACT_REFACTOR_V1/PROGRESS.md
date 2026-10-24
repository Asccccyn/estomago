# PROGRESS

| 卡/步骤 | 起始SHA | 实际完成的符号与文件 | 验证命令/退出码 | 提交 | 状态/下一步 |
|---|---|---|---|---|---|
| P00 | 849b1d5（来源树，未改） | worktree `refactor/module-contract-v1`@849b1d5；`docs/specs/MODULE_CONTRACT_REFACTOR_V1/`（包文档/合同/脚本）；`docs/reports/MODULE_CONTRACT_REFACTOR_V1/`（BASELINE/PROGRESS/RESUME/BLOCKERS/MIGRATION_MATRIX/TEST_INVENTORY/GLM_DELIVERY/REVIEW_FINDINGS/ACCEPTANCE_RESULTS） | preflight exit 0；`npm ci` 106包；`npm run typecheck` exit 0 | def6db5 | DONE；下一卡 P01 |
| P01.1 | def6db5 | capabilities/contracts.ts 新建（HostToolSpec/SeenRef/ToolExecContext/ToolExecResult/BackgroundToolQuote 原样搬迁）；host-tools/background-tool-cost 纯 type 重导出；supervisor/tool-discovery 消费者改指正本 | typecheck 0；tool-discovery+tool-initial-visible+model-wire-measurement 3/3 通过（ESTOMAGO_HOME 临时隔离） | 53f4092 | DONE |
| P01.2 | 53f4092 | capabilities/validation.ts（validateArgsAgainstSchema+PropSpec）；host-tools.validateToolArgs 缩为 allowlist 解析+委托 | typecheck 0；audit-d-fixes+wishstar-integration+wp7-cross-contract+tool-discovery 4/4 | 见git log | DONE |
| P01.3 | （同上） | tests/golden/tool-catalog-baseline.json（849b1d5 纯净采集，sha256=770e9fef…）；tool-catalog-golden.test.ts；host-tools 48 定义拆 10 域工厂+BASELINE_TOOL_ORDER 装配 | typecheck 0；golden 逐字节一致；tool-discovery+tool-initial-visible+model-wire+tool-discovery-supervisor 通过 | 见git log（golden 与重组各一笔） | DONE |
| P01.4 | 9f183f5 | tool-initial-visible 去反向 import（renderInitialVisibleText(db, specs)）；supervisor 传 buildHostTools()；测试同步 | typecheck 0；tool-initial-visible+tool-discovery-supervisor+golden 3/3 | 073f736 | DONE |
| P01.5 | 073f736 | tests/helpers/module-contract-session.ts（真实装配合成会话）；module-contract-session-snapshot.test.ts；tests/golden/module-contract-session-baseline.json（6 请求 wire+define/invoke 回执+surfacing 绑定+语音投影） | 连续两次运行逐字节一致；P01 全套回归 6/6 文件通过 | 见git log | DONE；下一卡 P02 |

只记可复核事实。不记录私有推理、凭据、聊天正文、完整请求。
