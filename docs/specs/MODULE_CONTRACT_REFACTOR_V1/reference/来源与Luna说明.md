# 来源、推断与未核实项

## 本机来源（本包主体依据）

工作树与SHA见02。以下文件本次实际只读核对过：
- runtime/host-tools.ts 的工具定义、ToolExecContext/Result、全局toolCallId、业务分发、方法定位。
- runtime/supervisor.ts 的串行队列、程序事实接受、voiceTap、停止、恢复、后台工具循环等符号。
- runtime/model-results.ts；runtime/background-tool-cost.ts。
- scripts/run-tests.mjs（含精确 --file= 选择器与隔离规则）。
- app-context/messages相关挂点与现有测试文件名通过受限检索核对。
- 既往本轮对话已读取的原始第14节、10月19日架构勘误及当前工具快照实现。

源码锚点是观察，不是建议；目标目录/新类型/迁移批次是本包设计，不冒充已经实现。没有把提交日期或旧报告当生产运行证明。

## 用户明确要求

实施GLM5.3Flash；GLM5.3与Astra复核；模块间需要组合；不再牵一发全身；测试以一般实际使用为起点；不跑不可能状态/极端测试；JSON只给模型必要内容；保留已裁定浮现、唤醒、心跳、语音、记忆语义。

## Luna

历史上下文检索、当前本机文档及Library检索没有确认具体Luna资料。公网同名检索也未给出可可靠对应用户所指对象的材料。因此本包不声称复刻任何Luna工程，不引入同名外部项目。没有让这个缺口阻塞用户已经充分明确的施工要求。

## 外部原理参考（非本机接口正本）

MCP架构的Host/Client/Server职责：官方仓库中的2025-11-25架构文档，Host负责授权、隔离与上下文协调；不能据此推断本项目已经实装通用MCP。该版本只用于解释职责，不作为本次升级协议要求。
https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/architecture/index.mdx

本包不要求任何依赖升级。网络资料不能覆盖用户产品语义、本机合同或已冻结的窗口状态。
