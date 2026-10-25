# P07 · HTTP装配与模块启停


## 目标
消除HTTP和组合根里的业务硬接线，保证模块真实start/stop、前端与模型使用同一服务，不改变现有UI/API。

## 子步骤
P07.1 逐段记录server/http现有路由匹配顺序、认证、body上限、错误响应、SSE/NDJSON处理。先选oído/voice组迁到server/routes/对应handler，保持实际路径/method/响应和outer guard。
P07.2 按memory/context、background、content/wishstar等已有路由组迁移，处理器只调对应公共用例。总入口注册表不能由模块跳过认证；通配匹配不能抢占特定路径。
P07.3 HTTP和工具入口不同身份/交互语义继续区分，但底层同一领域方法；不能为了复用，让用户HTTP管理行为伪装成模型tool_call或要求先tool_define。
P07.4 app-context仅负责实例/窄依赖/静态模块清单/启动关闭顺序。允许几行显式连接，不允许在里面执行Siren建呼或写多步后台业务。
P07.5 模块生命周期覆盖oído delete retry、surfacing worker、背景调度，保留当前取消/停止边界。每个定时器一处owner，Host.stop反向停止；不加“新模块register时自动后台跑”副作用。
P07.6 前端既有组件API原则上不变。代码需要改时只调整导入/端点接线或缺失状态显示，不能重做页面。手机重连/停止/迟到结果使用既有代际与请求生命周期，不因模块重装重复订阅。
P07.7 从Host.create/start真实跑隔离 fixture 服务，确认模块服务启动、路由可达、取消关闭后无新增工作。不能只new单个handler证明集成。

## 验证
相同HTTP请求迁移前后响应对照；普通SSE重连；语音入口与停止；模块未配置时明确不可用但文字服务正常；start/stop各一次无重复timer。前端如有改动typecheck并构建自己的dist，不覆盖来源树未提交文件。


## 本卡统一退出记录

写明：起始SHA → 本卡提交；实际改动符号；与原行为对照；定向测试命令/退出码；未做部分；下一卡。
本卡PASS不自动使整个专项PASS。模型不可为“让本卡通过”改变01的裁定。
