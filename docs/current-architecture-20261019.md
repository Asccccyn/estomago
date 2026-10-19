# 2026-10-19 联合审计：当前入口与历史能力勘误

本文件记录独立审计分支的整改状态；未发布、未重启服务。历史规格和审计原文保留，用途是追溯，不表示当前验收通过。

## 正式入口

- `scripts/start.mjs` → `apps/host/src/main.ts` → `Host.create`：配置、数据库、消息/事件/窗口服务、驱动、工具执行器、后台调度器和 HTTP server 的唯一组合根。
- 默认会话 ID 正本为 `apps/host/src/messages/constants.ts`。HTTP 与 Host 都依赖这个叶模块，HTTP 不再导入 Host 组合根。
- 事件正本为 `EventService.persistInTx` 写入的 `runtime_stream_events`；提交后 `dispatchRow`，重连用 `replayPage`。`StreamEventRow` 为实际运行时事件类型。Reasoning 展示使用 `packages/contracts/src/reasoning.ts` 的 `ReasoningBlockDto`。
- Mariposa 使用 `integrations/mariposa/client.ts` 的 HTTP 能力入口；Siren、Wishstar 使用各自专用适配器。OR/DS 工具循环由 `HostToolExecutor` 与 `TurnSupervisor` 实际装配。

## 已删除的无消费者实现

1. `integrations/tools/mcp-client.ts` 与 `registry.ts`：`0cf3a76` 新建后没有被 Host、HTTP、工具执行器、后台任务、脚本或测试调用。静态六服务表既未决定权限，也未注册工具。MCP 客户端还把 `notifications/initialized` 当需响应请求，并将 Base64 误标为资产 ID。删除这两份无头实现，避免将文件存在当成能力完成。
2. `packages/contracts/src/envelope.ts`：`c30a531` 已删除旧 `recordEnvelope` 写路径和 events 表，但遗留的构造器、类型、SSE 名称表仍在。删除全部残留及 `newDedupeKey` 未用 helper。历史数据库迁移不改。
3. reasoning 契约中的 `ReasoningEnvelope` 草案与校验器：没有消费者，事件名称与实际 `reasoning.delta`/`reasoning.block` 生产路径不同。删除无效第二契约；实际 DTO、状态枚举和事件流继续保留。

没有运行行为需要的配置键或测试依赖上述死模块，因此未新增兼容 adapter 或配置 fallback。

## 能力缺口

通用外部 MCP 客户端与 SDK 宿主工具桥仍为 **BLOCKED / 未接线**。`docs/reports/ESTOMAGO_CHAT_EXEC_V1/CONTRACT_MATRIX.md` 中 MCP 完成度勾选项是历史施工自述，不能作为当前端到端证据。删除无头实现并不完成相应规格。

后续实现必须选择已锁定 MCP 实现，完成受控 fixture 握手、通知无响应语义、按工具授权、取消、未知写结果恢复、资源落 MediaService，以及真正的 Host/驱动接点。需要独立方案和离线验收；不能只删 SDK 的阻断门，也不能调用真实 Opus 验证。

## 当前仍需整改

`supervisor.ts`、`host-tools.ts`、`server/http.ts` 的业务职责仍过大。此批只消除已证实的死实现及初始化循环，不宣称全部复杂度已解决。ContextAssembler 的策略门有实际调用，继续保留；无调用方不等于可以移除安全边界。
