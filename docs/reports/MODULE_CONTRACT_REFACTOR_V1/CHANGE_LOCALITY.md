# CHANGE_LOCALITY（扩展局部化证据 · S17a 落实）

08 号核心问题 2：**添加一个同类能力时，是否还要修改 supervisor/消息核心/通用执行器的业务分支？**

## 演练A（探针模块）的改动面

`git diff 849b1d5..HEAD --stat` 中与探针相关的全部文件：

| 文件 | 性质 |
|---|---|
| tests/helpers/probe-module.ts | 新增（测试目录；不进生产目录/默认工具集合） |
| tests/unit/probe-module-extension-drill.test.ts | 新增（演练测试） |

生产目录 diff 为零——探针接入只改了**测试装配声明**（registerProbeModule→CapabilityRegistry）。
supervisor.ts / messages/service.ts / capabilities/executor.ts / http.ts 在该演练中零改动（git log 可验）。

定义（PROBE_DEFINITION）/处理器（run：本地 SQL 只读）/费用（verifiedFree 只读）/模式资格（memoryOnly=false）/投影（透传）
五件事在同一条目一次声明；registry→executor→模型投影全链真实执行（deferred 窗直调门保持、legacy 测试装配窗从
真实工具入口执行，bound true/false 如实）。

## 结论

新增现有工具型能力 = 新模块文件 + 装配一行（测试里为 registerProbeModule 一行）。
**聊天核心（supervisor/消息核心/通用执行器）零业务分支改动。** 这就是本专项的原始目标验证：
未来新增功能不再牵一发动全身。

若未来要把探针类能力提升为生产能力：模块文件移入 modules/、app-context 装配一行、
（如需进默认目录）tool-ownership 登记——仍不触碰核心业务分支。
