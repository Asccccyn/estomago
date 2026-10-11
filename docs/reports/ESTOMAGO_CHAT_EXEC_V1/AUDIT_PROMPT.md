# ESTOMAGO_CHAT_EXEC_V1 审计指令

## 审计范围

仓库：~/Projects/estomago（main 分支）
基线：4971ebc（改动前）
HEAD：f99ab69（当前）
差异：28 笔提交，85 文件，+20198/-99 行

规范正本：`docs/specs/ESTOMAGO_CHAT_EXEC_V1/`（01-09 章 + contracts/*.json + 07_WORK_PACKAGES.md）
验收执行副本：`docs/specs/ESTOMAGO_CHAT_EXEC_V1/ACCEPTANCE_EXECUTION.json`（114 条逐条 status/commit/observed）
前代规范：`docs/specs/ESTOMAGO_OR_SELF_HOLD/`（已加横幅——未替代条款继续有效）
交付报告：`docs/reports/ESTOMAGO_CHAT_EXEC_V1/`（FINAL_REPORT / TEST_EVIDENCE / CONTRACT_MATRIX / DEPLOYMENT_NOTES）

## 审计前必读

1. 读 `docs/specs/ESTOMAGO_CHAT_EXEC_V1/README.md`（包结构与冻结口径）
2. 读 `docs/specs/ESTOMAGO_CHAT_EXEC_V1/01_REQUIREMENTS_AND_BOUNDARIES.md`（产品边界与数据所有权）
3. 读 `docs/specs/ESTOMAGO_CHAT_EXEC_V1/07_WORK_PACKAGES.md`（施工顺序与各批出口）
4. 读 `AGENTS.md`（硬约束：不造假/测试隔离/只改本仓/隐私/输入语义/并行交叉检查/基线维护）
5. 重新运行 `npm run typecheck && npm test`（应 94/94 通过）

## 审计维度（六项逐一给出 P1/P2/P3 定级）

### A. 语义一致性（代码实现 vs 规范合同）

逐条核对以下高语义密度点，给出 PASS/MISMATCH/PARTIAL：

| # | 规范条款 | 代码落点 | 你要验证什么 |
|---|---|---|---|
| A01 | 缓存计时基准=有非零读写证据请求的 dispatch_started_at（05 §5.1） | `runtime/cache-observation.ts` lastCacheEvidence | 是否只取 usage 有 cache_read>0 或 cache_write>0 的行？200 无证据/字段缺失/失败是否都不刷新？ |
| A02 | 温缓存未命中五条件门（05 §2.2） | `observability/system-alerts.ts` evaluateCacheMiss | 冷启动/新窗/换模型/字段缺失/部分命中是否都不触发？全齐备 read=0 才触发？ |
| A03 | 每次含重试的 transport 前准入（02 §4.2） | `runner-openrouter.ts` onBeforeDispatch | 429/网络失败/首字节前重试是否都逐次入账？sent_at 是否只在 2xx 后写？ |
| A04 | 保温单请求+工具执行门拒+不推进轨迹（04 §5.3） | `supervisor.ts` runBackgroundTurn | 维护尾是否进轨迹？工具是否被拒绝？是否只有 1 次模型请求？ |
| A05 | 自主 noop 是成功结果（04 §6.2） | `host-tools.ts` backgroundComplete + scheduler | noop 状态是否正常结束？不强制产出？终答不自动发布？ |
| A06 | 费用上限 null=未配置不是无限（04 §4.2） | `background-settings.ts` applyUpdate | null 时是否 422 拒绝开启？不当作 0 或无限？ |
| A07 | 图片不以 URL 冒充看图（03 §6.1） | `media/model-input.ts` materializeBlocks | payload 是否有 base64 图像块？URL 文字是否被当视觉输入？ |
| A08 | 视觉门 MODEL_VISION_UNAVAILABLE（03 §6.1） | `supervisor.ts` media gate | 未核实视觉是否零模型请求？消息保存？不静默换模型？ |
| A09 | 作者只从宿主派生（06 §3.1） | `integrations/content/client.ts` + content/service.ts | body 是否有可赋权作者字段？X-Actor 是否双人集合？非本人编辑是否 403？ |
| A10 | 删帖保留他人评论（06 §4.3） | content/service.ts DELETE posts | 是否级联删评论？已删帖子是否拒绝新评论？墓碑是否不返回正文？ |
| A11 | 北京时间半开区间（06 §7.3） | `calendar-routes.ts` shanghaiDayRange | 是否 [00:00, 次日00:00)？非 23:59:59？跨日排除？ |
| A12 | 日历零触发（06 §7.3/8） | calendar-routes.ts 全部 | 是否有任何外部请求（memory_open/view.confirm/拆星/取下一颗）？ |
| A13 | 旧 content_hash 不变（03 §4.2） | messages/service.ts | 附件是否混入旧 hash？message_fingerprint 是否独立列？ |
| A14 | compact 显式识别（02 §3） | sdk-event-normalizer.ts | compact_boundary 是否被识别？supervisor 是否出 CONTEXT_COMPACTION_UNEXPECTED？ |
| A15 | URL 导入安全边界（03 §7） | media/assets.ts importFromUrl | https-only/拒内网/拒凭据 URL/DNS 锁定/逐跳重查/HTML 拒绝？ |
| A16 | policy-defaults 42 键接线完整性 | config/schema.ts + policy-constants.ts | 28 可调键全在 schema？9 常量全在 policy-constants？4 映射键不复制定义？ |

### B. 无头代码（写了但没人调用）

逐一检查以下新文件中的每个导出函数/类/常量，确认有真实调用方：

| 文件 | 你要检查什么 |
|---|---|
| observability/system-alerts.ts | ALERT_CODES 每个条目是否有 observe 调用点？evaluateCacheMiss 有调用方？ |
| usage/attribution.ts | providerInputTotal/shanghaiDayOf/findSettlementBreaches/sweepUsageMissing/fieldTotalOf 各有调用方？ |
| usage/estimator.ts | estimateTokens/snapshotFor/visibleTextRoughTokens/refreshVisionSupport/setVisionSupportForTests 各有调用方？ |
| runtime/cache-observation.ts | lastCacheEvidence/keepwarmTargetAtMs/estimatedCacheExpiryAtMs/observeCacheUsage 各有调用方？ |
| runtime/background-policy.ts | 每个导出纯函数（autonomousCooldownDueAtMs/keepwarmAdmission/autonomousAdmission/budgetGate/canTransition/restartDisposition/budgetDayOfMs/clockRegressionAction/effectiveSettings）有调用方？ |
| runtime/background-settings.ts | applyUpdate/effective/revision 各有调用方？ |
| runtime/background-scheduler.ts | 每个公开方法（start/stop/tick/notePendingUserChat/recoverOnStart/stopRun/recordDispatchStart/settleDispatch/lastAutonomousDispatchAt）有调用方？ |
| media/assets.ts | MediaService 每个公开方法有调用方？isPublicIp/sniffMime 除测试外有生产调用方？ |
| media/model-input.ts | materializeEnvelope/redactImageBlocksForStorage/projectRevisionBlocks 各有调用方？ |
| integrations/content/client.ts | contentClientFor/contentForward/contentProxyWithAssets 各有调用方？ |
| integrations/tools/mcp-client.ts | McpClient/convertMcpResult 有生产调用方（不只是测试）？如果只有测试——标记为"预留但未接线" |
| integrations/tools/registry.ts | integrationRegistry 有生产调用方？ |
| integrations/siren/adapter.ts | SirenAdapter 有生产调用方？ |
| server/calendar-routes.ts | buildCalendarMonth/buildCalendarDayItems/shanghaiDayRange/monthDays 各有调用方？ |
| content/src/service.ts | ContentServer 每个路由分支可达？withReceipt/ifMatch/limitOf/decodeCursor 各有调用方？ |

**输出格式**：列出每个无头函数/类/常量的文件:行号:名称，标注"仅测试引用"或"完全无引用"。

### C. 过长代码与复杂度

检查以下文件是否超过可审阅阈值（建议单函数 ≤80 行、单文件 ≤500 行、嵌套 ≤4 层）：

| 文件 | 当前行数 | 你要检查什么 |
|---|---|---|
| apps/host/src/server/http.ts | ~900+ | 是否应该拆出领域 route 文件？哪个函数最长？ |
| apps/host/src/runtime/supervisor.ts | ~2000+ | runBackgroundTurn/runOrToolLoop/runTurn 各多长？是否有重复逻辑可提？ |
| apps/host/src/runtime/host-tools.ts | ~700+ | 每个工具实现函数是否重复模板可抽象？ |
| apps/content/src/service.ts | ~555 | dispatch() 是否过长？是否应该拆为多个 handler？ |
| apps/host/src/runtime/background-scheduler.ts | ~269 | 各方法长度？executeClaimed 是否过长？ |
| apps/host/src/media/assets.ts | ~320 | importFromUrl 是否过长？guardTarget/fetchGuardated 是否应独立文件？ |

**输出格式**：每个超阈值函数给 file:line-function:行数:建议。

### D. 深耦合与解耦

检查以下耦合点是否需要解耦：

| 耦合对 | 你要检查什么 |
|---|---|
| supervisor.ts ↔ background-scheduler.ts | supervisor 是否直接 import scheduler？还是经接口注入？ |
| http.ts ↔ 所有服务 | http.ts 是否直接操作 DB（除了简单查询）？还是都经服务层？ |
| messages/service.ts ↔ media/assets.ts | MessageService 是否直接依赖 MediaService？还是经 http.ts 桥接？ |
| content/service.ts ↔ est | content 是否 import 任何 est 模块？（应该零依赖） |
| runner-openrouter.ts ↔ media/model-input.ts | runner 是否知道媒体投影？（应该不知道——由 supervisor 物化后传入） |
| background-policy.ts ↔ 任何 IO | 纯函数文件是否真的零 IO（无 fetch/sqlite/fs）？ |

**输出格式**：每个不合理的直接依赖给 file:line → 被依赖文件，说明是否应该用接口/事件/回调解耦。

### E. 过渡过程（迁移兼容性）

| 迁移 | 你要检查什么 |
|---|---|
| v21 system_alerts 三表 | fresh install 是否创建？v20 升级是否 additive？旧数据是否不受影响？ |
| v22 usage 归属列 | ALTER TABLE 加列是否 nullable？旧行 budget_day 是否回填并标 legacy？ |
| v23 revision token_estimate | 旧消息该列是否 NULL？是否影响 content_hash/修订号？ |
| v24 provider dispatch 列 | 旧行 payload_format 是否 NULL（=envelope_legacy）？dispatch_started_at 旧行是否 NULL？ |
| v25 media 三表 + fingerprint | 旧消息 message_fingerprint 是否 NULL？message_attachments 是否空表？ |
| v26 background 三表 | 全新表——不影响旧数据？ |

**验证**：用 `sqlite3` 直接检查生产库 `~/Library/Application Support/estomago/data/chat.sqlite3` 的 schema_migrations 和各新表行数。

### F. 循环依赖

在 `apps/host/src/` 和 `apps/content/src/` 下运行：

```bash
# 方法一：madge
npx madge --circular --extensions ts apps/host/src/ 2>/dev/null

# 方法二：手工追踪
# 检查以下高风险环：
# supervisor → background-scheduler → supervisor
# http → media → messages → http
# usage/collector → observability/system-alerts → events → usage/collector
# cache-observation → observability/system-alerts → events → supervisor → cache-observation
```

**输出**：列出每个发现的环（如果有的话），说明是编译时依赖还是运行时回调（运行时回调不算环）。

## 验收矩阵完整性检查

对照 `docs/specs/ESTOMAGO_CHAT_EXEC_V1/ACCEPTANCE_EXECUTION.json`：
1. 82 条 PASS——抽查 10 条：读 observed 描述 → 找到对应测试文件 → 重跑 → 确认测试真的测了 observed 描述的行为（不是仅断言枚举存在）
2. 32 条 NOT_EXECUTED——检查 blocked_dependency 是否具体（不是笼统"待做"）
3. 0 条 FAIL——确认没有把 FAIL 改成 PASS 的情况

## 前代规范兼容检查

读 `docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md` 头部横幅——确认被替代条款清单准确：
1. 哪些旧条款被替代了？替代后是否在代码中确实移除了旧实现？
2. 哪些旧条款保留？保留的是否被本轮改动意外破坏？（用既有测试全量跑验证）

## 禁止事项

1. **不造假**：能力未核实一律 unknown/blocked，不写自填 PASS
2. **不遗漏**：每个维度必须给出结论（即使是"未发现问题"）
3. **不改代码**：审计只读——发现问题记录，不修
4. **不猜**：如果某个行为需要运行才能确认，标注"需运行验证"并列出验证命令
5. **不冒充**：审计报告不用"看起来没问题"——引用具体代码行号或测试命令输出

## 输出格式

```markdown
# ESTOMAGO_CHAT_EXEC_V1 审计报告

## 总结
- P1（必须修）：N 项
- P2（应修）：N 项
- P3（建议）：N 项
- 验收覆盖：X/114 真实 PASS（vs 声明的 82）

## A. 语义一致性
### A01 缓存计时基准
- 规范：...
- 实现：...（file:line）
- 结论：PASS/MISMATCH/PARTIAL
- 证据：...

（逐条到 A16）

## B. 无头代码
- 完全无引用：...
- 仅测试引用：...
- 预留但未接线：...

## C. 过长代码
| 文件 | 函数 | 行数 | 建议 |
|---|---|---|---|

## D. 深耦合
| 依赖方向 | 问题 | 建议 |
|---|---|---|

## E. 迁移兼容
| 迁移 | fresh | upgrade | 兼容 |
|---|---|---|---|

## F. 循环依赖
- 发现的环：...
- 说明：...

## 验收抽查
| ID | 声明 | 重跑结果 | 一致 |
|---|---|---|---|

## 前代规范兼容
- 被替代条款落地：...
- 保留条款完整性：...
```
