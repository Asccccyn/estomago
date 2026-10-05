# 前台记录接口（逻辑契约）

优先映射现有room查询和events流。若需新增，建议：

`GET /api/v1/conversations/:id/context-records` 返回 `RecordSnapshot`。

`GET /api/v1/conversations/:id/context-records/events?cursor=...&limit=...` 返回有界 `RecordEvent[]` 与 next_cursor；limit 默认30、上限100，游标按房间签发/校验。

这里路径是拟定接线，不宣称服务现在已开放。沿用同源认证与房间ACL，不让只知道room ID就能读。服务端校验cursor范围，客户端按eventId/sequence去重；SSE重连不能重放业务写入。HTTP日志不得记录带秘密query。响应默认无完整prompt、签名思考、key或未授权桶正文。

面板 GET 严格只读。真正查看桶详情另走现有明确打开合同，不由列表刷新代替。UI模型配置的POST是独立权限动作，不挂到GET健康检查。UI至少区分状态的“未配置/未知/等待/零新增成功/实际失败”，不把未知显示零。
