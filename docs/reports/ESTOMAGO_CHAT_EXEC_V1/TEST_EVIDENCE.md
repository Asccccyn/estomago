# TEST_EVIDENCE · ESTOMAGO_CHAT_EXEC_V1

## 全量套件

```
npm test
# [test] 结束：94/94 个文件通过，0 失败
npm run typecheck
# tsc --noEmit（零错误）
```

## 按验收组

### BASE（WP0 基线）
- `tests/unit/exec-v1-wp0-base.test.ts` 3/3
  - BASE-01 源码合同核对（preflight BASELINE_MATCH@4971ebc）
  - BASE-02 旧配置升级（auto/keepwarm false/cap null/纯函数零网络）
  - BASE-03 fresh/升级/中断重启（正文 hash 与 revision 不变/幂等）

### ALERT/TOKEN/USAGE（WP1 消耗可见与 token）
- `tests/unit/exec-v1-wp1-alerts.test.ts` 6/6（已读≠恢复/新告警不被吞/乱序重放/正常关闭去重/隐私白名单/分页超限）
- `tests/unit/exec-v1-wp1-usage.test.ts` 5/5（stream/result 去重/字段独立/分类不双加/跨午夜/结算宽限）
- `tests/unit/exec-v1-wp1-estimator.test.ts` 4/4（码点口径/本条≠完整请求/图片 partial/音频不双计）
- `tests/unit/exec-v1-wp1-guard.test.ts` 1/1（慢回包三匹配守卫）
- `tests/integration/exec-v1-wp1-http.test.ts` 6/6（token-estimates 零副作用/快照/红点鉴权/TTL 三态）

### CACHE/CONTEXT（WP2 上下文与缓存）
- `tests/unit/exec-v1-wp2-cache.test.ts` 5/5（payload 合同/准入逐尝试/计时基准/温态门/compact 识别）
- `tests/unit/exec-v1-wp2-supervisor.test.ts` 3/3（429 重试账本/网络失败行/wire 证据）

### CHAT/MEDIA（WP3 媒体底座）
- `tests/integration/exec-v1-wp3-media.test.ts` 7/7（上传/幂等冲突/引用守卫/消息事务/编辑保留/HTTP 全链含 Range 与 If-Match）
- `tests/unit/exec-v1-wp3-model.test.ts` 6/6（payload 真实图字节/DB 零 Base64/视觉门双向/跨轮轨迹/语音门/工具幂等/选集媒体）

### BACKGROUND（WP4 有界后台）
- `tests/unit/exec-v1-wp4-background.test.ts` 9/9（冷却/保温目标/预算/状态机/重启/设置原子/调度器/抢占/occurrence）
- `tests/integration/exec-v1-wp4-http.test.ts` 3/3（422/409/428/任务 CRUD/提醒零模型投递/stop 语义）
- `tests/unit/exec-v1-wp4-executor.test.ts` 3/3（保温单请求+不推进轨迹/自主双请求同 run+noop/保温工具拒+取消拒派发）

### CONTENT/FEED/ALBUM/CREATION（WP5 内容后端）
- `tests/integration/exec-v1-wp5-content.test.ts` 8/8（双 actor/幂等回执/If-Match/删除语义/相册反查/作品/留言/模型工具）

### CALENDAR（WP6 日历）
- `tests/unit/exec-v1-wp6-calendar.test.ts` 5/5（半开区间/月天数/月概要不下载正文/日详情分页/外部源降级/提醒归属）

## 验收覆盖

114 条验收场景 → **82 PASS + 32 NOT_EXECUTED**
- NOT_EXECUTED 全部因外部合同未核验/跨服务场景需真实环境/浏览器 E2E——不是代码缺失
- 每条 NOT_EXECUTED 在 `ACCEPTANCE_EXECUTION.json` 记录了精确 blocked_dependency

## 既有测试保护

全部改动前 79 个测试文件 → 改动后 94 个（+15 新增），**零既有测试回退**。所有迁移 additive（v21-v26），旧消息/选集/轨迹/归档链全兼容。
