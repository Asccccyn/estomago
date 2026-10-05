# 离线验收证据 · 2026-10-05（HEAD 6fc0032）

本文件是 ACCEPTANCE.json 离线核验的证据汇总。59 项 PASS 的逐项证据指针在 ACCEPTANCE.json 各 case 的 evidence 数组；
截图证据在仓库本地 reports/screenshots/（gitignore 证据区，5 类齐全）。14 项 BLOCKED 的门在 notes 里逐条写明。
规范正文与其余包内文件未改动（SHA256SUMS 仍对它们有效；ACCEPTANCE.json 是活的验收记录，状态更新属其设计用途）。

## 负向/构造性证据的 grep 原始输出

```
# A005 无第二套记忆（grep 证据 @ 6fc0032）
（零命中）

# A074 keeper 未运行
apps/host/src/runtime/host-tools.ts:61:  purpose: 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
apps/host/src/runtime/runner.ts:14:export type RunnerPurpose = 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive'; // §12：keepalive 默认禁用
apps/host/src/db/migrations.ts:474:  purpose TEXT NOT NULL CHECK (purpose IN ('chat','pre_rotate_review','proactive_turn','cache_keepalive')),
apps/host/src/server/records.ts:15:  cache: { requestedTtl: '1h'; lastRead: number | null; lastWrite: number | null; lastNoncached: number | null; lastCostUsd: number | null; observedAt: string | null; estimatedExpiresAt: string | null; keeperEnabled: false };
apps/host/src/server/records.ts:96:      keeperEnabled: false,

# A004 无 plan 自动完成路径
（episode 零调用——opt-in 未接，不会自动闭合任何事）

# A046 凭据不进前端/日志
（web 零命中）
（logging 零命中）
```

## 测试基线
- npm test：44/44 文件 0 失败（2026-10-05，含整改四批 22 个新回归用例）
- 截图实例：临时 ESTOMAGO_HOME + mock 驱动 + 合成种子（零真实凭据，跑完即弃）

## 自审补录（同日）：审计探针回放

把审计包四个定向脚本改为指向当前 HEAD（原脚本 import ./source/ 冻结快照，对其运行无意义）并回放：

| 探针 | 结果 | 判定 |
|---|---|---|
| probe-identity（F01） | 断言失败于 `sent.length===0`（实际 1） | 缺陷不再复现：OR 无 SDK 前提照常出稿 |
| mariposa-probe（F09 首组） | 断言失败于 op 应改变（实际不变） | 缺陷不再复现：冻结批次同 op 字节一致重放 |
| driver-cache-probe（F12 首组） | 断言失败于 `rows.length===1`（实际 2） | 缺陷不再复现：多请求用量分行保留 |
| rotation-repro R1-R5/R7 | 全部 not ok（缺陷断言被打破） | 容量硬门/complete 顺序/手动换窗互斥/范围manifest/书签视野/评审结果保留 均已修复 |
| rotation-repro R6 | ok | **探针测错层**：它直接调后端正向分页（现为合法历史分页）；真缺陷（前端无游标永远拿最早 30 条）由前端 last=1+prevCursor 修复，见 records-api#F21（含 35 条时最新事件可见断言） |

自审另发现并已修正的取证问题：records-zero-hold.png 首拍与 desktop 逐字节相同（scrollIntoView 未产生视觉差异），已用段落级 clip 重拍。
