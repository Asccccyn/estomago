# ready 503 根因修复

基线：`d2cefb1`，主仓工作树干净。用户明确要求查根因、能修直接修，并承接本会话 push／部署授权。

## 根因

1. 生产使用 OpenRouter，health.ts 却对所有驱动调用 SDK CapabilityMatrix.overall。该矩阵的 settings_sources、SDK thinking 等探针没有给 OR 初始化，故永远 unknown；并非已观察到 OpenRouter 失败。
2. archive.enabled=true 时，health.ts 无条件报告“Mariposa 未接入/base_url=null”。现场只有状态计数核验：1097 条归档 outbox 全部 acked、1097 条正式 source_sync_receipts；5 个历史 dead batch 对应的当前 outbox 已处理。旧 health 根本没有读取归档处理器或这些真实状态。
3. ReadyReport 和 HTTP 各自计算 readiness，HTTP 要求所有分项必须 ok，连主动关闭的可选 push=disabled 也算失败。
4. SDK 矩阵另有短路问题：较早的 unknown 会掩盖较晚的 blocked。已一并修正优先级，但没有填造 supported 证据。

## 修复

- OR/DS 使用已经过型号与凭据验证的真实 runnerSelection，并再次检查凭据引用是否仍可用；SDK/mock 保留 SDK 证据门，不跨驱动冒充验证。
- ArchiveSyncService.health 读取自身配置和 MariposaClient 的配置可用性，检查当前非 acked outbox；unknown_outcome、failed 或带 last_error 的待处理项明确 degraded。普通待处理队列可以正常接收工作；历史已解决批次不永久污染状态。缺配置／缺 worker 都 blocked。
- 唯一 readiness 判定在 buildReadyReport；ok 和有意 disabled 可以就绪，unknown/blocked/degraded 仍失败。HTTP 直接使用报告状态，关闭项另列 disabled，公开响应仍不泄露路径、凭据或细节。
- 数据库 schema 查询纳入异常处理；数据库不可用明确 degraded。

这里的 ready 表示宿主可接收请求及当前本地归档工作状态，不承诺供应商此刻一定返回成功。查询本身没有模型调用、远端探测、归档重放、凭据修改或写库。不会通过给所有分项硬填 ok 来消除 503。

## 验证

新增 health-readiness.test.ts，覆盖 OR/DS 的 SDK 隔离、撤销凭据、SDK unknown/blocked 优先级、身份失败、缺 worker、数据库失败、启用但未核实的 push、归档未知／失败／恢复和真实 HTTP 200/503/脱敏。重复 health 请求断言模型、归档 transport 调用均为零。

`npm run typecheck` 通过；独立临时 ESTOMAGO_HOME 下串行 `npm test` 全量 **138/138 文件、940/940 测试通过，0 失败、0 跳过**。生产部署结果将在发布核验后追加。
