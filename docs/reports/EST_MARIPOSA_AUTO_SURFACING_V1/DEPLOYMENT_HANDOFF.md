# DEPLOYMENT_HANDOFF · EST_MARIPOSA_AUTO_SURFACING_V1

**当前状态：两仓代码+测试完成，默认 `enabled=false`，零生产动作。**
她 2026-10-19 正在聊天：本批未重启、未部署、未碰运行中服务与缓存前缀。

## 发布顺序（全部需她逐项批准后执行）

1. **备份/迁移演练**：est 工作树备份；mari 运行库迁移 16 与 est v29 迁移在临时副本演练（本批测试已在临时根演练过，生产根照例再演一次）。
2. **M 先行**：mariposa 更新（surfacing 模块+迁移 16；SURFACE_ENABLED 默认关=行为零变化，确认 judge-off 分页等回归）。
3. **独立 binding 签发（运维脚本仅 dry-run 已含）**：为 est 签发 surfacing 专用受限 token——principal 映射 jiaming，capabilities_allowlist 仅四新面；`integrations.mariposa.surfacing_credential_ref` 指向其 env 名。
4. **外发许可**：judge_policy.allowed_data 增加 `current_dialogue`（连同既有 event_excerpt/structured_metadata）——这是**新许可**，需她明确批准（批准 event_excerpt ≠ 批准对话外发）。
5. **预算**：`MARIPOSA_SURFACE_DAILY_JUDGE_COST_CAP_USD` 与 `MARIPOSA_SURFACE_DAILY_JUDGE_REQUEST_CAP` 显式配置（null=有付费出站即 blocked——不配置不会偷偷花钱）。
6. **E 更新**：estómago 更新重启（照例先查活跃回合/running attempts——她在聊天时**不重启**）；config `memory_surfacing.enabled` 保持 false 先上线代码。
7. **受控新 epoch**：memory_read_full 工具随新窗冻结工具集进入（既有窗工具快照不变，不中途插 schema——supervisor 窗冻结机制天然满足；确认新窗首信封含新工具）。
8. **最小真实烟测（独立预算）**：她授权后单次真实 prepare/validate（小输入）验证 typesafe transport 真凭据链+台账记账；观察 SURFACE_UNKNOWN_OUTCOME 路径。
9. **开 flag**：确认以上全绿后 `memory_surfacing.enabled=true`（est config）+ `MARIPOSA_SURFACE_ENABLED=1`（mari env）。

## 回滚

- **首选关 flag**：est `memory_surfacing.enabled=false` 即刻停新作业/新注入（E 侧服务全 no-op；M 侧 SURFACE_ENABLED=false 全 blocked）——不删已保存原文、不重写旧轨迹、surfacing 运行表保留（additive 迁移无 DROP）。
- 停 worker：服务 stop 即停（无外部监听进程）。
- 正式代码回滚：不覆盖部署后新增他人提交（AGENTS 并行规矩）。
- 缓存注意：已发出的 memory_surfacing 块留在旧轨迹原位（append-only）；关 flag 后不再新增，供应商缓存前缀不受影响。

## 观察面（上线后）

- `surface_judge_ledger`（请求/费用/unknown）；`surfacing_jobs.state`（blocked reason）；est 日志 `surface_job_failed`（只含 ID/code）。
- 她的聊天体验回归点：换窗/选集/发图/语音/停止键照旧（本批回归绿）。
