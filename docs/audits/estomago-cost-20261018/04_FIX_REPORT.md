# 04_FIX_REPORT · 本批代码修改

**总原则执行情况：本批零费用语义修改。** 缓存断点、TTL、工具集、上下文装配、重试、模型/供应商、输出上限、换窗机制全部未动——审计（01-03）未发现可证明的费用缺陷，不为省 token 而改行为。唯一代码变更是计费追踪基础设施（任务书第二阶段"优先级最高"项）。

## 修改 1：provider_requests.context_fingerprint_json（迁移 v28）

- **问题**：每次模型派发的可缓存结构（工具集/A 段/B 段/messages 前缀/断点位置/循环轮次）无内生留证。判定"前缀是否稳定复用、断点是否漂移、哪笔是工具续轮"需逐笔解析 MB 级 payload_wire_json（Codex 审计与本批 02 号文档的回算均如此），无法日常化。
- **证据**：02_CACHE_LAYOUT §2 的 112 笔回算即该手工过程的产物；provider_requests 既有列中无任何 hash/轮次字段。
- **根因**：追踪字段从未内生于派发账本（历史批次按需加列，缓存诊断字段未列）。
- **修改文件**：
  - `apps/host/src/db/migrations.ts`——v28 `ALTER TABLE provider_requests ADD COLUMN context_fingerprint_json TEXT`（向后兼容：旧代码忽略新列）。
  - `apps/host/src/runtime/context-fingerprint.ts`（新增）——`contextFingerprintOf` 纯函数：`round_no / tools_n / tools_hash / system_a_hash / boot_hash / sys_count / msgs_n / msgs_hash / boundaries[{m,c}]`。sha256 截 12 hex，与 02 号文档回算口径一致；构造上只输出 hash/位置/计数（AGENTS §4：正文与 token 不进指纹）。
  - `apps/host/src/runtime/supervisor.ts`——`runOrToolLoop` 每轮 INSERT（首发行+重试行）携带指纹；同轮重试行共用同一指纹。
- **修改前行为**：派发行只有 purpose/attempt_no/载荷全文，轮次与结构指纹靠事后解析推断。
- **修改后行为**：每行自带轮次与结构指纹；相邻行按 (model, session, tools_hash) 分组比对 msgs_hash 与 usage read/write，一条 SQL 判定前缀衔接（正是 Codex 审计 81 组相邻计量分析的自动化形态）。
- **对应测试**：`tests/unit/context-fingerprint.test.ts` 5 项（确定性/分段敏感/B 段缺失=null 不冒充零/脱敏哨兵词/v28 迁移列存在）。
- **预计节省金额**：不适用（观测设施，非费用修复——如实归类，不虚报为优化）。
- **实际验证结果**：离线 5/5 绿 + 相关批次回归（05）；生产验证待部署后新派发自然产生指纹行（无需付费测试——下一次她正常聊天即有数据）。

## 修改 2：无

缓存策略滚动方案 vs 分离方案（任务书 4.2 方案 A/B/C）：**A 保留**。判据——112 笔数据显示每轮 ~1.1k 写入下一笔即全额复用（38,504=37,351+1,153）、101 组相邻 100 组精确衔接，滚动缓存的写入是未来读取的必要投资；取消或移动断点省 $0.011 写入、换来下轮同段按普通输入 $5/M 计费（同量即 ~$0.019 起），净亏。**现有实现就是多轮成本最低方案，不做修改。**

## 明确不做的事（约束遵守记录）

不换模型/供应商；不动 1h TTL 与 64k→600k 换窗软线（01 §5 所载现行值）；不删/缩 Mariposa 注入、身份正文、I、计划；不压聊天原文；不降输出上限/思考档位；不切 5 分钟缓存；不用命中率替代账单。$0.95 整段重建属部署成本（02 §4），保留 37 项工具。
