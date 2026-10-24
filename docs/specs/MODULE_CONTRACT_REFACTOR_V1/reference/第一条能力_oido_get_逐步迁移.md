# 第一条能力 oido_get：逐步迁移示范

这是针对本机849b1d5实际方法的施工路线，不是新的业务设计。目标是指导Flash把一条真实链完整搬出，不是给它一个空接口自己猜。

## 1. 先抄下必须保持的行为表

| 顺序 | 当前行为 | 迁移后位置 | 不得省略的原因 |
|---|---|---|---|
| 1 | 没有oído adapter→INTEGRATION_UNCONFIGURED | oido service | 配置不存在不能冒充空结果 |
| 2 | analysis_id+ctx.roomId查oido_source_bindings | oido source repository | 不能只拿analysis ID读别房内容 |
| 3 | 原oidoSourceAllowed检查asset/hash/合法消息绑定 | 同repository的当前源授权查询 | 有绑定行不等于当前仍可读 |
| 4 | ctx.signal.throwIfAborted | 原用例执行位 | 已停止不发HTTP |
| 5 | detail为prosody_page→getProsodyPage，否则getOverview | oido service→原adapter | 不丢分页cursor或overview语义 |
| 6 | HTTP后再次检查signal和allowed | oido service | 迟到结果不能继续交付 |
| 7 | result.analysis_id与请求不符→OIDO_RESULT_INVALID | oido service | 不把错结果交给当前请求 |
| 8 | oidoModelView(result,page) | 唯一模型投影边界 | 保留白名单，不双投影 |
| 9 | abort→CANCELLED，否则沿当前错误码 | 当前统一失败边界 | 不改ok=false为成功 |

不要顺手重写oidoSourceAllowed的SQL。若发现该谓词与用户最新“已发布”要求不符，先给正常可达路径证据、列独立语义缺口，再按裁定处置，不由结构迁移偷偷更改权限。

## 2. 第一小步只提取窄查询

建立 `modules/oido/source-repository.ts`。从旧类移出绑定查询及源判定，构造时只绑定它真正需要的既有Db/资产可见性读面。对外只暴露如 `analysisBinding(analysisId, roomId)`、`sourceAllowed(binding, roomId)`；不暴露原Db。

旧oidoGet暂时通过该repository调用，其他逻辑不变。只做这一步的typecheck与已分类普通读取/拒读测试，证明搬函数没有变行为。

## 3. 第二小步提取用例

建立 `modules/oido/service.ts`，依赖source repository和OidoAdapter。迁移当前查询、signal、分支、结果一致性和错误映射。先把旧HostToolExecutor.oidoGet改成一句委托，确保行为等价；这只是过渡，P02结束须删除旧业务方法。

内部成功结果可保留 `{ raw, page }`，模型投影调用 `oidoModelView(raw,page)`。内部的raw不要作为工具output直接泄露。

## 4. 第三小步登记完整能力

`modules/oido/module.ts`提供oido_get能力条目：
- id就是原oido_get；baselineOrder=28；owner=oido。
- definition从原catalog完整迁出，函数名/description/parameters对象顺序不变。
- schema校验沿请求窗口的frozenSpec，不用当前新定义替代。
- handler调用上述service，不再调旧HostToolExecutor。
- model projector唯一调用oidoModelView；failure仍走原失败投影。
- quote沿可信配置上界，oido_get当前不在verified-free名单中。
- memoryOnlyAllowed=true，是已批准轻量通话能力；不是所有oído都true。
- label/silent沿原值，保持tool start/result事件身份。

## 5. 第四小步接上真实模型入口

把已迁名单设为恰好oido_get。旧业务分发中删除此名分支；其他未迁名显式进入尚未迁路径。新registry报错不能回旧handler。发现与执行对同一name只能获得一个定义/handler。

model bridge继续做现行deferred协议和已见检查；executor解析真实能力后调用条目。UI/宿主内部端口不伪造tool_define。

## 6. 第五小步验收真实入口

通过已有上传/消息发送/分析流程建立合法源与analysis绑定；外部只用边界fake。实际Host建立窗口→catalog→define→invoke oido_get，观察：
- 新handler实际调用一次，adapter实际收到overview/page参数；旧handler不会再执行。
- 结果与迁移前model view相同；signal/错误码保持。
- 一个普通未发送准备场景拒读；一个普通stop迟到结果不交付。
- 通话时允许oido_get；前台普通调用不被新增背景报价门挡住。
- 旧窗口的定义ID/顺序/前缀未改变。

测试记录“Host离线合同”，不能写成真实oído已在线分析成功。

## 7. 再扩大，不反过来

上面通过才迁oido_analyze及其ingest/receipt组合，然后其余oído工具。不要先把48个工具一次改名搬走，再用全量测试猜哪里坏了。

每次同一能力的schema、执行、投影、费用、模式资格都一起收口；否则仍会留下“新工具要改五个中心名单”的原问题。
