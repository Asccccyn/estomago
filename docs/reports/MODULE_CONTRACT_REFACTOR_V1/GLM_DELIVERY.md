# GLM_DELIVERY（实现摘要 · 审计指令 7 批次后冻结候选）

> 冻结候选：代码状态=`refactor/module-contract-v1` 分支本报告父提交（完整 SHA 见 RESUME 顶部与最终交付消息）；本报告提交只含文档/证据。前次统一冻结（e502427 代码 / 4dfa709 报告）之后，按实施者审计指令完成 7 个批次；每批次一笔提交，可按 git log 追溯。

## 7 个批次做了什么（回答"修复了什么根因、删除了什么旧路径"）

1. **批次 1（e4d48ba）——修复电话准备阶段取消失效**。根因=断线监听安装太晚+`req.close` 被一律当取消。修复：幂等接纳后、首次音频异步前建 AbortController/res.close(!writableEnded) 取消处理；信号贯穿 SirenAdapter.fetchVoiceAssetAudio（合并父取消与原超时）、quickVoiceObservation ingest/analyze；ingest 回执先保留再查取消；取消收口 voice_stream_turns=cancelled+已有 turn 才 stop，不新建取消轮/不结束 voice_calls；取消不被降级 catch 吞。复现迁入正式测试目录（tests/integration/codex-voice-preparation-disconnect.test.ts），修复前失败/修复后通过证据见 TEST_EVIDENCE/evidence/。
2. **批次 2（78e3cbf）——投影正本唯一化**。modelResult/candidates 助手删除，正本=modules/memory/projection.ts 与 modules/conversation/projection.ts；model-wire-measurement 补具体输出断言（含下一模型请求 tool 内容）；invite-reaction 经 voice 模块 ProgramFactsPort 绑定真实 Supervisor（setSupervisorRef 删除）。
3. **批次 3（21f2725）——Registry 单一来源**。definition:()=>HostToolSpec 工厂（不提前求值）；currentCatalog() 按 baselineOrder；BASELINE_TOOL_ORDER/域聚合/hostToolsCache/失效回调/MEMORY_ONLY_TOOLS/TOOL_LABELS/SILENT_TOOLS/业务免费名单全删；owner 显式；D39 资格判定 catalog/define/invoke/最终执行同一处；费用=模块声明 free 资格，discovery 免费政策归 discovery。
4. **批次 4（72416b6+2dacbc9+47c8c17 收尾）——身份只走可信 ctx**。args 写入/转发/回填 `__tool_call_id` 全删；校验器特殊放行删；memory/oído handler 从 ctx 读；操作键派生序（es-hold…es-an）逐一保持；Supervisor unknown 恢复改注入 memory 窄恢复端口；runtime/host-tools.ts 最终 `git rm`（19 处消费者全部迁移；HOLD_*/类型改指正本）；wireOidoCapabilitiesForTest 删除（assembleTestTools 显式装配）。
5. **批次 5（47c8c17）——生命周期兼容删+HTTP 导入叶**。MessageService 只接受通用 MessageLifecycleHooks；SurfacingMessageHooks/legacyCompatView/旧形状判别/surfacing 兼容字段删除；bindMessageLifecycle 装配形状守卫（误传裸服务大声失败）；notifyAfterEditCommit→afterCommit；听觉可用判断迁 application/voice-hearing-port.ts；json/readJson/ClientBodyError 迁 server/http-leaf.ts（http.ts 与 routes/voice-call.ts 同向依赖）；readJson 未使用参数清理；无动态 import 藏环。
6. **批次 6（036b401）——演练收尾**。手工 INSERT legacy 窗口/手工塞目录 direct execute 捷径保持删除；演练A26/A03 全链=旧窗冻结证据→仅测试装配注册 probe→旧窗原目录→正常入口新窗→fake 模型 catalog→define→invoke→probe 返回进下一模型请求；演练A27=absent（未发布语音）bound:false 如实进 tool 消息+仅测试消费者经 memory 公共只读方法（memoryIRead）组合成立+正常文字消息→真实 Supervisor→fake 模型→正式发布；probe 只拿窄结构端口（PublishedVoiceReader/MemoryPublicRead），不复制授权 SQL/业务逻辑。
7. **批次 7（本笔）——终验证**。统一回归暴露 18 个测试装配过时（b453cc9 修复，无生产行为改动），随后全量 188 文件回归通过（数字见 TEST_EVIDENCE）。

## 实现摘要（当前形态）

- 能力执行唯一路径：48 业务工具全部经 capabilities/registry（显式登记/重复名拒绝/baselineOrder）→ executor（取消→通话 memory_only 门→冻结 schema 校验→背景准入→handler→唯一投影）。旧分支/allowlist 名单/外层投影/全局 tool_call_id 桥已删除。
- 域模块 10 个：oido(6+生命周期)/voice(2)/memory(14+词表+hold 契约+投影)/conversation(3+投影)/wishstar(13)/content(4)/wake(2)/media(2)/identity(1)/context-review(1)。定义/handler/投影/费用/资格/label 随 owner；runtime/host-tools.ts 已不存在。
- 消息生命周期：messages/lifecycle.ts 通用事实+inTx/afterCommit；application/message-lifecycle 装配浮现消费者（形状守卫）；兼容层零残留。
- 等价基线：tests/golden/tool-catalog-baseline.json（sha256 770e9fef… 恒定）+ module-contract-session-baseline.json（wire 逐字）双 golden 通过。

## 测试结论（OFFLINE_CONTRACT；未调用真实 Opus/OR/JEV/ASR/TTS/embedding/Mariposa/oído/Siren）

全量 188/188 文件通过（退出码 0）；29/29 验收项 PASS（证据均为离线合同，A12 内"排队取消"与"准备阶段断线"两件事分开陈述）。未执行：真实收费/生产部署。

## 无生产操作声明

未部署生产、未改生产配置/数据库/LaunchAgent/凭据/隧道；未读取生产聊天；源树（integration-20261024 与主 checkout）只读，两项未提交 dist 产物未清理未卷入。本轮唯一环境操作=在 worktree 的 apps/web/react 安装 node_modules（46 包，untracked，前端源码零改动）。

## 如何复核

按 TEST_EVIDENCE 命令复跑全量回归；重点核对批次 1 修复前失败证据（evidence/batch1-before-fix-4dfa709.log，可在 4dfa709 上重放）、双 golden 逐字、08 号五问与 06 号红线。实施者不签署"独立通过"——独立复核由 GLM5.3 与 Astra 执行。
