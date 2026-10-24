# MIGRATION_MATRIX

工具按contracts/tool-ownership.json逐项填，不省略尚未迁项。
48 工具行自 P02 起按域逐卡填写；P01 完成的是结构接缝（下表）。

## 结构接缝（P01）

| 能力/生命周期 | 旧位置 | 新owner/入口 | 定义/投影/政策来源 | 真实Host消费者 | 旧路径退役证据 | 验证 |
|---|---|---|---|---|---|---|
| HostToolSpec/SeenRef/ToolExecContext/ToolExecResult/BackgroundToolQuote 叶类型 | runtime/host-tools.ts:988-1014、background-tool-cost.ts | capabilities/contracts.ts（正本） | 包04 §A（字段逐一对照） | supervisor.ts、host-tools.ts、tool-discovery.ts | host-tools/background-tool-cost 保留纯 type 重导出（P09 删；见下方重导出清单） | typecheck；tool-catalog-golden + 4 个定向测试 |
| 通用参数形状校验 | runtime/host-tools.ts validateToolArgs 遍历段 | capabilities/validation.ts validateArgsAgainstSchema | 错误码逐一保持；业务约束留所属 handler | host-tools.validateToolArgs（唯一包装点） | host-tools 旧遍历段已删（53f4092 后无副本） | audit-d-fixes（码点长度）/wishstar-integration/wp7-cross-contract/tool-discovery |
| 目录构建输入（48 定义） | runtime/host-tools.ts 单一数组字面量 | host-tools 内 10 个域 spec 工厂 + BASELINE_TOOL_ORDER 装配（物理迁移到 modules/<域>/definitions.ts 于 P02+ 按卡进行） | tool-ownership.json baselineOrder；golden tests/golden/tool-catalog-baseline.json | buildHostTools（supervisor.windowTools、tool-initial-visible 快照、validateToolArgs 正本） | 待 P02+（域工厂为接缝） | tool-catalog-golden sha256 770e9fef… 恒定；tool-discovery-supervisor |
| tool-initial-visible 反向依赖 | tool-initial-visible.ts → host-tools 值导入（环） | renderInitialVisibleText(db, specs) 显式快照参数；只依赖 contracts+tool-discovery | B 段文本同源（definitionId+完整参数） | supervisor（window bootstrap B 段） | host-tools→tool-initial-visible 环已拆除（073f736） | tool-initial-visible 3/3；tool-discovery-supervisor（deferred wire） |

## 待迁移（48 工具，P02 起逐卡填行）

| 能力/生命周期 | 旧位置 | 新owner/入口 | 定义/投影/政策来源 | 真实Host消费者 | 旧路径退役证据 | 验证 |
|---|---|---|---|---|---|---|
| **oido_get**（baselineOrder=28，owner=oido） | host-tools.ts 私有 oidoGet + executeInner 分支 + oidoSourceAllowed/绑定查询 | modules/oido/module.ts `oidoGetCapability` → capabilities/registry → capabilities/executor（executeRegisteredCapability）；宿主路由=HostToolExecutor.executeInner 已迁集合分支 | 定义=OIDO_GET_DEFINITION（模块正本，host-tools 域工厂只读同源）；投影=oidoModelView 唯一一次（条目 toModel）；费用=quoteBackgroundTool('oido_get') 可信上界（非 verified-free）；memoryOnlyAllowed=true（D39）；label='读声音证据' | 真实模型回合 define/invoke（tests/unit/oido-get-registry-host-wiring.test.ts：新handler=1、wire=oidoModelView(OVERVIEW)）；app-context 装配 registerOidoCapabilities | 旧 oidoGet 私有方法与 executeInner 分支已删（测试断言 `(tools).oidoGet===undefined`）；deferred 窗直调 USE_TOOL_INVOKE 门保持 | typecheck 0；oido-get-registry-host-wiring 通过；12/12 定向回归（含 b2-memory-only-gate、full-audit-tool-budget） |
| （P03）语音/深听组合（oido_analyze/ingest/receipt） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |
| （P04）记忆与其余工具按域 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |

另列消息accepted/revised/published、afterCommit、context各钩子、背景executor、程序事实入口、HTTP域路由、worker启停（P05-P07 填）。

## 临时重导出/兼容层登记（D24：迁移矩阵必须登记消费者与删除批次）

| 兼容层 | 位置 | 消费者 | 计划删除批次 |
|---|---|---|---|
| HostToolSpec/SeenRef/ToolExecContext/ToolExecResult type 重导出 | runtime/host-tools.ts 顶部 | supervisor（已改指 contracts）、app-context（HostToolExecutor 值导入不涉叶类型）、测试 4 文件（audit-d-fixes/wishstar-integration/full-audit-tool-budget/wp7-cross-contract） | P09（测试改指 contracts 后删） |
| BackgroundToolQuote type 重导出 | runtime/background-tool-cost.ts 顶部 | 无生产消费者（supervisor 已改指 contracts） | P09 |
| validateToolArgs 包装（allowlist 解析） | runtime/host-tools.ts | executeInner、测试 4 文件 | 保留（allowlist 解析属宿主；P04 域校验迁出后复评范围） |
