# SOL_RECALL_REPAIR_REGRESSION｜03 包 R3.1 回归报告

日期：2026-11-17。分层口径按 05_ACCEPTANCE：离线合同/回放 ≠ 本地真实 Qwen ≠ 真实 Sol/JEV ≠ 生产。
默认零付费：真实 Sol/JEV/主模型调用全部 `NOT_EXECUTED`。

## 1. 离线合同与业务验证（pytest / node --test）

### M（`~/Data/mariposa/venv-album-p2a/bin/python -m pytest -q`，前台、指定文件）

| 批 | 命令范围 | 结果 |
| --- | --- | --- |
| 合同/能力 | test_surface_capability, test_surface_contract_v2, test_surface_tiered_retrieval, test_surface_tiered_coverage | 58 pass, 2 skip |
| 行为 | test_surface_v5_purpose, test_surface_selection_judge, test_surface_same_turn_audit, test_surface_source_lifecycle, test_recall_source_boundary_20261101, test_surface_r5_delivery_view_20261103 | 79 pass |
| R3.1 新增 | test_surface_r31_need_and_lock（schema 跨字段 5 例 / locked 赢家 2 例 / JEV state 与缓存身份 2 例） | 9 pass |
| Qwen/检索 | test_qwen_provider, test_closure_wp05_words, test_closure_wp03, test_product_align_20261005, test_surface_source_lifecycle, test_closure_reaudit2_fixes, test_v17_reaudit_fixes, test_v17_mood_ruling | 107+15 pass |
| recall 面 | words_recall, surface_semantic_projection, recall_query_plan, v2_recall, audit×3, recall_judge/session/fusion, g1/refine/v17 | 117 pass |

失败处理记录：迁移过程中出现并已修复——版本断言（purpose-v2-r31/v6_r31）、`not_words_need` 措辞、wp03 缺 import、qwen np 初始化、测试 body_hash 非 hex。最终全部批次绿。

### E（`node --test`，独立临时 ESTOMAGO_HOME）

| 文件 | 结果 |
| --- | --- |
| surfacing-sol-decision（含新 schema/跨字段校验/evidence 查询级 time_hint） | 14 pass |
| surfacing-sdk-first-projection | 2 pass |
| surfacing-core / events / seam / source-boundary-window | 27 pass |
| recall-projection / wp2-recall-next | 9 pass |
| joint-audit-surfacing | 19 pass |
| surfacing-r31-window-coverage（新增：textSeenInWindow / coveredDigest / already_in_window 白名单） | 3 pass |

typecheck（tsc --noEmit）：两轮均 0 错误。

## 2. 关键验收项对照（05 Lxx / SCENARIOS 摘要）

| ID | 层级 | 状态 | 证据 |
| --- | --- | --- | --- |
| L01/L02 一次 Sol/三态 | 离线 | PASS（原有，回归确认） | surfacing-core 19 例 |
| L03 plan 字段贯穿 E→M→JEV→缓存 | 离线 | PASS | r31_need_and_lock（needs 进 state、need/covered 变化改缓存身份）+ sol-decision 14 例 |
| L04 related/single 歧义门 | 离线 | PASS（原有+r31 锁定） | selection 2 新例 + v5_purpose |
| L05/L07 R01–R04 用途/停止/补缺 | 离线 | PASS | r31 locked 2 例；event 路由不触发 raw（v5_purpose 既有例，断言更新） |
| L14/L16/N17/N18 主动短回执/固定分页 | 离线 | PASS（工程层） | markCoveredCandidates 单元+白名单例；recall_next 游标链未改（wp2-recall-next 5 例） |
| N04 主动先交→auto 不重发 | 离线 | PASS | textSeenInWindow 例 + augmentFor 接线 |
| D01/D02/D03 启动就绪/单实例/真实向量 | 本地 Qwen | PASS | qwen_embed warmup 真实消费合成文本、非空/有限/2560 维；RLock；status 只读 |
| D06 换代隔离 | 本地 | PASS | test_model_identity_switch_invalidates_vectors |
| D07 语义区分 | 本地真实 Qwen | PASS | 同义改写 0.7599 / 无关 0.2175、0.2105（阈值 0.35）——一次命中不外推全量质量 |
| M01–M03 迁移幂等/分母 | 本地隔离副本 | PASS（有界 24 项实测+全量见 DEPLOYMENT_STATUS 附录） | 分母 650 事件/481 words；同 hash 跳过 |
| M06 增量接线 | 离线 | PASS | after_write 在 hold/update_text 提交后触发（qwen_provider 全链例经 hold 后即可召回） |
| N11–N13 BGE 退役 | 离线+资源 | PASS（代码/依赖/仓内权重） | 生产侧残留见 RETIREMENT |
| L11 SDK/API 首出站/retain | 离线 | PASS（原有，未改） | sdk-first-projection 2 例 |
| 真实 Sol/JEV 语义（S01–S23、N01–N03/N05–N09 语义效果） | — | NOT_EXECUTED | 零付费默认；未调用 gpt-6.1-sol 与 typesafe_jev 真端点 |
| N14 同快照前后语义对照 | — | NOT_EXECUTED（依赖真实判定） | 工程路径已具备（幂等迁移+冻结字段） |
| N21/N22 滚窗/重启对账 | 离线部分 | PASS（既有换窗重建+无 TTL 清除行为保留；新增摘要/去重同源） | source-boundary-window 2 例 |
| N23/N25 并发/幂等分离 | 离线 | PASS（原有 CAS/冻结链保留；冻结重放不经新去重路径——按实现，重放走 frozenForAttempt） | surfacing-core |
| N19 精确范围/修订对账 | — | PARTIAL | 正文逐字级；字符区间级与修订增量未做 |
| N20 显式重读 | — | NOT_APPLICABLE→第 4 包 | 现行合同无法表达；read_full 保持深读入口可达 |

## 3. 出站捕获证据（模板/请求形态）

- Sol 请求构造：surfacing-sol-decision「缓存请求形态」例——12h explicit、唯一断点、稳定 cache key（模板变化经 templateFingerprint 进 key，旧前缀缓存自然失配）。
- JEV 出站：r31_need_and_lock 断言 state.needs/already_in_context 实际出现在 transport payload（PurposeTransport 捕获）。
- 两处均未连接真实供应商（TEST_MODE/替身）。

## 4. 数据隔离与脱敏

所有测试使用临时 MARIPOSA_ROOT / ESTOMAGO_HOME；迁移验证只读挂载生产副本（`cp` 至 /tmp）；D07 用合成句子，无私人正文落任何外发路径。生产库/生产 env 零改动。
