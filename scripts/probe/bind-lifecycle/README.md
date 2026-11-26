# 午夜来源绑定与日历重算联验

在 E 仓运行 `node scripts/probe/bind-lifecycle/driver.mjs`。默认使用同目录下的 mariposa 仓和其 .venv/bin/python，可通过 PROBE_M_REPO、PROBE_PYTHON 指定。探针创建独立临时库、凭据和回环端口，退出时清理。

正常判断、M 事务提交前后停机、明确 503、已提交但回应 503 后手动核回原回执、判断在途停机，以及 M 原生桶连续 402 后在日历手动重算，均通过正式 E HTTP 和 M registry 运行。按有序成员和持久回执核对结果，同时统计判断请求次数。
