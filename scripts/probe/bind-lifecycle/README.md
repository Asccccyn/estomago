# BIND 生命周期双进程联验探针（2026-11-17，按 Codex 生命周期返修指令）

两个不同 PID 的真实 E 宿主（apps/host/src/main.ts）+ 真实 M（uvicorn 隔离库，真实
registry/schema/事务/幂等层）+ 合成判断服务（与 M 代理合一，可编程注入 503/扣回执/挂起响应）。

## 场景（全部 PASS，见 docs/reports 交付回执）
- a 正常链：两段+间隔消息逐段对账；停启后判断/绑定零增长
- b 判断在途停机：等待内返回→P1 完成；直到退出仍未知→P2 重发（两次接收=E 两次计数）
- c A 成功 B 明确未提交：P2 只补 B、不重判；M 恰 A+B
- d B 已提交回执丢失：P2 按原操作键重放找回原 binding_id，无第二条 B
- e B 未提交+人工绑定：人工 ID 不被认领/不覆盖；E 保留 A 原回执；停止自动追加

## 复跑
```sh
MR=$(mktemp -d)
MARIPOSA_ALLOW_CREATE=1 MARIPOSA_ROOT="$MR" \
  ~/Projects/mariposa/.venv/bin/python scripts/probe/bind-lifecycle/seed_m.py "$MR" > /tmp/token.txt
PROBE_M_ROOT="$MR" PROBE_M_TOKEN=$(cat /tmp/token.txt) node scripts/probe/bind-lifecycle/driver.mjs
```
前置：M 仓在 ~/Projects/mariposa（白名单含 source.binding.bind/of_memory/expected 字段）；
clock.mjs 把 BIND tick 60s→1500ms；M 限流在探针内放开（隔离库）。
