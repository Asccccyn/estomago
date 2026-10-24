# GLM_DELIVERY（实现摘要 · 冻结候选 cd85fc75975ad6d115adfeb19f5c89be8ee840b6）

> 提交区间说明：757fb58 为报告生成时点（P00-P07/P09 全部生产变更已在其前入库：最后一个生产提交=2305617 supervisor 类型叶化）；757fb58→本提交仅含交付文档与测试夹具/引用适配（JA-E07 桩后重接线、recall-projection 导入改指 memory 投影正本、exec-v1-wp5 接线），无生产代码差异。

## 实现摘要
- 能力执行唯一路径：48 静态业务工具全部经 capabilities/registry（显式登记/重复名拒绝/baselineOrder 枚举）→ capabilities/executor（取消→通话 memory_only 门（条目元数据）→冻结 schema 校验→背景准入→handler→唯一投影）。旧分支/allowlist 名单/外层投影/全局 tool_call_id 桥已删除；未接线时保持原 TOOL_NOT_IN_ALLOWLIST 拒绝语义。
- 域模块（10 个）：modules/oido（6+生命周期）、voice（transcript_read/call_control）、memory（14+词表+hold 契约+投影正本）、conversation（3+投影）、wishstar（13）、content（4）、wake（2）、media（2）、identity（1）、context-review（1）。定义/handler/投影/费用/通话资格/label 五件事随 owner；model-results.ts 收缩为通用失败映射+memory/conversation 投影正本随域。
- 消息生命周期：messages/lifecycle.ts 通用事实（accepted 带 firstAcceptance/revised/published）+inTransaction/afterCommit；application/message-lifecycle 装配浮现消费者；context/contributions.ts 两类贡献叶合同（supervisor 不 import 浮现业务类型）。
- 跨模块组合：Siren 建呼抽 SirenAdapter.createCallFromInternalEnv；ProgramFactsPort 窄端口；oído 删除重试=模块生命周期（Host 启停点）；后台执行=application/background-execution。
- 等价基线：tests/golden/tool-catalog-baseline.json（849b1d5 纯净采集，sha256 770e9fef…）+ module-contract-session-baseline.json（真实装配合成会话 wire 逐字）——41 文件定向回归全绿。

## 测试结论（OFFLINE_CONTRACT；未调用真实 Opus/OR/JEV/ASR/TTS/embedding/Mariposa/oído/Siren）
冻结候选 41 文件定向回归 41/41 通过（run-tests --file 明确选择器；每文件独立临时 ESTOMAGO_HOME）。分域净见 PROGRESS 表。A01-A02、A04-A09、A11、A13-A24 共 23 项=PASS；A03/A25/A26/A27/A28/A29 状态见 ACCEPTANCE_RESULTS.json。

## 旧路径退役
executeInner 唯一路径=registry（P04 收尾提交）；wishstar 前缀通配删除（逐项显式登记）；oido 旧六分支/授权助手删除；MEMORY_ONLY_TOOLS 静态清单保留至 P09 兼容窗口（isMemoryOnlyAllowed 已优先条目元数据）；SurfacingMessageHooks 兼容层与 legacyCompatView 登记于 MIGRATION_MATRIX 待 P09 删。

## 无生产操作声明
未部署生产、未改生产配置/数据库/LaunchAgent/凭据/隧道；未读取生产聊天；源树（integration-20261024 与主 checkout）只读，两项未提交 dist 产物未清理未卷入。

## 如何复核
GLM5.3 与 Astra 按 review/01、review/02 各自独立复核同一冻结提交 cd85fc75975ad6d115adfeb19f5c89be8ee840b6：先读 docs/reports/MODULE_CONTRACT_REFACTOR_V1/（BASELINE/MIGRATION_MATRIX/ACCEPTANCE_RESULTS/TEST_INVENTORY/BLOCKERS），再按 TEST_EVIDENCE 命令复跑，重点核对 08 号五问与 06 号红线（双 golden 逐字）。
