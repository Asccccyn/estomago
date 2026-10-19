# UNRESOLVED · EST_MARIPOSA_AUTO_SURFACING_V1

诚实清单：以下事项**未完成/未验证/有已知偏差**，不自称通过。

## 1. SDK 驱动面的 memory_read_full 桥（AC041 部分）
- 现状：est SDK 分支（runner-claude-sdk）的 options.tools 恒空（build-options.ts 类型 `tools: []`）——SDK 会话**本就没有任何宿主工具**（memory_recall 也一样）。本批把工具接进了 OR/DS 信封面（已验证）；SDK 面注入走 prompt 字符串适配（已验证），但 SDK 内工具调用桥未建。
- 需要：扩展 build-options 携带宿主工具+SDK canUseTool 回调接线（供应商接口支持性先核验）。包 spec 允许"供应商接口不支持时明确 capability blocked"——当前如实标注 blocked。

## 2. 真实 judge 语义评测 NOT_EXECUTED（AC009/072）
- 0.98/0.02 是保守工程初值非校准值；上线前需她授权付费评测 + fixtures/semantic_cases.json 人工标注（两层：事件粒度分组、每事件可注入判定）。noul=0.98 不得写成 98% 准确率。

## 3. 生产运维门（AC049/010，见 DEPLOYMENT_HANDOFF）
- 独立 surfacing binding 签发（生产 whitelist 迁移单列）、current_dialogue grant 批准、真实预算配置、M→E 两仓部署顺序、受控新 epoch、付费烟测——全部未执行。**她 2026-10-19 在聊天中：本批未做任何生产动作。**

## 4. 已知实现偏差（保守方向，逐项可改）
1. judge 请求粒度=每候选一请求（≤6 问句合批），未按 judge_batch_size 跨候选合批——请求计数偏多、判断语义不变；台账如实按请求记账。
2. E surfacing_jobs.candidates 表（迁移 v29 已建）本批未启用（赢家存 jobs.items_json+deliveries.selected_refs_json）——表就绪待后续利用。
3. docs/02 的 CAS 要求 state+generation+source_revision+target_revision 四元校验；实现=state 集合 CAS+augmentFor 的 target_revision 硬门+逻辑作业唯一键（含 source_revision/policy/prompt）——等价覆盖主路径，generation 字段未参与（默认 0）。
4. stop（停止键）对本轮 delivery 的主动取消未做专门登记——回合取消后不 retain（attempted_not_retained 由恢复路径收口），付费 validate 若已出站照实计 unknown。
5. prepare 20s 总预算只在计算前检查一次（非分段）；delivery 2000ms 为完整实现（有界等待+check 竞态承受）。
6. M detail 五域关系：路由经 relations/routing.list_relations（五域正反全页），测试只种了 memory_relation 单边——其余四域有边场景未单独造例（路由实现为既有受测面）。
7. 跨仓 E2E 拆在两仓各自套件（传输合同两端分别真实）——单进程跨仓 HTTP 端到端（E 真 client→真 M HTTP）未做（跨语言进程编排，留给联调批）。
8. schema 方言两处 null 适配（occurred_at/inherited_date_span 退出 required 走 anyOf）——见 IMPLEMENTATION_REPORT 裁定 7。

## 5. 既有在途失败（非本批）
- mari `test_audit_20261005_fixes.py`（words 惰性重建）/`test_closure_final_20261001.py`（读流上限）——她在途批遗留，干净 e022196 复验仍在；本批不处理不掩盖。

## 6. 待她裁定/批准项
- judge 请求粒度是否合批优化（偏差 1）
- SDK 工具桥是否立独立批
- 语义评测授权与预算
- 生产部署排期（她聊天中不部署）
