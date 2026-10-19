# CONTRACT_MATRIX · EST_MARIPOSA_AUTO_SURFACING_V1

## 新增 M capabilities（既有 `/api/capability/{name}` HTTP 面；registry+V2_INPUT_SCHEMAS 单正本）

| capability | 输入 schema | write | judge 费用 | 幂等 | 调用方 |
|---|---|---|---|---|---|
| memory.surfacing.prepare | prepare-input.schema.json（仓内方言翻译） | True | 可能（独立台账 surface_judge_ledger） | surface 运行库 surface_operations | 专用 surfacing service binding |
| memory.surfacing.validate | validate-input.schema.json | True | 可能（delivery 阶段） | 同上 | 同上 |
| memory.surfacing.check | check-input.schema.json | False | 无 | as-of 回执（本地） | 同上 |
| memory.detail.read | detail-read-input.schema.json | False | 无 | 读天然可重复 | 模型侧授权 binding+已见 ref 门 |

- 运行时隔离：`_SURFACE_RUNTIME_CAPS` 并入 `_is_recall_runtime` 判定——不进正式能力幂等缓存；候选/对话投影不落正式库。
- 契约导出：`contracts/capabilities.v1.json` 重生成（122 能力，含四新面）。
- 错误闭集：`models.ERROR_CODES` 26 码（SURFACE_*/DETAIL_*），Forbidden(code=…) 结构化透出；不整串发主模型（E 侧空交付）。

## 新增 E 模型工具

| 工具 | 定义 | 注册 | SDK 面 |
|---|---|---|---|
| memory_read_full(memory_ref, cursor?) | model-tool.json 契约（description 逐字） | buildHostTools+executeInner allowlist+方法；窗冻结工具集（U1 起即在，不等首次浮现） | **未接**（build-options tools 恒空——UNRESOLVED #1） |

## 数据合同

- **M 运行库迁移 16**：surface_operations（幂等）/surface_runs（快照）/surface_validation_receipts（回执）/surface_detail_snapshots（分页）/surface_judge_ledger（费用台账）。
- **E 迁移 v29**：surfacing_jobs（状态机 21 态+逻辑唯一键）/surfacing_candidates/surfacing_deliveries（attempt 级冻结）/surfacing_coverage（窗口投影）。
- 判断内部决策结构：judge-decision.schema.json 对应 `surfacing/models.JudgeDecision`（结构化 provider 目标形状；TypeSafe 归一后同一形状）。
- 冻结说明：`prompts/primary_memory_notice.txt` 60 字节 sha256=b56cadf7…，E `contracts.PRIMARY_MEMORY_NOTICE` + `verifyNoticeBytes()` 字节锁定（AC016 测试）。

## 外部许可

- judge_policy.allowed_data 新增 **current_dialogue**（fail-closed 缺失即 SURFACE_OUTBOUND_NOT_GRANTED）；候选全文= event_excerpt、日期/分类= structured_metadata。
- E 专用凭据 `integrations.mariposa.surfacing_credential_ref`（独立 env 名；不回退聊天/归档凭据）；binding capabilities_allowlist 只放行四新面。

## 既有面不变（回归证明）

memory_recall / memory_recall_next / memory_open / memory_correct / conversation_read / RECALL_DELIVERY_LIMIT=3 / judge-off 分页 / 换窗 / 选集 / 媒体 / hold——两仓全量回归绿（见 TEST_EVIDENCE）。
