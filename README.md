# estómago

> 自建聊天宿主：统一聊天入口 + 模型驱动宿主（OpenRouter 主用 / Claude Agent SDK 保留）+ Mariposa 唯一正式记忆。产品显示名 **estómago**；仓库/进程/配置键用 ASCII `estomago`。

## 当前基线（唯一现行规范，2026-10-05 冻结）

**现行规范正文：`docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md`**（规范标识 `ESTOMAGO_OR_SELF_HOLD`：OpenRouter 主接入、原文全存+主模型自主 hold、换窗前一次提醒、一小时 Prompt Cache、前台"记录"面板）。实施状态与逐模块"复用/接线/新增/退役"判定见 `docs/specs/IMPLEMENTATION_MAP.md`；应用验收以 `docs/specs/ESTOMAGO_OR_SELF_HOLD/ACCEPTANCE.json` 逐项为准（未执行=`NOT_EXECUTED`，不拿测试总数冒充）。

版本口径（审计从这里进，不要并行引用多代文档）：

| 文档 | 地位 |
|---|---|
| `docs/specs/ESTOMAGO_OR_SELF_HOLD/` | **现行**：唯一规范正文 + 验收 + WP0 映射 |
| `docs/architecture/v0.2.1/` | **历史存档**（v0.2.1 设计包，只读；其安全/隐私/测试硬约束经 AGENTS.md 继续有效） |
| `reports/` | 运行证据区（gitignore；测试日志、doctor、截图、备份清单） |
| `docs/v0.2.2-remediation-selftest.md` | 历史自检报告（已并入基线状态，不再单独维护） |

## 实施进度（对照 03_施工与交付 的工作包）

| 工作包 | 状态 |
|---|---|
| WP0 现场映射与冻结副作用 | **完成**（`docs/specs/IMPLEMENTATION_MAP.md`） |
| WP1 OR 专用驱动与配置 | **完成（离线）**：OR 配置段+硬规则、换窗预算初值、SSE/payload/用量驱动（fake transport 31 用例；全量 36 文件全绿）。真实外网仅 WP6 |
| WP2 原文同步 / MCP / 正式收据 | 未开始（依赖 Mariposa 接口核对，跨仓库补丁须授权） |
| WP3 启动装配 / 轨迹 / 书签 / 一次提醒 / 自动换窗 | 未开始 |
| WP4 缓存与工具续请求集成 | 未开始 |
| WP5 前台"记录"与设置接线 | 未开始 |
| WP6 真实验收 / 发布候选 | 未开始（真实 OR 调用须她明确预算授权；SDK 实测单列） |

## 快速开始

```bash
npm run doctor      # 只读环境检查 → reports/mac-doctor-*.json
npm test            # 前台、串行、独立临时 ESTOMAGO_HOME（AGENTS.md 测试纪律）
npm start           # 前台启动（127.0.0.1:18787；首次自动复制 example 配置）
# 打开 http://127.0.0.1:18787 ；首次登录粘贴 $STATE_ROOT/config/auth.token 内容
npm stop / npm run status
npm run backup      # SQLite VACUUM INTO 一致性快照 → $STATE/backups/
npm run install-launchagent   # 渲染 LaunchAgent（默认 dry-run，--apply 才写盘）
```

零 npm 运行依赖（Node ≥ 22.18，原生 `.ts` type-stripping + `node:sqlite`）；开发依赖仅 `@anthropic-ai/claude-agent-sdk@0.3.283`（锁定安装，OR 模式不加载）。无凭据/无身份材料时按规格如实 `IDENTITY_BLOCKED`/blocked 降级，消息保存、时间线、SSE、思考通道照常——这是规格要求的形态，不是故障。

## 关键硬规则的代码落点（现行规范 → 现场）

| 规范条款 | 代码落点 |
|---|---|
| 原文全存/幂等提交/修订链/outbox（01 §1.2、§2.2） | `messages/service.ts`（生产者）、`db/migrations.ts`（outbox 表；消费者 WP2） |
| OR 驱动 / 请求控制 / SSE / 重试 / 费用（01 §6、§9） | `runtime/runner-openrouter.ts` + `runtime/or-*.ts`（WP1） |
| 三探针 P1/P2/P3（01 §11.1） | `runtime/supervisor.ts`（P1）、OR 驱动序列化后 fetch 前（P2）、usage/终态帧回填（P3） |
| 换窗状态机 + 原子指针 + 降级保旧窗（01 §4.3） | `windows/manager.ts`（review 接线于 WP3） |
| 一小时缓存布局 A/B/auto/G（01 §7） | `runtime/or-payload.ts`（边界构造；规划接线 WP4） |
| 思考隔离：ReasoningProjection 不可进上下文（01 §10） | `context/assembler.ts`（allowlist builder）、`reasoning/*` |
| 用量口径分列、未知不填零（01 §9.3） | `usage/collector.ts` |
| 停止：先 fence 再 abort、迟到 chunk 丢弃（01 §9.2） | `runtime/supervisor.ts` |
| 输入框：Enter 只换行、独立发送键、IME guard（AGENTS.md 硬规则） | `apps/web/src/composer-logic.js` + 服务端只做 `\n` 规范化 |
| SSE 持久 sequence 回放、慢客户端有界队列 | `events/service.ts`、`server/http.ts` |

## 硬边界（AGENTS.md 摘要）

不碰兄弟项目（mariposa/siren/superposition/Zashidele）；不编造验收；秘密不进日志/Git；测试用隔离临时根、前台分批串行；网络/凭据/跨仓库变更需她逐项批准。完整规章见 `AGENTS.md` 与现行规范正文。
