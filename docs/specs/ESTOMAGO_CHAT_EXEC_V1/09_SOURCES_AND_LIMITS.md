# 09 · 来源、核验边界与未核实合同

资料核验日期：2026-10-11。源码基线为当前可见main，不以历史分支记忆或旧审计包的source副本判断实现。

## 1. 源码依据

仓库：[Asccccyn/estomago](https://github.com/Asccccyn/estomago)

固定提交：[4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1](https://github.com/Asccccyn/estomago/tree/4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1)

提交时间：2026-10-10T13:21:03Z。02列出具体文件与事实；PACKAGE_MANIFEST含被引用的实际文件SHA-256。preflight用于核实施工时是否已漂移，不能据此覆盖新代码。

本次查看了消息/HTTP/UI、驱动/发包、窗口/选集、SDK装配、工具/Mariposa、归档、事件、usage、配置、迁移与测试入口。没有访问用户Mac生产配置、数据库、密钥或运行日志。因此“源码包含OR路径”“README说OR主接入”和“用户机器当前正运行OR”是三个不同结论，本包只证明前两类源码事实。

## 2. 官方资料与本包采用的结论

| 来源 | 本包使用的有限结论 | 不能推出什么 |
| --- | --- | --- |
| [Claude API Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 5m/1h是缓存TTL；同前缀缓存读写有观测字段；读命中刷新，时点关联请求开始 | 每个请求一定命中、后台请求免费、所有路由支持完全一样 |
| [OpenRouter Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | Anthropic显式cache_control和1h参数；provider路由会影响命中；sticky会在空闲10min后过期 | 50min定时就能保证回到同物理缓存节点；不能以此擅自改成10min付费唤醒 |
| [OpenRouter Message transforms](https://openrouter.ai/docs/guides/features/message-transforms) | context-compression是可配置转换；当前est请求明确关闭 | 上游账户强制策略一定允许请求覆盖 |
| [OpenRouter Plugins overview](https://openrouter.ai/docs/guides/features/plugins/overview) | 请求与账户默认配置有优先级，Prevent overrides可能限制覆盖 | 用户账号实际已关闭/开启该限制 |
| [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | Agent SDK带Claude Code代理执行循环，与普通API Client SDK不是同一层 | 使用API key等于绕开SDK自动行为 |
| [Agent SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop) | SDK有自动上下文管理，compact_boundary等信号需要处理 | 当前est已处理了这些信号；特定空闲计时分支在所有headless版本必然相同 |
| [Claude Code Prompt caching](https://code.claude.com/docs/en/prompt-caching) | 当前文档主会话包括Agent SDK；公开TTL选择及覆盖顺序；压缩会改变对话前缀 | 本仓锁定SDK依赖等于用户已安装某个CC二进制；仅UI显示1h就证明已生效 |
| [Claude Code Environment variables](https://code.claude.com/docs/en/env-vars) | DISABLE_COMPACT公开声明禁止所有压缩；DISABLE_AUTO_COMPACT只描述接近窗口上限的自动压缩 | 所有旧版本/自定义网关必然支持；禁止自动记忆就等于禁止压缩 |
| [Claude API compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) | API压缩有显式配置/协议；prompt caching与compaction是不同机制 | 一个CC客户端内部flag能直接控制est的独立OR fetch |
| [Claude Code issue #98747](https://github.com/anthropics/claude-code/issues/98747) | 官方仓讨论包含空闲压缩与版本控制线索，可用于定位回归 | issue不是稳定API；不能据它证明特定账号rollout、flag默认值或本机最终设置 |
| [MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture) | MCP定义宿主/客户端/服务端及能力通信；可用HTTP类传输 | MCP会替代聊天历史、前端或业务后端；写几个工具名就等于接通协议 |

公开文档会更新。GLM接包时应对实际版本读取相关原始文档，不照抄本包中的历史版本数字作为最新值；无需因此扩大调查到无关产品。

## 3. 关于tengu_sunny_locket的明确裁定

用户提供了该内部flag名称及观察到的空闲压缩情况。本轮把它作为问题线索，不作为生产配置合同。

- 独立OR driver直接发HTTP，不执行CC客户端代码；这是从当前源码调用链得到的架构判断。
- SDK路径仍要警惕自动上下文管理。已有“autoMemoryEnabled=false”控制不是禁压缩证明。
- 当前官方TTL文档提供 `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` 的公开方向，并说明 `FORCE_PROMPT_CACHING_5M=1` 优先。实施需核最终环境白名单、设置来源和真实二进制版本，不能只在示例YAML增加未透传的键。
- 当前官方变量表的 `DISABLE_COMPACT=1` 比“只关接近上限的自动压缩”覆盖声明更广；仍需实际版本事件/最终payload验证。
- SDK自主/保温在未验证前保持能力阻断；普通SDK入口保留但真实状态明确，不能让一个未核驱动 silently成为后台主驱动。

本包没有修改Anthropic内部开关、拦截feature flags或要求绕过管理策略。若上游规则与本地策略冲突，显示冲突并停止受影响后台行为。

## 4. 缓存唯一正本具体是什么

唯一正本是用户批准的est规则、冻结的身份/工具/上下文投影及持久原文/协议轨迹。供应商cache是可失效的性能与计费层。

因此本包同时要求：TTL仍1h；调度50min滚动；实际read/write证据关联dispatch起点；缺失为unknown；冷缓存正常；失败红点可见；不得自动摘要、静默换模型、删原文或把上游物理命中包装成保证。

预算默认表不硬编码当前模型单价；付费后台预占需要实际选定模型/工具的可核价格与可信上界。不能用用户消息粗估乘一个猜测单价后声称硬预算已保证。

## 5. 交给GLM核的外部合同清单

| 能力 | 本包可确定 | 尚需真实证据 | 缺失时行为 |
| --- | --- | --- | --- |
| Mariposa基础 | est已有HTTP能力client和归档链 | 当前服务版本/schema、资产项语义、日历批量/分页、稳定our_words ID | 保留文字可用；相关外部能力blocked，附件不假ACK |
| Siren | 语音处理外置，语音条和实时通话分开 | TTS/STT/音频URL或file_ref、异步任务/费用/取消/流式合同 | 可保存原音频，转写/合成/通话如实未就绪 |
| oído | 用户指定MCP，频谱/听觉业务归该项目 | 用户本机半成品接口、MCP工具和音频数据通道 | 配置位与能力状态真实；不凭GH缺文件判不存在 |
| 扎西德勒 | 用户指定MCP，其朋友圈独立 | 当前工具/数据/授权合同 | 不影响新双人朋友圈 |
| Antinomy | 共度/阅读已有外部项目 | 当前读写/资源打开合同 | 入口可见，未连接明确显示 |
| Superposition | 星星保持原项目，日历仅special_dates | 日期批量/分页、邀请/拆星权限和可见性 | 不用created_at代替、不自动取下一颗 |
| X/小红书 | 不重写现成架构 | 真实接入入口/权限/副作用和费用 | 标disabled/unavailable，不造爬虫 |
| 图检索/生图 | 外部适配，产物导入est持久资产 | 所选实际服务、引用类型、模型视觉/费用上限 | 人工表情含义检索可先用；不假装语义图检索已成 |
| 手机离线推送 | 必须区别于网页站内提醒 | 浏览器/设备能力、现成推送通道、用户启用状态 | 标not_supported/disabled/unknown，不能假称已推送到手机 |
| 情绪数值/游戏 | 已有心情记录和统一入口可显示 | 用户尚未定义数值模型、具体游戏 | DEFERRED_DESIGN，不随机填数或捏造游戏 |

外部合同未核不是“先给默认成功”的理由，也不是停止所有同仓工作的理由。必须交付具体缺失字段/能力和适配位置，让后续联合审计有明确对象。

## 6. 验证声明

本执行包只进行了文件、JSON覆盖、内部合同和源码事实的校核。没有实现本包的新功能，没有运行仓库功能测试，没有进行真实模型/图片/语音调用，没有进行生产部署或外部发布。

`contracts/acceptance.json` 全部初始NOT_EXECUTED是有意保留的真实状态。包自检通过只证明交付物完整、需求有对应场景；不得在实现报告中复制成“后端验收通过”。

