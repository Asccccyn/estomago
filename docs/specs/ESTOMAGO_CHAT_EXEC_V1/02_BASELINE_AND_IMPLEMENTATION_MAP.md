# 02 · 源码基线与施工落点

核查时间：2026-10-11 Asia/Shanghai。
仓库：https://github.com/Asccccyn/estomago.git
分支：main
SHA：4971ebc8fda939a20ae8e6f04bc68a2c216a7ea1
提交时间：2026-10-10T13:21:03Z
本轮只读源码核查；未据README的历史测试数声称本包已验收，未连接生产或调用真实模型。

## 1. 已实现与缺口

| 事项 | 当前事实 | 施工动作 |
| --- | --- | --- |
| 驱动分离 | runtime/runner.ts按provider动态选OR/DS/SDK；OR实际fetch chat/completions | 复用，不因SDK新功能更换OR主路径 |
| OR缓存 | or-payload.ts明确1h，禁context-compression，append-only校验 | 保留，补真实发送起点/保温/异常观测 |
| SDK | 依赖锁0.3.283；装配未明确TTL/压缩开关；MCP映射器未装配 | 补最终options/env与版本能力验证；不从SDK包版本猜CC二进制 |
| 64k与人工选集 | API驱动已有受控换窗与选集；不应恢复旧6h/午夜/12k/DS日摘要 | 复用状态机；后台入口必须走同一门 |
| 消息HTTP | 发送只传字符串content；DTO媒体type名称存在但实际链不全 | additive附件DTO和事务；文本路径保持兼容 |
| 网页媒体 | app.js按textContent显示；无实际图片上传/播放链 | 增加附件渲染、上传和模型视觉装配 |
| Mariposa | client.ts实际HTTP /api/capability/{capability}；已有hold/recall等 | 保留现路径，不为MCP叫法重写 |
| 归档 | archive-sync.ts虽映射voice/sticker，但assets固定空数组 | 核真实资产合同，完整同步附件，不能伪称全归档 |
| 外部接口 | siren/superposition/zashidele只有配置位；oído等未见运行适配 | 真客户端、工具映射、健康/能力状态；未联调标unknown |
| 唤醒 | keeperEnabled=false；purpose名称有预留；wakeups死表v20已清退 | 新持久任务/run合同，不复活旧死表与旧隐式流程 |
| 用量UI | 有整轮usage显示与记录面板；无draft/每消息token预估 | 复用usage归一化，新纯估计模块，实际账本不混estimate |
| 系统异常 | 有事件/SSE/错误码；无独立持久系统通知中心 | 加一套system_alerts及每用户已读位置 |
| 内容功能 | 无完整calendar/albums/feed/creations业务 | 单可选content后端+统一前端，不塞入supervisor.ts |

## 2. 关键源码文件（相对仓库根）

| 现有文件 | 本包落点 |
| --- | --- |
| AGENTS.md；docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md | WP0核现行硬规则和本包明确替代条款 |
| apps/host/src/app-context.ts | 装配alerts、assets、scheduler、content/external adapters；启动/停止生命周期 |
| apps/host/src/server/http.ts | 新路由；沿现auth/Origin/SSE；拆出领域route函数控制长度 |
| apps/host/src/config/schema.ts；config/estomago.example.yaml | 新配置验证与唯一默认表；旧键退役披露 |
| apps/host/src/db/migrations.ts | additive迁移；版本号在施工HEAD后顺延，不能抢写固定v21 |
| packages/contracts/src/api.ts | attachments、preview、alerts与背景API DTO |
| apps/host/src/messages/service.ts | 附件与revision同事务；消息估计快照/旧revision不可改写 |
| apps/host/src/runtime/supervisor.ts | 调用共享estimator、dispatch admission、告警事件；不追加content业务 |
| apps/host/src/runtime/runner.ts | 共用请求生命周期hook/背景关联 |
| apps/host/src/runtime/runner-openrouter.ts；runner-deepseek.ts | 每次transport前admission、真实起点、每次retry同预算 |
| apps/host/src/runtime/build-options.ts；runner-claude-sdk.ts | 核SDK公开TTL/压缩控制、真实版本和最终参数；未验明的背景能力保持blocked，不承诺已经达到1h策略 |
| apps/host/src/runtime/sdk-event-normalizer.ts | compact_boundary显式识别与上报，usage继续记账 |
| apps/host/src/runtime/or-payload.ts；cache-plan.ts；window-trajectory.ts | 稳定媒体表示/前缀、缓存观测、重启恢复 |
| apps/host/src/context/manual-selection.ts；review-policy.ts；rotation-review.ts | 保持手选/hold自愿，所有新背景入口复用门 |
| apps/host/src/runtime/host-tools.ts | 新能力薄映射；schema稳定、按身份执行，不赋工程shell |
| apps/host/src/integrations/mariposa/client.ts；archive-sync.ts | 真实外部合同、原文与附件同步分别可观察 |
| apps/host/src/usage/collector.ts；runtime/or-contract.ts；server/records.ts | actual口径复用、分项未知、告警输入、background归属 |
| apps/host/src/events/service.ts | 警报/内容事件持久后SSE分发；去重与重放 |
| apps/web/src/app.js；index.html；style.css；composer-logic.js | 保留原生前端；抽出notifications/token-preview/media/calendar/feed视图 |

## 3. 可新增的最小模块（建议文件名，不允许重复职责）

- host/usage/estimator.ts：纯token估计；配置/模型版本化；无网络。
- host/observability/system-alerts.ts：系统通知持久化和聚合。
- host/media/assets.ts + host/server/media-routes.ts：文件、元数据、消息/内容引用。
- host/runtime/background-scheduler.ts + background-policy.ts：时间调度与纯门控。
- host/integrations/tools/：HTTP/MCP接线与工具结果规范化，避免另造插件市场。
- host/integrations/content/client.ts + server/content-routes.ts：薄代理，身份/资产校验，不保存内容正本。
- host/server/calendar-routes.ts：有界只读聚合。
- apps/content/src/：一个独立业务入口、数据库、posts/comments/albums/creations/future-notes服务。
- web新增JS按视图拆分；不要求新框架/打包器。

## 4. 这次必须顺手修准的四个事实

### 4.1 显示1h不等于SDK实际请求1h

server/records.ts把非DeepSeek都显示requestedTtl=1h，但SDK options没有对应设置。必须区分：
desired_ttl / effective_ttl / verification_state。
请求意图、最终发包和供应商真实观测不相互替代。

### 4.2 现onDispatch不是transport开始

runner-openrouter.ts的onDispatch位于await transport取得响应后；429/部分网络重试先continue，不进入这个回调。预算预占/消耗异常不能只统计现onDispatch。
新增transport前的admission与dispatch_started_at；保留既有“已发送/已见”证据语义，不能把预占记录直接当主模型已见原文。每次真实尝试可单独计量，cache刷新时点用经usage证实那次尝试的开始时间。

### 4.3 金额未知与token未知不能绑死

usage/collector.ts存在partial状态覆盖多项未知的分支。此次新增显示应按token字段、cost字段分别保留known subtotal、unknown count/flag；不能因供应商不报美元就把完整token也清空，更不能因token完整把cost补成0。

### 4.4 后台无turn也要计量与报警

现不少usage聚合从turn/attempt JOIN；新增background_runs可能没有用户消息turn。每次模型/付费工具尝试必须能从request/run找到conversation、purpose与day，防止后台费用从前台统计中消失。

## 5. 当前未核实的真实能力

- 用户Mac运行时provider、SDK/CC实际版本、OR账号强制插件/路由设置。
- Siren、oído、Antinomy、许愿星、扎西德勒、X/小红书在用户本机的最新可执行接口。
- Mariposa当前附件schema、月历批量聚合/分页接口，以及截图反查所需稳定our_words ID。
- 目标模型的图像输入/图片token估计、实时语音通道、真正手机离线推送。
- 未提供的情绪数值维度和具体游戏需求。

上述未知项不能成为猜测接口的理由。WP外部契约表须列expected/observed/status；可先做fake adapter合同与真实错误展示，不谎报外部已完成。

## 6. 基线变化处理

preflight与实际git状态是施工前检查，不是阻断后续一切工作的批准流程。HEAD变化后先读差异，重新定位相同职责，更新本包落点表，继续完成不冲突工作；存在真正语义冲突才提交给江乔生裁定。禁止因sha不同直接reset/覆盖，禁止引用历史zip的source替代新代码。

