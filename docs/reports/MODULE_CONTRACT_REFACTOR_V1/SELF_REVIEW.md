# SELF_REVIEW（实施者自审 · 应实施者留言要求；非独立复核——D35 不变）

自审时点：冻结候选 f5ebb30 之后、审计验收前。范围：对照 01 裁定/04 §A-J/06 红线/08 不合格交付清单，复查本实施者全部提交。

## 一、自审中发现并已当场修复

| # | 问题 | 修复 |
|---|---|---|
| S1 | `rawToolCallIdRef`/`rawToolCallIdOf` 全局桥成为死代码：P04 收尾删除最后一个消费者后，过渡期恢复的声明未随之删除 | 已删（零消费者确认后）；typecheck 0、边界 cycles=0/violations=1（不变）、7 文件定向回归通过 |
| S2 | GLM_DELIVERY 曾把提交区间误写为"生产代码在 3203d59 后未再变"——不准确（P05/P06/P09 生产变更在其后） | 更正为：报告生成时点 757fb58 前已含全部生产变更（最后生产提交=2305617），其后仅文档+夹具适配 |
| S3 | GLM_DELIVERY/TEST_EVIDENCE 的"冻结候选 SHA"是报告生成时点值，落后于最终 HEAD | 已对齐最终 SHA 并附逐提交区间说明，审计引用无歧义 |
| S4 | `tests/unit/recall-projection.test.ts` 导入已迁走的 `projectCandidatesForModel`（最终回归 40/41 的真实原因，非偶发） | 导入改指 modules/memory/projection.ts（owner 正本） |

## 二、重点核对项（结论：无问题，附证据）

| # | 核对点 | 结论 |
|---|---|---|
| S5 | **executeDiscovery 背景准入记账**（保温批 catalog/define 的 quoteBackgroundTool+recordDispatch）——P04 删除旧路径尾段时是否误伤 | 完好：host-tools.ts 两处 `this.admitBackgroundTool`（catalog/define 分支）保留；D21 红线未破 |
| S6 | **同一定义唯一来源**：模块正本 ↔ host-tools 域工厂委托 ↔ 冻结目录 | tool-catalog-golden sha256 770e9fef… 恒定（P02-P04 全部定义搬迁后）；definitionId 逐项等于基线 |
| S7 | **通话 memory_only 双源一致**：静态清单 vs 条目元数据 | plans_write/deletion_review 已按静态清单正本改为 false（自审前修）；isMemoryOnlyAllowed 优先条目、未迁名回退静态；b2 全绿 |
| S8 | **消息生命周期闭环**：bindMessageLifecycle→MessageService 归一→notifyAfterEditCommit 兼容视图→SurfacingService.afterCommit | 链路逐跳核对正确；dup 重放不发 activity.noteRealPublication（"不当新真实活动"未动）；route/retry edit 同源 |
| S9 | **projectMemoryToolResult fallback**：memory_hold/read_full 无分支 → `return value` 透传 | 与旧 modelResult 对这两工具的行为逐字一致 |
| S10 | **报告诚实性**：ACCEPTANCE_RESULTS 中 A03/A25/A26/A27/A28/A29 保持 NOT_EXECUTED；BLOCKERS 登记三项未做（P07.1/2 逐域提取、P08 两项演练） | 无虚报；todo 面板全绿仅指"卡已处置"，与验收状态分开 |
| S11 | **反模式**：无 legacyFallback；wishstar 前缀通配已删（13 项逐项显式登记）；同名能力无双注册 | grep 确认；check_boundaries cycles=0、violations=1（bootstrap-pages 过渡，BLOCKERS 已登记） |

## 三、遗留事项与措辞瑕疵（不阻断；留复核者裁定或 P09 收口）

| # | 事项 | 性质 |
|---|---|---|
| S12 | P09 提交信息措辞不精确："runOrToolLoop 零 d.tools.execute 直调残留"——实际 runOrToolLoop 经 `d.tools!.execute`（HostToolExecutor.execute→registry 路由）是**预期的通用入口**；应表述为"无绕过 registry 的业务分支直调" | 文档性瑕疵（提交信息，不可改写历史；在此更正） |
| S13 | context/contributions.ts 兼作重导出枢纽（supportsSurfacingTransport/Augment 类型经叶转发）——叶纯度略降，为 P05.6 消除 supervisor 业务导入的过渡形态 | 过渡形态，登记于 BLOCKERS 同域 |
| S14 | HostToolExecutor.`oido` 字段已无消费者（全部 oído handler 已迁 modules/oido），字段保留仅为构造形状兼容 | 死字段，P09 兼容窗口清单 |
| S15 | `validateToolArgs`（allowlist 解析+委托）生产调用点已无，仅测试面消费 | 过渡 API，P09 复评 |
| S16 | `wireOidoCapabilitiesForTest` 部分已提交调用点携带多余 opts 键（db/media/messages——运行期被忽略，依赖从实例反射读取）；行为正确，键可清洁 | 测试整洁度建议 |
| S17 | BLOCKERS 中"逐域 HTTP 提取/P08 演练"若复核者裁定补做，均不依赖本轮任何生产改动，可独立批次执行 | 范围裁定项 |
| S18 | `d.bootstrap ?? d.tools?.mariposaClient()` 过渡回退：生产装配已显式绑定 d.bootstrap；回退仅服务未迁移的测试夹具 | 过渡形态，P07 收口时移除 |

## 四、实施者声明

以上为实施者自审记录，不构成 D35 意义上的独立复核；GLM5.3 与 Astra 对同一冻结提交（生产终版 2305617 + 文档/夹具至 f5ebb30）的独立结论仍需各自形成。S1-S4 修复提交于本文件同批；S5-S11 为带证据的核对结论；S12-S18 为如实登记的遗留项。
