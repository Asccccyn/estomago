# ESTOMAGO-NEXT-REMEDIATION-REPORT
## Core Remediation + Context Boundary Preparation v0.3

> 性质：施工方自测报告 = **READY_FOR_THIRD_PARTY_REAUDIT**，不是 PASS/DONE/PRODUCT_READY。

## 1. 基线
- start commit：`3555a96bc13013f6b59236012a87dc40f2d9b465`（v0.2.2 冻结）
- branch：`fix/core-remediation-next`
- final commit：本报告提交后的 HEAD（见 git log）
- SDK：`@anthropic-ai/claude-agent-sdk@0.3.283`（lockfile）
- Node：v22.23.3
- git status：clean（提交后）

## 2. 修改表（按 Batch）

| Batch | finding | 文件 | 内容 | regression | 结果 |
|---|---|---|---|---|---|
| A | AUD-02/BOOT-03/WIN-11 | identity/service.ts | I_hash/rules_hash 必填、effective MCP 观测、版本三角+cwd+probes 全匹配才 READY（fail-closed） | identity-gate×6 + aud-02×6 | PASS |
| A | §7（身份失效） | windows/manager.ts、supervisor.ts | contextFingerprint（identity/I/rules/SDK/settings/tools/MCP）存窗；变化→CONTEXT_STALE+CONTEXT_ROTATION_REQUIRED，不 resume 旧 session | v03-regressions §7 | PASS |
| A | AUD-05/36/37 | routing/service.ts、supervisor.ts | waiting_route_gate vs route_owner_pending 拆分；决议单事务（验证→consume→edit/attempt→释放 waiting→durable route.resolved） | route-gate-tx×4 + mock-turn | PASS |
| A | AUD-23 | routing/service.ts | 票据绑定 conversation/turn/attempt/message/revision/input_hash/version/expiry；跨 turn/消息/修订拒绝 | route-gate-tx | PASS |
| A | AUD-15/37（§9） | supervisor.ts、app-context.ts | recoverSchedule：DB 为真源，启动重派 committed-but-not-dispatched；claim 条件更新防双执行 | startup 恢复经 Host.start 实接线 | PASS |
| A | AUD-10/38（§10） | supervisor.ts recoveryPass | 孤儿 running/streaming/PREPARING 窗/无票据 waiting/孤儿 owner 全部落确定终态 | aud-10-25 | PASS |
| A | AUD-10（§11） | supervisor.ts stop | 不合作 runner：abort→grace(5s)→强制 interrupted 终态（active 清除；旧 generation 由 fence 丢弃） | uncooperative-runner（集成于 aud-10 系列） | PASS |
| B | AUD-11/12（§12） | sdk-event-normalizer.ts | messageId→状态机（通道级当前消息，parent/child 独立）；候选≠1 → AMBIGUOUS-unmatched，绝不取最小 index | aud-11 两用例（歧义+唯一候选） | PASS |
| B | AUD-13（§13） | reasoning/service.ts | 恰好==MAX 后任意字符必标 truncated+发 status 事件；增量/完整块统一限额；事件只记实际持久文本 | v03 §13 exact-limit + aud-13 | PASS |
| B | AUD-14（§14） | reasoning/service.ts | start/append/complete/snapshot/redacted/omitted/truncated/failed/interrupted 全部投影+事件同事务（startBlock 补齐） | aud-14 + v03 | PASS |
| B | AUD-39/THINK-13（§15） | reasoning/service.ts | 空 thinking → visibility=omitted（没有可读摘要≠没有思考） | v03 §15 | PASS |
| B | AUD-24（§16） | supervisor.ts | 完整 text 与流式正文统一核对（published 跟踪+前缀补尾；冲突不覆盖已发布气泡；no_open_block 的完整 text 安全发布） | v03 §16 | PASS |
| C | AUD-35（§17） | server/http.ts | toSseDto 唯一序列化函数；replay 与 live 共用（字段级同构） | sse-replay 等价断言 | PASS |
| C | AUD-29（§18） | server/http.ts | write false→await drain（超时断开）；累计字节上限断开；finish 硬关闭+唤醒挂起协程 | aud-29 组件级（drain 超时+字节上限双场景） | PASS |
| C | AUD-17（§19） | web/composer-logic.js、app.js | DraftRevisionGuard 共享（普通发送与 route edit 同一冻结/比较规则） | composer-logic + E2E 场景3 | PASS |
| D | AUD-16（§21） | scripts/restore.mjs、backup.mjs | manifest sha256 校验；父链 symlink realpath 防绕过；VACUUM INTO 快照（WAL 已提交数据保留） | aud-16 ops | PASS |
| D | AUD-18（§20） | usage/collector.ts | request 维度幂等键（+completeness）；cumulative 不入 totals；attempt 分列+总量求和、未知维度 null | time-usage-segments + aud | PASS |
| D | AUD-22（§22） | windows/manager.ts、server/http.ts | rotate 前真实装配 options→hash→candidate receipt（HTTP 路径 options_hash 非空） | windows + aud-22 | PASS |
| D | AUD-38（§23） | windows/manager.ts | candidate prepare 失败（receipt/handoff）→终态 BLOCKED；启动 recovery 清孤儿 PREPARING | aud-10-25 recovery | PASS |
| D | AUD-27（§25） | output/segments.ts | 行感知围栏状态机（```/~~~、长度/语言、代码字符串内 fence 不闭合）；行级硬上限围栏补全成对；Unicode 安全 | segmenter 自检 ×6 场景 | PASS |
| D | AUD-28（§26） | app-context.ts | request_unhandled 只记 code+method+pathname（不落 req.url/query） | privacy 测试 | PASS |
| D | AUD-31（§27） | scripts/test-guard.mjs | 凭据名模式矩阵（含中段通配）+ 显式 allowlist；只报名不报值 | v03 §27 矩阵×10 | PASS |
| D | AUD-32（§28） | scripts/stop.mjs、instance-lock.ts | 归属真源=lock 元数据（nonce/pid/startTime/stateRoot realpath）；失效→STALE_OR_INVALID_LOCK 拒发信号 | v03 §28 | PASS |
| D | AUD-40（§29） | schema/build-options/runner | effort 枚举（low..max）非法拒绝→buildOptions→options.effort 全贯通；与 display/UI 展开三独立 | v03 §29（端到端捕获 SDK options） | PASS |
| E | §1-§3 | context/{types,policy,assembler,evidence}.ts | ModelContextSource 封闭枚举（无 reasoning）；ReasoningProjection 类型级不可转换；allowlist builder；策略未批→CONTEXT_POLICY_NOT_APPROVED（无默认值）；supervisor prompt 经 assembler 构造 | canary §2 contract | PASS |
| E | §33 | context-canary.test.ts | REASONING_CANARY：store 命中>0；assembler/handoff/bootstrap/receipt/outbox/time-context/tool-facts 全 0 | canary A/B/C | PASS |
| E | §30 | context/policy.ts | ContextPolicy schema+CONTEXT_POLICY_VERSION=null（AWAITING_POLICY，不伪造 v1） | contract | PASS |

## 3. 未修改项（如实）
- **Context Policy：待char v1**（policy_version=null；recent_dialogue/memory_recall/handoff/预算数值全部 AWAITING_POLICY）
- **Mariposa 未联调**（归档 DTO contract 层已备）；Siren 未联调
- **真实 SDK acceptance 未执行**（无授权凭据；涉 Claude 行为须用户二次确认——已入长期记忆）

## 4. Reasoning 隔离（canary 扫描结果）
- Reasoning store: **FOUND**（canary 命中 >0）
- Model context（assembler 输出 + 下轮 assembled prompt）: **NOT FOUND**
- Handoff: **NOT FOUND**
- Bootstrap: **NOT FOUND**
- Identity receipt: **NOT FOUND**
- Archive DTO（outbox payload）: **NOT FOUND**
- Time context / tool facts / our_words projection: **NOT FOUND**
- 声明边界：仅证明**应用层**隔离；不宣称 SDK provider-managed resume 内部不保留 thinking（需真实授权黑盒测试）

## 5. Context Policy 状态
`policy_version = null / AWAITING_POLICY`（不得自行标完成）

## 6. Tests
- 历史（v0.2.2 基线）：22 文件 / 100 用例
- 当前：**24 文件 / 111 用例，0 FAIL**（node scripts/run-tests.mjs）
- 新增 regression：canary×3 + v03-regressions×7 + 既有 aud-* 套件随修复更新
- browser E2E：v0.2.2 五场景记录在案（本轮前端改动：草稿守卫共享+路由修订端点已由 API 级测试覆盖；浏览器复验待第三方或下轮安排）
- fault injection：runner throw/事件写失败/handoff 写失败/无效备份/慢客户端/非法路由请求/进程重启恢复——全部确定性断言
- ops：restore 四分支 / --config / 实例锁双实例+释放后再启
- canary：见 §4

## 7. 工作区
`git status --short` = clean（见提交后输出）

## 8. 完成判定
自测通过 = **READY_FOR_THIRD_PARTY_REAUDIT**。第三方只审本分支新冻结 commit；Context Policy 条目保持 BLOCKED / AWAITING_POLICY 直到char v1 提交。
