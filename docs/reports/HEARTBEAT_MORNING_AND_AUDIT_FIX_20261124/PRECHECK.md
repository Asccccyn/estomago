# 心跳晨间唤醒、抽卡活动记录与 12 项审计修复：实施前核查（2026-11-24）

## 1. 仓库与工作树事实
- **目标仓库**：`/Users/owner/Projects/estomago`，分支 `unified-main-20261102`，基线提交 `7ad961f`，Host schema `v91`，Content schema `v9`。
- **保护项**：
  - `README.md` 存在宿主用户本人 2 行未提交改动（`git diff README.md` 第 68 行附近），全程保留且不混入本批暂存。
  - `stash@{0}`（`preserve daytime subset before unify`）全程不动。
  - `/Users/owner/Projects/mariposa`（分支 `main`，HEAD `9cf41b9` 及 5 份 `allowlist-backup-*.json`）全程只读核查、零修改。
- **范围边界**：本批只做本地代码修复、隔离验证、前端产物重建与选择性 Git 提交，不执行切生产、重启服务、`git push`、付费外呼或历史数据清理。

## 2. 现有代码路径与拟改原所有者映射
1. **上海 08:00 晨间唤醒与 07:11 起自动顺延（执行稿二、五、六）**
   - 活动与排程：`apps/host/src/runtime/wake-activity.ts`（`ConversationActivityService`）、`apps/host/src/runtime/background-scheduler.ts`（`BackgroundScheduler`）、`apps/host/src/runtime/background-keepwarm-gate.ts`（`keepwarmDispatchGate`）。
   - 执行与收口：`apps/host/src/application/background-execution.ts`、`apps/host/src/runtime/supervisor.ts`（`runBackgroundTurn` / `keepwarmHold` / `heartbeatSpeechHold`）、`apps/host/src/runtime/background-outcome.ts`（`classifyBackgroundOutcome`）、`apps/host/src/modules/heartbeat/runtime.ts`（`begin` / `commitInTx`）、`apps/host/src/modules/heartbeat/service.ts`（`heartbeatPromptClock`）。
   - 状态接口与展示：`apps/host/src/server/routes/background.ts`（`GET /api/v1/background/settings`）、`apps/web/react/src/background-controls-model.ts`（`keepwarmStatusText`）、`apps/web/react/src/ContentManagementPage.tsx`（`HeartbeatStatus`）。
   - 核心设计：沿用单一 `bgt_keepwarm_system` 任务与共享预算/串行锁；晨间机会以稳定 `occurrence_key = morning-wake:<conversationId>:<businessDate>` 表达当日唯一身份；从 `07:11:00` 起按真实前台消息（`turns.trigger = user_message` 的 owner 接受时间与 assistant 正式发布时间）递推顺延至 `max(08:00:00, chatAt + 50m)`；迟到宽限按最新有效晨间目标核对；跨夜冷缓存与前夜 `resting = 1` 放行当日一次晨间唤醒且不清除 `resting`；晨间自身发言/派发/回执不滚出下一轮 50 分钟唤醒。

2. **在途异步工具与卡面派发跨 23:00 / 停止条件复核（审计 #1、#2）**
   - 审计 #1：`apps/host/src/capabilities/contracts.ts`（`ToolExecContext.canPublishToChat`）、`apps/host/src/runtime/supervisor.ts`、`apps/host/src/modules/voice/voice-send.ts`（`publishSavedVoice`）、`apps/host/src/modules/imagegen/service.ts`（`deliverSaved`）、`apps/host/src/modules/conversation/service.ts`（`chatSendText` / `chatSendAttachment`）。
   - 审计 #2：`apps/host/src/runtime/supervisor.ts`（`admitHeartbeatDispatch`）与 `apps/host/src/modules/heartbeat/runtime.ts`（`beforeDispatch`），在异步 `sources.resolve` 返回后、`startDispatch` 前复核睡眠窗/休息/总开关/让位/取消，拦截时记 `not_dispatched` 并归零释放预占。

3. **晚安与恢复意图误判/漏判（审计 #3）**
   - 原所有者：`apps/host/src/runtime/conversation-rest.ts`（`detectRestIntent`）。保留子句问号与疑问语气词以排除“我们睡吧？”，拦截“不想说晚安”等否定表达与“宝宝睡了，我们轻声聊”等第三人称/继续聊天语境，放行“我已经醒了”恢复休息。

4. **`heartbeat_draw` 默认常驻与剩余号码一致性、普通聊天抽卡复核与预留留言图片（执行稿四；审计 #4、#5、#6、#7）**
   - 审计 #4：`apps/host/src/runtime/tool-resident-guides.ts`、`apps/host/src/runtime/tool-initial-visible.ts`、`apps/host/src/modules/heartbeat/runtime.ts`，同步更新工具目录/会话/信封黄金基线与容量常量。
   - 审计 #5：`apps/host/src/modules/heartbeat/runtime.ts`（`beforeChatDispatch` 复用 `beforeDispatch` 的固定修订、`guardSourceMutation`、待删检查与 `startDispatch` 返回值核对）及 `apps/host/src/runtime/supervisor.ts`。
   - 审计 #6：`apps/host/src/runtime/supervisor.ts`（OR/SDK 两处 `readImage` 传入聊天 `turnId`）、`apps/host/src/modules/heartbeat/runtime.ts`（`readImage` 历史查询兼容 `turns`，`closeChatRound` 与 `recoverClosedRuns` 清理 `liveImages`）。
   - 审计 #7：`apps/host/src/capabilities/model-bridge.ts`（`withDeckNumbers` 接入带 `sourceEnabled` 的 `HeartbeatRuntime.cards`）与 `apps/host/src/app-context.ts`。

5. **揭牌后多段聊天按序收录与 `firstReservedReplay` 边界对齐（执行稿三；审计 #8）**
   - 原所有者：`apps/host/src/runtime/supervisor.ts`（工具轮前与续轮揭牌确认前刷出 `TextSegmenter` 缓冲，使揭牌前与揭牌后自然回复落入同一稳定气泡的不同修订）、`packages/contracts/src/heartbeat.ts`（扩展可选码点切片列表 `speech` / `reservedReplySlices`，保持旧 `messages` 只含整条无揭牌前混入消息以防旧读者误扩整泡）、`apps/host/src/modules/heartbeat/runtime.ts`（`projectChatRound` / `commitInTx`）、`apps/host/src/server/routes/content-moments.ts`（`displayReference`）、`apps/host/src/modules/heartbeat/sources.ts`（`firstReservedReplay`）。

6. **存档展开原文 404、多附件落正预校验与边界报告、朋友圈来源编辑暂存落正及编辑器清理、相册直传响应体超时（审计 #9、#10、#11、#12）**
   - 审计 #9：`apps/host/src/server/http.ts` 外层路由补匹配 `GET /api/v1/archives/:id/messages`。
   - 审计 #10：核实 `mariposa/backend/mariposa/media/service.py` 仅提供单 token `prepare -> stage -> finalize` 且无删除接口；在 `apps/host/src/server/routes/conversations.ts`、`apps/host/src/server/routes/content.ts`、`apps/host/src/server/routes/content-moments.ts` 统一先全量本地预校验再调用 `commitStagedAssets`，保留同批次重试跳过已 `synced` 项；不擅改 E/M 持久合同，不在报告中标为彻底修完，单列最小方案供宿主用户与林石见裁定。
   - 审计 #11：`apps/host/src/server/routes/content-moments.ts`（`PUT /api/v1/content/moment-references/:id/blocks/card` 在重放检查后、新写入前 `commitStagedAssets`）与 `apps/web/react/src/ContentManagementPage.tsx`（草稿移除/取消时仅清理本次会话新上传的暂存附件，保护既有已发布附件）。
   - 审计 #12：`apps/web/react/src/album-upload.ts` 统一用同一截止时间覆盖响应头与响应体读取，区分超时/响应体中断（结果未知，保留原操作键）与完整错误回执。
