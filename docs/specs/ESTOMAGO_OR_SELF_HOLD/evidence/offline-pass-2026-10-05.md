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
