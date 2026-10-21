# 2026-10-21 交接根因修复

基线：estomago `82b193a`（含 P2 `8e52eba`）；只读核对 Mariposa `545ae22`。
交接来源：`Projects/devspace-workspace/audit-verify-20261019/CODEX_HANDOFF_20261021.md`。
前端补丁来源：`0268567`；bundle SHA-256 已与随包校验文件一致。

## 前端与启动恢复

`homecoming-chat` 测试仍只匹配 `limit=500&order=latest`，实际生产前端已改为 `limit=50&order=latest&snapshot=1`。测试桩对未知请求返回 `{}`，导致启动校验拒绝历史，随后 SSE 未建立，5 项测试全部失败。修正测试合同，并让未知地址直接报错；没有把生产 API 退回旧分页接口。

逐项合入生命周期补丁：请求 AbortController 与代际检查；停止后拒绝迟到响应与状态写入；终态 attempt 不再被高 sequence running 复活；旧 attempt 不覆盖新 attempt；异房事件不消耗主房游标；坏 JSON/不完整发送回执保留草稿和原幂等键。停止重启后旧 POST 的 finally 不解锁新的发送。

保留当前分支的 50 条快照分页、历史日期跳转、原位编辑、按需思考详情及 Enter 换行/Cmd 或 Ctrl+Enter 提交。补入输入栏停止入口。选集确认按 `selection.rotated` 消费回执，避免重复换窗；失败保留选集。重新构建 React dist。

全量验证另发现 `bootstrap-alerts-ui` 存在 HTTP 初始刷新与 SSE 到达的竞态；测试先排空启动刷新，再等待状态及真实 SSE 事件同时成立，保留所有原断言。

## 同轮记忆浮现

原实现刻意跳过源作业自绑定，把 prepared 作业交给下一条真实用户输入；准备、验证、最终准入又分别设定预算。新实现接受时即固定源/目标为同一消息及修订，记录绝对截止时间，准备、验证、两次 check 共用剩余时间。保留原配置参数，不宣称新的延迟 SLO。

后台准备与 supervisor 装配共享同一个 prepare；继续执行并发上限。超时、未知结果、编辑失效、取消、版本/许可校验失败均不注入。晚到结果不能补入已发送请求，也不能被后轮借用。旧跨轮绑定和 missed-target 扫描生产路径删除；重启时遗留非终态作业收口。

最终准入移到异步图片能力检查之后、工具循环首发之前；失败只移除当前未发送的独立 host-origin 数据块，重算缓存边界。已有历史、system 前缀和 tools 不改写；工具续轮不重新准备，已派发冻结包按现行重试合同复用。

## Mariposa 合同边界

静态核对 `backend/mariposa/capabilities/input_schemas.py` 与 `surfacing/service.py`：source 和 target 不要求不同消息；validate 接受 ISO deadline。prepare/validate 继续走 `_surface_gates`，`surfacing/judge.py` 要求 `current_dialogue` 许可，次数/费用预算继续生效。未修改 Mariposa、许可或预算，未调用真实外部服务、真实 judge 或发送真实聊天消息。

## 验证

- 最终完整 `npm test`：136/136 文件通过，0 失败（含新增生命周期文件）。
- `npm run typecheck`、`npm run typecheck:web`：通过。
- `npm run build:web`：通过，已更新 `apps/web/dist/chat-app.js`。
- `git diff --check`：通过。
- 测试使用临时 ESTOMAGO_HOME；本机 HTTP/SSE 集成测试需在允许 loopback 监听的环境运行。沙箱首跑的 EPERM 不计为功能验收。
- 未重启生产服务、未推送远端；真实跨服务效果和延迟仍需实机验收。
