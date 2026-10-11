# CONTRACT_MATRIX · ESTOMAGO_CHAT_EXEC_V1

## 外部能力对照（expected / observed / adapter status）

| 服务 | transport | expected | observed | adapter | 付费 | 写入 | 状态 |
|---|---|---|---|---|---|---|---|
| Mariposa | HTTP | 桶/我们的话/计划/memory.hold/recall/open | client.ts 实调 `/api/capability/{capability}`（已验证 hold/recall/episode） | `integrations/mariposa/client.ts` | 否 | 是 | **available**（base_url 已配置） |
| Mariposa 附件 | HTTP | `assets` 每项格式/参与 hash/回执 | est 类型 `string[]` 始终空数组——**当前 M 合同只收空** | archive-sync | 否 | 是 | **contract_unverified**（文字归档照常/媒体 blocked 如实披露） |
| Siren | HTTP | 转写输入/返回/合成/保存/流式通话 | 适配器框架已建 | `integrations/siren/adapter.ts` | 否 | 否 | **contract_unverified**（不冒充） |
| Superposition | HTTP | 星星/special_dates/邀请/拆星 | 注册表已登记 | `integrations/tools/registry.ts` | 否 | 否 | **contract_unverified**（日历读取纯 DB 不触发） |
| 扎西德勒 | MCP | MCP 工具面 | MCP client 薄层已建 | `integrations/tools/mcp-client.ts` | 否 | 是 | **contract_unverified** |
| oído | MCP | 频谱/听觉业务 | 注册表已登记 | registry | 否 | 否 | **not_configured**（仓库无其代码） |
| Antinomy | HTTP | 阅读/共度 | 注册表已登记 | registry | 否 | 否 | **not_configured** |
| X/小红书 | — | 复用用户已有架构 | 注册表已预留 | registry | 否 | 否 | **not_configured** |
| OpenRouter | HTTP | Chat Completions（1h 缓存+禁压缩） | 独立 fetch 不经 SDK；wire_v1 证据留存 | `runtime/runner-openrouter.ts` | 是 | 否 | **available**（模型配置后可用） |
| Claude Agent SDK | 进程内 | 多模态+MCP（锁定 0.3.283） | SDK 路径保留；背景执行标 SDK_BACKGROUND_POLICY_UNVERIFIED 阻断 | `runtime/runner-claude-sdk.ts` | 是 | 否 | **partial**（聊天可用/背景阻断） |
| 生图 | — | 外部生图服务 | GENERATION_PROVIDER_UNCONFIGURED | 未配置 | 是 | 否 | **not_configured** |
| 手机推送 | — | APNs/FCM | 未接 | 未配置 | 否 | 否 | **not_configured** |

## MCP client 完成度

| 项 | 状态 |
|---|---|
| stdio JSON-RPC 真实传输 | ✅ 已实现 |
| initialize → notifications/initialized | ✅ |
| tools/list → 缓存已注册工具 | ✅ |
| tools/call → 结果/错误/超时/取消 | ✅ |
| 结果转换（图片→媒体/文字→模型） | ✅ |
| 不因远端增工具自动扩权 | ✅ |
| HTTP/SSE 传输 | ❌ 待真实服务合同 |
| 受控 MCP fixture 端到端测试 | ❌ WP8 联合审计批 |
