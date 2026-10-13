# 原 React 组件接入 · 2026-10-13

## 来源与范围

以用户最初下载、修改前备份中的 App.tsx / index.css，以及原 main.tsx 为起点。原稿保存在会话工作区的「聊天前端设计-修改前备份.zip」；文件哈希、组件清单和样式差异记录在 apps/web/react/SOURCE_PROVENANCE.json。

本次按用户明确指令使用 React，替换前两批原生 HTML/JS 改写。没有再用原生 DOM 重画组件。

## 生产路径

- 源码：apps/web/react/src/App.tsx。
- 原组件：DotSpinner、IconBtn、Thinking、EffortSlider、VoiceBar、Sheet、Media、App。
- 数据与接口：chat-client.ts、useEstomago.ts。手机适配：useMobileChat.ts。
- 构建：React + 原依赖范围的 Vite/Tailwind/Lucide；锁定安装记录在独立 package-lock.json。
- 发布：apps/web/dist/index.html、chat-app.js、chat-app.css，由已有 estómago HTTP 服务提供。
- 删除旧原生 app.js/index.html/style.css；旧 URL 的 app.js/style.css 仅兼容指向 React 构建，不能再运行旧改写页面。登录页及认证继续使用原实现。

开发构建：先在 apps/web/react 运行 npm ci，再从仓库根执行 npm run build:web；检查为 npm run typecheck:web 和 npm run typecheck。发布静态构建随代码保存，服务启动无需在生产现场临时打包。

## 原稿保留核对

- 原稿 93 组不同的固定 className 中，89 组逐字保留。
- 4 组变化仅涉及手机可见视口、可伸缩输入容器、多行输入和已确认的发送圆圈。
- 移除手机适配规则后，index.css 与原稿逐字一致。
- DotSpinner 和 IconBtn 函数逐字一致；其余原组件修改仅为真实数据、事件和媒体播放接线，主体 JSX/样式沿用原稿。
- 图标横向间距 27px；橘色发送圆圈 28px。
- 清除 initial 演示消息、固定 WORKBENCH/ACTIVITY、假回复、假语音转写、固定缓存命中率及上下文数字。
- 真实协议新增状态（上传失败/重试、历史确认、路由处理、系统提醒）独立处理，不用演示数据模拟成功。

## 功能与验证

保持原组件下的真实收发、IME/多行输入、幂等重试、草稿保护、消息修订、SSE 去重与思考摘要、上下文、模型/档位、原工作台/活动日志、附件和语音。整轮实际用量在日志中按真实账本展示，不摊成每条消息的实际消耗。

- React 与宿主类型检查、构建通过。
- 最新单元批次 84/84；完整运行中的合同批次 3/3；最终 HTTP 批次 12/12。
- 完整运行曾在上海午夜触发原 R18 测试的日期夹具错误；仅将该测试冻结到固定上海时间，未修改费用业务实现。
- 最终隔离浏览器 13 项通过，直接确认 React root、原组件、模型滑块、媒体播放、真实 HTTP 数据链、手机可见区域及尺寸。
- 使用独立临时 ESTOMAGO_HOME、mock Host 和本地模拟 ASR，无真实外部模型/语音调用。
- 实际 iPhone Safari 键盘仍未实机测量；浏览器使用可见视口模拟。

## 保持的边界

此次不再清空或填充生产对话，不改密码、身份、凭据、隧道或网络配置。Siren 实际可用性仍由现有服务配置决定；实时通话和戳一戳没有既有接口时，原图标给出未接入提示，不伪造成功。

## 上线核对

主项目功能提交 b9ae2ad 已通过既有 LaunchAgent 重载。只读检查确认线上根页面为 React root，并加载 chat-app.js；线上 JS/CSS 字节与隔离验证的构建一致。旧 apps/web/src/app.js 不再存在。主项目已从本地缓存安装锁定的前端依赖，后续可直接重新构建。
