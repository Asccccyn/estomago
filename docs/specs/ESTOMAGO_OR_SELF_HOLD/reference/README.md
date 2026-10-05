# 参考代码的界限

本目录为纯函数和单请求SSE解析参考，可用Node直接测试，之后按现有TypeScript工程规范移植。

`policy.mjs`：成功书签、精确提醒范围、主模型完成校验、容量调度与OR用量归一。

`or-payload.mjs`：明确OR型号、1h控制参数、A/B/G标记、非变异构造及追加前缀断言。只为选定Claude Chat Completions路径；不是通用多供应商SDK。真实模型/端点/schema兼容与上游内部转换仍需应用层探针。

`or-stream.mjs`：UTF8/SSE帧、单请求终态/usage和完整工具参数组装。不会调用模型或执行工具。opaque reasoning片段按接收顺序单独保留；并未实现所有型号的reasoning_details delta到完整签名块重建。GLM必须按实际型号协议实现该部分并验收，不能把片段数组直接当可发送的完整reasoning_details。

这些函数没有身份库、网络凭据、数据库事务、MCP服务器、自动运行循环或生产迁移。引用它们不等于这些关键能力已经完成。尤其“receipt.verified=true”在参考夹具中是输入；真实实现必须由领域响应验证得出，不能让模型或前端自填。

同样，model_capacity和token估计必须由实际能力/计数器提供；参考函数只验证给定参数的决策，不是tokenizer。profile的reasoning参数需经过实际能力和既有权限检查，参考构造函数不代替这道门。

测试仅使用合成数据；源码不调用fetch，不读取环境中的API key，不启动后台进程。
