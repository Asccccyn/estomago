# DEPLOYMENT_NOTES · ESTOMAGO_CHAT_EXEC_V1

## 进程与端口

| 进程 | 端口 | 说明 |
|---|---|---|
| est（主进程） | 18787（默认） | 聊天/认证/模型/资产/调度/薄代理/日历 |
| apps/content（可选） | 18788（默认） | 内容后端——独立 SQLite/loopback/服务凭据 |

## 启动

### est
```bash
# 已有 LaunchAgent（com.charstarearth.estomago）
# 更新代码后：launchctl kickstart -k gui/$(id -u)/com.charstarearth.estomago
```

### content（新进程）
```bash
# 方式一：手动启动（测试/联调）
ESTOMAGO_HOME="$HOME/Library/Application Support/estomago" \
  node --experimental-strip-types \
  -e "import {ContentServer} from './apps/content/src/service.ts'; \
      const s = new ContentServer({stateRoot: process.env.ESTOMAGO_HOME + '/content', port: 18788}); \
      await s.start(); console.log('content:', s.port);"

# 方式二：LaunchAgent（生产——待她批后创建）
```

## 配置新增项（estomago.example.yaml 已更新）

```yaml
background:
  autonomous:
    enabled: false        # 自主活动（默认关）
    daily_cost_cap_usd: null  # null=未配置（不许花钱）
  keepwarm:
    enabled: false        # 缓存保温（默认关）
    daily_cost_cap_usd: null
  reminders:
    enabled: true         # 普通提醒（默认开——不花钱）

content:
  enabled: false          # 内容后端（默认关——代码完整后本地联调可开）
  port: 18788

system_alerts:
  usage_settlement_grace_ms: 60000
  summary_refresh_debounce_ms: 1000

token_estimates:
  debounce_ms: 250
  max_body_bytes: 524288

media:
  max_image_bytes: 20971520    # 20 MiB
  max_audio_bytes: 33554432    # 32 MiB
  max_code_artifact_bytes: 262144  # 256 KiB
  import_timeout_ms: 30000
  max_redirects: 3
```

## 运行时设置（配置文件外的持久正本）

```bash
# 后台设置（三开关+预算）——存 runtime_settings 表
curl -X PUT http://127.0.0.1:18787/api/v1/background/settings \
  -H "If-Match: \"<revision>\"" -H "Idempotency-Key: <key>" \
  -d '{"autonomous": {"enabled": true, "daily_cost_cap_usd": 5}}'

# 模型价格（开后台付费前置条件）——存 runtime_settings 表
# 需直接写 runtime_settings：INSERT OR REPLACE INTO runtime_settings(key, value) VALUES ('or_model_price', '{"input_micro_per_token": 0.000003, "output_micro_per_token": 0.000015}')
```

## 备份与恢复

- **est DB**：`npm run backup`（已有——SQLite VACUUM INTO 一致性快照）
- **content DB**：同目录下 content.sqlite3——沿用同一脚本或 `sqlite3 content.sqlite3 "VACUUM INTO 'backup.sqlite3'"`
- **媒体文件**：$ESTOMAGO_HOME/media/——文件复制（只读引用，不锁）
- **恢复**：`npm run restore`（已有——覆盖前自动暂停写入）

## 权限与费用字段

| 新增权限 | 说明 |
|---|---|
| 媒体上传 | POST /api/v1/assets（est 会话认证） |
| 内容读/写 | /api/v1/content/*（est 代理→content 服务凭据+X-Actor） |
| 系统告警 | GET/POST（只读+已读标记——浏览器不能创建/恢复告警） |
| 后台设置 | PUT（If-Match+Idempotency-Key；422 门=预算/价格/执行器） |
| 日历 | GET 只读（零外部请求不触发 memory_open/拆星） |

## 安全注意事项

1. content 进程仅 loopback——不能从外网访问
2. 服务凭据在 $ESTOMAGO_HOME/content/service.token——不进 Git/日志/前端
3. X-Actor 头由 est 生成——前端不能伪造（est 代理会覆盖）
4. SVG 禁内嵌 script（creation_save_artifact 校验）；HTML 走 CSP sandbox 预览
5. URL 导入限 https+公网+DNS 锁定+逐跳重查——拒绝内网/云元数据/凭据 URL

## 已完成 vs 待真实环境执行

| 项 | 状态 |
|---|---|
| 代码+离线测试 | ✅ 94/94 全绿 |
| est 生产重启 | 待她批（新迁移 v21-v26 additive 不会破坏旧数据） |
| content 进程部署 | 待她批（默认关——批准后 enabled: true + LaunchAgent） |
| Mariposa/Siren/其他外部合同联调 | 待各自服务可达时逐项核验 |
| 真实付费模型调用 | 待她配置 or_model_price 后才可能发生 |
