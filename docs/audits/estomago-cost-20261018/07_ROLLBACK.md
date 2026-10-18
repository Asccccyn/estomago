# 07_ROLLBACK · 回滚方案

## 部署状态

**本批未部署、未重启生产**（任务书第九阶段：等待她批准）。生产 launchd 进程（`online.charstarearth.estomago`）仍运行旧代码；v28 迁移只存在于代码与测试库，**生产库尚未应用**。

## 若已批准部署后需要回滚

1. **代码回滚**：`git revert <本批提交>`（或 checkout bb5e7b1 的下一版本），然后 `launchctl kickstart -k gui/$(id -u)/online.charstarearth.estomago`。旧代码不读写 `context_fingerprint_json`，立即恢复原行为。
2. **schema 无需降库**：v28 是纯加列（`ALTER TABLE … ADD COLUMN`），向后兼容——旧代码忽略该列，新列留存无副作用。**不要**手写 DROP COLUMN 或重建库；迁移链 code_hash 机制（migrations.ts）禁止原地改已落盘迁移，反向降级走备份/restore 流程仅在下策时使用。
3. **数据面**：指纹列只有 INSERT 时写入，无回填、无触发器、无后台任务依赖；回滚不产生孤儿数据。
4. **验证回滚成功**：`npm status`/health 端点正常 + 一次正常聊天产生派发（provider_requests 行无 context_fingerprint_json 值亦可——列还在但旧代码不写）。

## 风险面评估

- 运行中风险：每轮派发新增一次指纹计算（tools+messages 两次 JSON 序列化 + sha256，95k 上下文实测毫秒级），在既有 payload_json 双重序列化（supervisor.ts 原 L384/L400）的基线上可忽略；不进热路径的关键路径（不阻塞流式）。
- 兼容风险：备份/restore 链动态读 SUPPORTED_SCHEMA_VERSION（scripts/restore.mjs），v28 备份可被 v28+ 代码恢复；v27 代码恢复 v28 备份会被既有 BACKUP_INCOMPATIBLE 门正确拒绝（符合设计）。
