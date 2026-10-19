# IMPLEMENTATION_REPORT · EST_MARIPOSA_AUTO_SURFACING_V1

- 执行：程知行（GLM/ZCode），2026-10-19
- 基线：见 BASELINE_RECONCILIATION.md（est e8bed72→d3b24b0、mari 8c8f131→e022196 之上施工）
- 状态：**后端能力全部落地，离线/契约/跨面测试绿；默认 enabled=false 未部署**（生产部署/真实付费烟测=运维门，见 DEPLOYMENT_HANDOFF.md）

## WP 完成清单

| WP | 内容 | 状态 |
|---|---|---|
| WP0 | preflight（退出码 3）+ BASELINE_RECONCILIATION.md + 迁移号现场分配（E v29 / M 运行库 16） | ✅ |
| WP1 | E contracts/repository/projection（notice 60 字节 sha256 锁定）；M surfacing/models/store；schema 单正本四新条目 | ✅ |
| WP2 | 候选生成提取 `retrieval/candidate_service.py`（recall 反向 import 同名绑定，打补丁性保留；等价回归绿）；surface judge 两阶段（TypeSafe 有限问句真构造+归一；结构化 provider 如实 SURFACE_PROFILE_UNSUPPORTED）；严格选择（complete-link 合并确认、一事件 0/1、无次优补位、uncertain 竞争压制） | ✅ |
| WP3 | M 四 capability（prepare/validate/check/detail.read）注册+V2_INPUT_SCHEMAS+运行库幂等隔离（_SURFACE_RUNTIME_CAPS）；门：flag/judge 开关/profile/外发许可（current_dialogue 新许可）/预算（cost cap null=blocked）；判断台账独立分账；契约导出重生成（122 能力） | ✅ |
| WP4 | MessageService 事务内登记+提交后唤醒；SurfacingService（每房间串行/全局并发上限/有界恢复/missed_target 不后漂）；编辑撤销；AppContext 装配+生命周期 | ✅ |
| WP5 | supervisor 薄接点（effective 之后/冻结之前）：OR/DS 独立 host-origin text block 于 user_input 前；SDK 字符串适配；尝试级冻结+复用；成功轨迹 retain→coverage；工具续轮不重注入 | ✅ |
| WP6 | M memory/detail.py 全量快照（八段/五域关系/绑定原文全文/码点分页/STALE-UNSTABLE）；E memory_read_full 工具（buildHostTools+冻结进窗工具集+已见 ref 门） | ✅（SDK 桥除外，见 UNRESOLVED） |
| WP7 | 两仓全量回归 + acceptance 逐条执行（64 PASS/8 NOT_EXECUTED，见 ACCEPTANCE_EXECUTION.json） | ✅ |
| WP8 | 本报告五件套 + README 两仓入口 + 部署门手册 | ✅ |

## 真实变更文件

**mariposa（新增 6 / 修改 6）**
- 新增：`backend/mariposa/surfacing/{__init__,models,store,candidates,judge,selection,service}.py`（7 文件）、`backend/mariposa/retrieval/candidate_service.py`、`backend/mariposa/memory/detail.py`
- 修改：`recall/service.py`（三函数改为 import 回接）、`config.py`（SURFACE_* 段）、`schema.py`（运行库迁移 16）、`capabilities/registry.py`（四能力+handlers+运行时隔离集）、`capabilities/input_schemas.py`（四 schema）、`tests/conftest.py`（surface 表清理链）、`contracts/capabilities.v1.json`（导出重生成）
- 新测试：`tests/unit/test_surface_store.py`、`test_surface_selection_judge.py`、`test_surface_capability.py`、`test_memory_detail.py`；`tests/integration/test_surface_http.py`

**estómago（新增 6 / 修改 7）**
- 新增：`apps/host/src/memory-surfacing/{contracts,repository,trigger,service,detail-tool}.ts`
- 修改：`db/migrations.ts`（v29 四运行表）、`config/schema.ts`（memory_surfacing 段四处同步）、`messages/service.ts`（接受/编辑挂点+提交后唤醒）、`app-context.ts`（装配+生命周期）、`runtime/supervisor.ts`（薄接点三处）、`runtime/host-tools.ts`（工具注册/allowlist/分发/方法）、`integrations/mariposa/client.ts`（四方法）、`server/http.ts`（RequestDeps）
- 新测试：`tests/unit/surfacing-core.test.ts`、`tests/unit/surfacing-seam.test.ts`；`tests/unit/context-fingerprint.test.ts` 断言推进 29

## 关键实现裁定（依包 docs）

1. 候选生成提取为行为等价搬移（verbatim）+ service 同名 import 回接——主动 recall 黄金用例（commit-at-end/judge_policy_switch/recall_session/fusion 等）全绿证明等价。
2. TypeSafe 适配器复用 typesafe_jev 实例的 `_post_with_limited_retry` 通道（同凭据/超时/429·529 有限重试边界；timeout 不自动重发=付费未知不重试），surface 许可（event_excerpt/structured_metadata/**current_dialogue**）由本模块自查，不下传 provider 的 PROFILE_FIELDS 门。
3. judge 缓存复用 jev_feature_cache 基础设施但 feature_name=`surface_{phase}`+问题/语境/指纹进键——与普通 relevance 缓存天然隔离（J12 同款 namespace 语义）。
4. 字节门：judge 单请求（模板+原话+候选全文+JSON 封装）>max_judge_request_bytes → 该候选 uncertain（不截正文）；事件正文>max_event_body_bytes → 该事件 skipped（不摘要/不换次优）。
5. E 侧冻结注入块持久化 `surfacing_deliveries`（attempt 级 UNIQUE(attempt_id,payload_hash)）；transport retry/attempt 重跑复用同一冻结包；成功轨迹 replace 后才 markRetained→coverage（真实 manifest 确认，非入库 ready）。
6. 覆盖=窗口投影（conversation+window+memory+body_hash），换窗不拦新窗；未用永久 seen。
7. 方言适配两处（如实披露）：occurred_at / inherited_date_span 允许 null，仓内 V2_INPUT_SCHEMAS 的 required 不容 null——退出 required、anyOf 校验，服务端缺失按 null 处理。
