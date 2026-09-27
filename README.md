# estómago

自建聊天宿主：统一聊天入口 + Claude Agent SDK 运行宿主。产品显示名 **estómago**；仓库/进程/配置键用 ASCII `estomago`。

- 架构规格：`docs/architecture/v0.2.1/`（v0.2.1 设计包原件，含 166 项验收矩阵 `03_*.json`）
- 目标机器：user的 Mac mini。源码 `~/Projects/estomago/`；运行区 `~/Library/Application Support/estomago/`；日志 `~/Library/Logs/estomago/`

## 当前状态（如实声明，2026-09-26）

**这是按 v0.2.1 架构实现的可运行骨架（Phase B 底座），不是已验收产品。**

| 范围 | 状态 |
|---|---|
| 仓库结构 / 配置层 / DB schema / 消息幂等修订 / SSE / 时间感知 / 身份 gate / 思考流核对 / 路由票据 / 窗口状态机 / 用量口径 / 输入硬规则 | **代码已实现**，本项目 11 个测试文件 54 个用例全绿（`npm test`，合成夹具，mock runner） |
| 真实 Claude Agent SDK 调用 | **未安装、未实测**（`@anthropic-ai/claude-agent-sdk` 未装包；能力矩阵全项 `unknown`；装配代码已写好但未对锁定版本核对） |
| 身份正本 / I | **未加载**（无批准材料 → `IDENTITY_BLOCKED`；没有默认人格顶替） |
| 166 项产品验收（03 矩阵） | **全部 NOT_EXECUTED**（mock 全绿 ≠ 实机通过；doctor 报告只是环境证据） |
| Mariposa / Siren / 许愿星 / 扎西德勒 接入 | 未接（配置项全 null，如实 blocked/disabled） |
| 公网 / 推送 / Telegram | 不在本版范围（disabled） |

## 快速开始

```bash
npm run doctor      # 只读环境检查 → reports/mac-doctor-*.json
npm test            # 54 用例（前台、串行、独立临时 ESTOMAGO_HOME）
npm start           # 前台启动（127.0.0.1:18787；首次自动复制 example 配置）
# 打开 http://127.0.0.1:18787 ；首次登录粘贴 $STATE_ROOT/config/auth.token 内容
npm stop / npm run status
npm run backup      # SQLite VACUUM INTO 一致性快照 → $STATE/backups/
npm run install-launchagent   # 渲染 LaunchAgent（默认 dry-run，--apply 才写盘）
```

零 npm 依赖：Node ≥ 22.18（原生跑 `.ts` type-stripping + `node:sqlite`，实验性告警如实保留）。不装 SDK 也能启动：身份/运行时会如实 `IDENTITY_BLOCKED`，消息保存、时间线、SSE、思考通道结构照常工作——这是规格要求的降级形态，不是故障。

## 与规格的对应（v0.2.1 关键硬规则的落点）

| 规格条款 | 代码落点 |
|---|---|
| 输入框：Enter 只换行、独立发送键、IME guard、多行=一条消息、无组合键捷径（01 §11.1 / 02 §6.2） | `apps/web/src/composer-logic.js`（规则单一事实源）+ `tests/unit/composer-logic.test.ts` + 服务端 `messages/service.ts` 只做 `\n` 规范化、绝不 trim/拆分 |
| 幂等提交 / 修订链 / 发布边界 / outbox（01 §4） | `messages/service.ts`、`server/http.ts`（`Idempotency-Key`/`client_message_id`） |
| 每轮刷新 Time Context、两个"多久"不混用（01 §8） | `time/context.ts` + `runtime/supervisor.ts`（处理前构建、注入 prompt 且标明非用户发言） |
| 身份 Manifest / Bootstrap Receipt 四层证据 / gate（01 §6、05 §3） | `identity/service.ts`；unknown 不填 false；无批准材料即 `IDENTITY_BLOCKED` |
| SDK 装配：`settingSources:[]`、`tools:[]`、strictMcp、关自动记忆/连接器、adaptive+summarized、`switchModelsOnFlag:false`（01 §6.2、05 §2） | `runtime/build-options.ts`（配置→options/settings/env 三层，缺前提即 blocked） |
| 思考摘要：增量接收矩阵、signature 吞掉、完整块核对不重复追加、冲突 snapshot、redacted/no_block 如实、不入原文/TTS/交接（05 §4-§9） | `runtime/sdk-event-normalizer.ts`、`reasoning/*`、表 `reasoning_blocks`/`runtime_stream_events` |
| 路由：票据原子一次消费、重启仍 pending、待决冻结生成（01 §10） | `routing/service.ts`、`route_decisions` 表、supervisor gate |
| 换窗状态机 + 原子指针 + 降级保旧窗（01 §7） | `windows/manager.ts` |
| 停止：先 fence 再 abort、迟到 chunk 丢弃、已发布保留（01 §5.3） | `runtime/supervisor.ts` |
| 用量三口径分开、未知不填零（01 §9） | `usage/collector.ts` |
| 能力矩阵 unknown/supported/unsupported + evidence_ref（02 §5） | `runtime/capabilities.ts` |
| SSE 持久 sequence 回放、慢客户端有界队列（05 §5.3、01 §17） | `events/service.ts`、`server/http.ts` |
| 测试隔离 / 只停本项目 / 一致性备份（02 §7、18） | `scripts/run-tests.mjs`、`scripts/stop.mjs`、`scripts/backup.mjs` |

## 已知偏差 / 待办（不掩饰）

- **SDK Runner 未实机验证**：`runtime/runner-claude-sdk.ts` 按公开文档形状编写，装包锁版本后须先过能力矩阵取证（05 §10 顺序）。
- **Runner 未做成子进程**（01 §2.1 建议）：v0 同进程内运行，重启边界暂与 HTTP 服务一体；后续按规格拆 Supervisor/Runner。
- **分句器 v0 为段落模式**（空行分界 + 上限强切）；表情/语音/贴纸、唤醒调度、日历、MCP server、signals、jobs、模块注册表为骨架占位（表已建、逻辑未写）。
- **Mariposa 交接包**：`windows/manager.ts` 只写元信息交接文件，正式开窗包待契约接入。
- 归档 outbox 产生 pending 记录后无分发循环（archive.enabled=false 时标 disabled 的逻辑在路由层未接线）。

## 硬边界（继承 02 执行规章）

不碰兄弟项目（mariposa/siren/superposition/Zashidele）；不编造验收；秘密不进日志/Git；网络/凭据变更需用户逐项批准。详见 `AGENTS.md`。
