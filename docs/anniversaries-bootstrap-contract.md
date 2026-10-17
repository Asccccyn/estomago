# 重要日期归属与长心情分页

2026-10-15：按用户“直接退役”的指令，Mariposa 独立纪念日子系统及 est
对其开窗段的消费一并退役。继续复用 Superposition 的重要日期正本；
长心情分页、Mariposa 的“纪念”记忆分类与 content 纪念作品保留。

## 归属与退役边界

| 内容 | 归属与状态 |
| --- | --- |
| 纪念日及自定义重要日期名册 | Superposition `special_dates`，已有增加/列表服务、HTTP、MCP 和网页 |
| 日历展示、普通提醒执行 | est；Superposition 日历适配仍需单独接线，不冒充本轮完成 |
| 图标、图片、动画等纪念作品 | 可选 `apps/content`，保存资产与稳定桶引用 |
| 原事件、实际发生日期、原文和纪念分类 | Mariposa；`anniversary` 分类仍为永久 WIDE |
| Mariposa 独立纪念日定义/发生项、Bootstrap 段及续页 | 已退役，无活跃读取、输出或创建入口 |

Superposition 可复用入口为 `GET/POST /api/special-dates`，MCP 真名为
`special_dates` / `add_special_date`。只读日期不发邀请、不确认、不拆星。
其公历月日名册已有，农历、下一发生日、提前提醒等不是已完成能力；
非空 year 的产品含义仍待明确，不能擅自解读为一次性日期。

Mariposa 移除 `anniversaries` 出站、同名 bootstrap.next section、预算分支、
内容指纹与 compact 投影。est 删除相应读取、拼接、分页类型和校验逻辑；
旧服务多余的同名字段只被丢弃，不注入、不续取、不生成空占位。

Mariposa 升级迁移将旧活跃表改名为只读 `legacy_anniversary_definitions` 和
`legacy_anniversary_occurrences` 存档，以保留可能存在的旧行；运行时不再读取。
历史迁移不改写，旧快照通过规则版本升级失效。本轮不直接操作生产库、
不删除存量、不将记录自动复制到 Superposition。

## 保留的长心情分页合同

- Mariposa 要求同快照、同 profile、权限有效；没有规定各区块必须整包原子交付。
  `bootstrap.get(profile=estomago, loaded_snapshot_id=原快照)` 在同一读事务内
  复核状态指纹；只有 `unchanged=true`、原 snapshot_id、正确 profile 才是复核成功。
  该薄响应不携带正文，不能要求其复制正文的权限信封。
- `mood_text_next` 续取 `section=memory_item`、`field=mood_text`；offset 和
  total_chars 按 Unicode 码点。逐页核验快照、记忆、字段、权限、游标前进和最终总长。
- 普通网络/超时/5xx/429：同页最多两次尝试；仍失败只删除该条心情的**全部正文**，
  包括首片和已取得续片。其余心情与事件、话语、I、计划仅在原快照复核成功后保留。
  缺失有显式说明，不能将半条心情伪装为完整内容，也不能把失败解释为没有记录。
- 快照失效：废弃当前尝试全部资料，从新首页重建一次（总共最多两次装配）。
  权限拒绝、资料权限/归属错配、复核不能成功：整包资料不交付，输出“资料未取得”说明。
  主动取消整窗任务：停止并返回空，不发故障告警；单次请求超时只影响对应字段。
- I/事件/话语先处理，再取心情续页。心情最多 64 次请求（含重试）、512 KiB、
  4 秒，并按整窗剩余时间预留快照复核余量；每次请求 1.5 秒，整窗 8 秒。
  资源限制是显式缺口，不是静默截断许可。原 I/事件/话语不完整时保留已载前缀和
  缺口说明，复核后交付；其快照/权限错误不再被旧 catch-and-break 吞掉。
- 只有无故障的已请求资料进入 `bootstrapByWindow` 完整缓存。近三日桶/计划列表
  原有“本窗首页、剩余按需查询”范围保留，并不宣称所有历史或所有计划全文已加载。
  未派发的准备结果可重建；已开始派发的窗口轨迹保持原样，不能在原前缀中热替换 B。
  已发窗口仍可显式查询缺失资料或在新窗口重新装配。
- 部分缺失登记 `BOOTSTRAP_INCOMPLETE` warning，I 缺失或整包不可用升级 critical。
  独立系统异常入口、红点、详情、HTTP/SSE 重连补查均消费持久告警；已读不等于恢复。
  只有同一准备/窗口的完整装配成功才解除相应告警，不借新窗口成功抹去旧窗口缺口。
  告警不保存 I、心情、事件、计划正文或上游原始错误文本。
- 独立纪念日退役保持；其他事件召回、`anniversary` 记忆分类和合法补心情标签保留。
  每次 Mariposa HTTP 响应仍受 24,576 UTF-8 字节上限保护。

## 可复跑验证

具备两仓现有依赖、Node >=22.18 与 Mariposa Python 环境后，在 est 仓执行：

```bash
python3 scripts/verify-mariposa-bootstrap.py --mariposa-repo /path/to/mariposa
```

脚本自动使用临时 ESTOMAGO_HOME、MARIPOSA_ROOT 与合成凭据，保留测试保险丝，
仅监听 `127.0.0.1:18882`，结束关闭子进程。不启动模型、不发送真实消息，
不读取生产数据或刷新生产构建。可用 --port/--python/--output 指定测试环境。

验证真实 FastAPI HTTP → est 默认 transport → windowBootstrap：legacy/compact_v1
长心情逐字完整、I/计划/事件/话语只注入一次、同窗完整缓存/新窗读取；明确注入
中途 503 后只缺失败心情；真实修改合成库使快照失效，验证重建无跨快照混合、
持续失效有界退出；真实告警持久化、已读与恢复分开、取消。没有真实模型调用。

可传 `--baseline-estomago-repo /path/to/accepted-source` 与历史已验收版本的成功输出
逐字节比较；不传时报告 `baseline_verified=false`，不冒充已完成新旧对比。
另有 `tests/integration/bootstrap-alerts-ui.test.ts` 验证真实 HTTP/SSE 到前端 client，
`tests/cross-project/system-alerts-browser.mjs` 用独立 Chrome 验证红点、抽屉、已读、
恢复和严重告警（需要构建前端及显式传入 Playwright/Chrome/输出路径）。

定向单元测试仍走 npm test。设置独立临时 ESTOMAGO_HOME 并移除真实凭据后：

```bash
npm test -- --unit --file=tests/unit/bootstrap-pages.test.ts
```

运行器保留保险丝、串行执行、逐文件 60 秒上限和未知路径拒绝。
