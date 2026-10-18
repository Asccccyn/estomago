# 05_TEST_EVIDENCE · 测试证据

测试纪律（AGENTS §2）：`node --test` 前台分批、测试自建独立临时 ESTOMAGO_HOME（mkdtemp）、零网络零真实外部服务、假 transport。本批无付费 API 调用。

## 分批结果（2026-10-18，本机 node v22.23.3）

| 批 | 文件 | 结果 |
|---|---|---|
| 指纹新测试 | context-fingerprint | 5/5 ✅ |
| 迁移链回归 | exec-v1-wp0-base、wp05-dead-tables、wp04-consumption-ops（含 upTo 历史库构造） | 20/20 ✅ |
| supervisor 派发账本 | or-supervisor、or-rotation、exec-v1-wp2-supervisor | 11/11 ✅ |
| OR 契约/缓存/归一 | or-protocol、or-cache、usage-normalization、runner-openrouter | 32/32 ✅ |
| 后台/时间/配置 | exec-v1-wp4-background、exec-v1-wp4-executor、time-usage-segments、or-config | 23/23 ✅ |
| **合计** | | **91/91 ✅** |

覆盖点对照（任务书 7.1 静态测试要求）：
- Bedrock 路由不再移除合法缓存标记 → runner-openrouter/or-protocol（既有，未动）
- 1h TTL 保留 → or-protocol（`oneHour()` 唯一形态，未动）
- 断点数量约束 → or-cache planBoundaries ≤3 + 尾点 ≤4（未动）
- Tools 序列化稳定 → context-fingerprint 确定性 + tools_hash 分段敏感（新增）
- 同一静态资料生成相同前缀 → context-fingerprint 同输入同 hash（新增）
- 工具 API 契约未变 → 本批未触碰 host-tools.ts；quote-seen-scope/hold-quote 在 6e48036 批已绿
- 迁移可升级 → v28 fresh 应用 + upTo 历史库回归（新增+既有）

## 生产数据复核（只读，零写入）

- 112 行 provider_requests 全量指纹回算：0 解析错误，总费用与 Codex 报告逐分吻合（$6.8649655）。
- 审计截止后无新派发（usage_observations 最新 = 20:22:27 UTC 样本）。
- 回算脚本一次性运行于 /tmp，未进仓库、未写生产库；证据文件 `evidence-fingerprint.json` 仅含 hash/计数/ID/usage。

## 未执行项（如实）

- 付费生产验证（任务书 7.3 测试 A/B）：**未执行**——本批无费用行为修改，无可验证的前后对照；且任务书要求先报成本获批。若她批准部署 v28，下次正常聊天自然产生指纹行，零额外成本完成实测。
- `npm test` 全量套件：本批跑的是与本批改动面相关的 91 项（上表）；全量回归在部署前门执行（生产重启前的例行门）。
