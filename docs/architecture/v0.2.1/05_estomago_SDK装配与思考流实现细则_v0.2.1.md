# estómago v0.2.1 · SDK 装配与思考流实现细则

**日期：2026-09-24。性质：待实现规格。目标：Mac mini，TypeScript，沿用 apps/host。**

本文件将 01 主架构的 §6、§11.4、§17 展开成执行要求。SDK 的事实以 06 来源核对记录为依据；以下数据模型、API、状态和路径都是拟实现契约。所有实机能力先为 unknown，不把参考截图或网页当成功运行证据。

## 1. 范围与不变项

新增官方思考摘要的请求、流式接收、独立持久化、折叠展示与故障恢复；细化身份加载和来源隔离。原消息、换窗、Mariposa、Siren、许愿星、群聊、时间与路由规则继续生效。

不提取原始 CoT，不还原签名/删隐内容，不自动给摘要再做模型改写。不新增 Telegram bot，不注册“Stop 后发 tg”作为主实现，不为实现摘要改用 Python 或建立通用 OpenAI-compatible 代理。

“思考”是初始展示名建议，参考图“桥下”不是已经批准的固定文案。群聊与工作器的摘要权限不能从“同一个页面”推导。

## 2. 配置装配契约

### 2.1 三种配置层不要混

`estomago.example.yaml` 是本项目应用配置。映射器读取后产生 SDK options、inline settings 和受控 env；它不是一个可以原样发给 SDK 的 JSON。必要参数缺失即阻止正式启动，未知参数不忽略；不要用 `as any` 绕过编译后声称支持。

| 应用意图 | SDK/运行时目标 | 现场验证 |
|---|---|---|
| 显式身份 | 自定义 systemPrompt，不加 claude_code preset | 材料 hash、来源和隔离行为 |
| 文件来源关掉 | settingSources:[] | user/project/local 测试指令不加载 |
| 内置工具不提供 | tools:[] | registry 与实际事件，仅保留选定 MCP |
| 业务能力 | mcpServers:获准映射、strictMcpConfig:true | 工具目录、名称、授权与调用样本 |
| 不建旁路记忆 | inline settings.autoMemoryEnabled:false | 合成 auto-memory 不加载/不写入 |
| 不自动接连接器 | inline settings.disableClaudeAiConnectors:true 与严格 MCP | 实际 auth 路径下连接器清单 |
| 不用工程扩展 | skills:[]、plugins:[] 等当前公开选项 | 类型/加载记录；版本不支持时找受支持等价配置或报阻断 |
| 返回摘要 | thinking.type=adaptive，display=summarized | 模型支持＋实际可读块；无块不直接判失败 |
| 增量接收 | includePartialMessages:true | stream_event 与内容类型样本 |
| 路由先决定 | inline settings.switchModelsOnFlag:false | 当前运行可见范围＋自建 pending gate |
| 固定投入策略 | effort 来自批准配置和能力矩阵 | 不抄教程 max；记录实际生效档位 |

只对当前 API 类型确有支持的组合装配。模型只支持其他 thinking 模式时，明确报告与选择，不静默换模型/切计费。不把“参数发送成功”等同“返回摘要已接通”。[T3,T8,T16,T17]

### 2.2 不能靠一个空数组隔离一切

settingSources 涵盖普通来源，但全局 Claude 配置、自动记忆、特定认证下连接器、托管策略与环境还需核对。[T3] 使用独立应用运行目录与必要的配置隔离；具体 `CLAUDE_CONFIG_DIR` 路径先由 doctor 探测再赋值，隔离后认证可用性重新检查。

禁止清空或覆写用户其他项目的全局配置；禁止删托管限制来满足测试；禁止把整个开发终端 env 复制给服务。检查但不输出 key/token/body；不借复制凭据实现迁移。官方认证使用范围与账单来源单独确认。[T19]

### 2.3 静态/动态与继续会话

固定身份与规则用显式 systemPrompt；I 在 Mariposa 开窗包只装一次；每轮 Time Context 在处理前用宿主构造的上下文或经验证的 hook 注入。消息库原文不含这些技术附加块，必须维护“正式内容→模型请求装配”的可追踪映射。

SYSTEM_PROMPT_DYNAMIC_BOUNDARY 仅作为以后可选缓存优化；snapshot/缓存配置不能成为刷新时钟的依赖。新身份走新窗；不编辑 transcript、强制压缩或随意关闭生产快照来更新身份。[T1]

## 3. Bootstrap Receipt：证据不是自填布尔值

每次开窗先核对 Manifest；Receipt 再记录本次装载实际情况。模板 `bootstrap-receipt.example.json` 分四层：

- desired：批准目标，如不启用产品 preset、工具白名单、身份版本。
- assembled：应用真正交给 SDK 的非敏感参数清单与 hash。
- observed：可观察运行时 init/tool list/加载 hook/版本信息；未观察字段为 null。
- probe：隔离测试和匹配版本的既有基线引用，不在每次开窗调用多轮真实测试污染聊天。

`final_request_observable=false` 不是失败掩饰，也不是允许编造完整请求。只对可核实目标下结论。`original_preset_included=null` 表示没有该层观测；本地配置可以记录 requested=false，但不能混作 observed=false。

激活 gate 检查批准身份存在且 hash/版本正确、配置和工作区正确、I/权限有效、关键来源未越界、所需能力已获匹配版本证据。关键项未知或不满足则 BLOCKED；仅非关键、供应商未暴露的内部细节列为 not_observable。任何 PASS 的范围必须明确，不叫“所有内部请求已验证”。运行中若发现未批准来源，暂停新任务并报告。

所有素材回归只用合成数据，结果不进正式原文/hold。身份与 I 正文不放 ZIP、Git 或普通日志。

## 4. 产品实体与最小表

正式聊天 message 和可读 reasoning block 不是同一张表。建议新增：

| 表 | 核心字段 |
|---|---|
| reasoning_blocks | id、conversation_id、turn_id、attempt_id、window_id、sdk_session_id、sdk_message_id、block_index、origin、visibility、state、text_ref、revision、completeness |
| runtime_stream_events | stream_id、sequence、event_id、kind、entity_ref、entity_revision、scope、occurred_at、payload_ref |
| bootstrap_receipts | id、window_id、manifest_ref、desired、assembled、observed、probe_refs、gate_state |

规范唯一键：`(attempt_id, sdk_message_id, block_index)`；SDK 未提供稳定 message ID 时，adapter 可绑定本连接 message_start 的本地模型步标识，但必须标出来源，不能伪造供应商 ID。重连跨连接无可靠映射时重新读取持久投影，不用猜测合并。

`text_ref` 是私有内容引用，不是公网 URL。signature/encrypted payload 不进入 UI 数据库字段；继续会话的协议材料由 SDK 状态维护，确需额外保存时另设受控运行存储，不能通过摘要 API 暴露。

状态分两个维度：`visibility=summary|omitted|redacted|no_block|unavailable|unknown` 与 `state=streaming|complete|partial|interrupted|failed|truncated|conflict`。这些是产品状态，不逐字等同 SDK 枚举。简单请求没有 block 时在 turn 级记录 no_block，不凭空创建一段“无思考”文字。

建议默认在本机随对应会话保留可读投影，不自行定一个自动删除天数。以后更改保留策略需明示；删除投影、SDK 继续态和备份保留是不同范围，不能说一次删 UI 就全端擦除。

## 5. 归一化与块核对

### 5.1 接收矩阵

| SDK 观测 | estómago 动作 |
|---|---|
| message_start | 绑定 sdk_message_id 和模型步；隔离不同 attempt |
| content_block_start(type=thinking) | 建立/定位 block；起始非空 thinking 只接一次 |
| thinking_delta | 当前有效 generation 内追加可读片段；保留到达顺序 |
| signature_delta | 不向 UI 分发、不触发文本解析；协议态由 SDK 处理 |
| text_delta | 进入正文分句缓冲，不进入 reasoning |
| input_json_delta | 仅归为工具输入流，不直接执行或显示敏感参数 |
| 完整 AssistantMessage 块 | 依据 message ID 与当前版本块映射核对/补齐，非再次追加 |
| content_block_stop | 关闭内容块；不是工具动作成功证明 |
| message_stop | 结束这条模型消息；不必然结束产品 turn |
| ResultMessage / 明确失败 / 本地主动取消 | finalizer 记录 attempt/turn 终态，不永远等待 Stop |
| redacted_thinking / 无可读块 | 记录可见性，不还原或编写摘要 |

Agent SDK 会提供部分事件和完整块，完整块可能早于 block_stop；多块可能共用同一 model message ID。[T9] adapter 需要用锁定版本真实 fixture 确定完整块映射，不能把每份 `message.content[0]` 看成全局 block 0。

### 5.2 增量与完整块的核对规则

设持久接收文本为 A、完整块文本为 B。若 A=B，只更新定稿状态；若 A 是 B 的前缀，只补齐 B 的缺段。若不是前缀，不拼接 A+B：保留 received/final 的受控差异和 revision，发 `reasoning.snapshot` 更正投影并标 reconciliation。正文已发布气泡不可被这一流程静默覆盖。

完整块缺身份或映射歧义时先暂存为 unmatched，等待可用边界，超时后 partial/conflict；不能靠内容 hash 强行匹配。相同文本可以是不同合法块。网络重放按事件 ID/持久 sequence 去重，字符相同不是重放依据。

### 5.3 有序持久与慢客户端

同一事务或可对账写入中提交 block revision 与用于回放的事件。服务端分配严格递增的 stream sequence，前端只对新事件应用 reducer。小增量可以有界批处理，但凡前端已经收到“可恢复”事件，就应有对应持久记录。

SSE 断线按 cursor 补发；cursor 超出保留范围时取 block snapshot 和新的 cursor，不调用模型重造摘要。慢客户端队列有上限，断开后可重连，不在 SDK 接收器 sleep 等动画。

内存、磁盘、最大摘要容量设有界资源策略。存储失败或达到显式上限时标 partial/truncated，暂停/终止或经允许继续正文的策略必须可见，不把缺失片段称为已保存。数值经实测设置，不从教程硬抄。

## 6. 面向前端的事件与API

`GET /api/v1/turns/{id}/reasoning?attempt_id=...&cursor=...` 返回获准块与状态；`GET /api/v1/events?cursor=...` 复用现有受认证 SSE。

```ts
// 产品协议草案，不是 SDK 原生类型。
type ReasoningEnvelope = {
  schema_version: 1;
  stream_id: string;
  sequence: number;
  event_id: string;
  kind: 'reasoning.started' | 'reasoning.delta' | 'reasoning.snapshot'
      | 'reasoning.completed' | 'reasoning.status_changed';
  conversation_id: string;
  turn_id: string;
  attempt_id: string;
  block_id: string;
  block_revision: number;
  generation: number;
  payload: {
    delta?: string;
    text?: string;
    visibility?: string;
    state?: string;
  };
};
```

schema 在 packages/contracts 内严格校验 kind 对应 payload，不能只使用上述宽松草案就上线。SSE 与 API 都检查当前主体、房间和权限版本；URL 中的 turn_id 不授予访问权。正文/健康/群聊的授权边界同样适用于摘要与事件游标。

ReasoningPanel 默认折叠，可实时展开；没有返回摘要时正常收尾，明确状态；支持 Markdown 的实现需净化，禁止原始脚本/HTML/自动远程图片。工具进度单独来自真实工具事件，不把摘要里“读取记忆”当已执行。

不把其他 agent/subagent 片段混进char主私聊；主 SDK 没有暴露子代理增量时保留“不支持/仅完整块可见”，不承诺全局实时。[T9]

## 7. 中断、路由、换窗与恢复

中断先 fence 当前 generation，再取消 SDK 与当前 Siren session。旧 generation 摘要增量不继续发布，已有可读片段标 interrupted；已正式发布气泡保留。未知结果的工具先对账，不从摘要“看上去完成了”推导成功。

路由 signal 进入 pending 时停止本 attempt 新增输出；批准/编辑绑定消息 hash/revision 和一次票据，新尝试有新 attempt_id。新摘要不接在旧段后，旧段保留归属和状态。任何自动唤醒不得绕过 gate。

换窗的新上下文不自动回灌 reasoning 表。原本 SDK resume 的协议继续态由 SDK 维护，不为了显示/不显示摘要删除其中签名。它与“新窗不额外注入UI摘要”的设计不矛盾。

异常、限额、网络失败、StopFailure 或进程退出由 supervisor/finalizer 有界收尾；可见原因不足时标 unknown，不伪装一般拒绝就是路由。恢复不调用模型重做一份摘要再标为原始结果。

## 8. 为什么不用 Stop/transcript 主采集

用户最新截图是一种 CLI 事后转发办法；不是假的，但不满足本项目实时需求。官方提示 transcript 异步落盘可能滞后；Stop 的 last_assistant_message 也不是完整思考块替代品。[T6]

本版 Stop 可用于不阻塞主流程的收尾诊断，不注册发送 Telegram 的脚本。未来独立外发若被要求，从已持久摘要投影投递，并有权限、去重、过期和分段；不从文件尾凭运气找“本轮”。这项没有被算作已经实现的产品功能。

## 9. 隔离和统计不可漏

reasoning 不进入 raw/archive outbox、Mariposa 普通检索、我们的话、自动 hold、I、默认 handoff、TTS 或默认推送。保留独立查看能力不改变“什么算说过的话”。不把摘要当工具命令执行，也不调用第二个模型润色。

签名和不可读内容不暴露；UI净化/脱敏后的展示文本不能回写 SDK 协议块。普通日志只记ID/状态/计数/必要hash，真实摘要留在受访问控制的内容库。

SDK实际提供用量才是统计依据。思考摘要显示长短不等于推理token消耗，omitted也不代表无消耗。独立思考token未提供就显示 unknown，不按字数猜并重复加到output统计。[T16]

## 10. 实现顺序与验收

先 build-options + capability probe + receipt；再用合成 SDK fixture 做 normalizer/reconciler/finalizer；再接持久流与前端；然后用授权的真实 SDK 请求证明至少一组可读增量和完整块行为，不能只依赖“复杂题大概会思考”的概率假设。

最后回归中断/错误/重连/路由/换窗，并验证摘要没有进原文、语音、通知和其他房间。所有配置与真实性测试需要锁版本证据，按 03 矩阵 CFG/BOOT/THINK 项执行；已有核心用例仍全部保留。

**本文件完成的是契约与实现路径，不包含已运行的应用代码或 Mac 实机结果。**

## 9. 前端输入与 SDK 流的边界

输入侧和输出侧不要共用“换行=发送/分句”的逻辑。用户 composer 的 Enter 永远产生换行（IME 合成阶段由输入法消费时除外），只有独立发送键会创建新的用户 message/turn。发送时把整个多行 draft 作为一条输入交给 SDK；换行属于正文，不预切成多条 prompt。

输出侧仍按本文件既有规则处理 `text_delta`、thinking 与工具事件。也就是说：**用户回车是输入正文结构，char输出中的分句是渲染/发布策略，两者是两个不同方向的状态机。** 任何实现都不得为了复用前端组件，把用户多行输入按 `\n` 拆成多条消息。

前端必须在 IME composition、实体键盘 Enter、移动端 Return、发送键快速连点、离线重试与编辑重发场景保持幂等。首版不提供 Cmd/Ctrl/Shift+Enter 发送快捷键；以后若增加，必须是显式用户设置，默认仍为独立发送键。
