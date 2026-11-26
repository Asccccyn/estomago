# 相册整改交接协议（2026-11-09）

写给下一个接手的会话/代理。前置阅读顺序：本文件 → `docs/reports/album_execution_pack_20261108/`（v1.1 执行包全文，锁定需求 01/验收矩阵 06）→ `docs/reports/ALBUM_FINAL_RECEIPT_20261108.md`（首轮施工回执）→ 最新复审报告（用户目录 `Documents/Codex/2026-11-08/files-pasted-by-the-user-codex/outputs/`，按时间取最新）。README.md 顶部批次索引是全部提交的入口。

## 0. 铁律（违反过，写进长期记忆的）

1. **真实付费调用/真实凭据请求逐次问**，宣布计划≠授权；免费的真实请求也要问。
2. **测试/冒烟数据禁入生产库**。验证用离线夹具+独立 ESTOMAGO_HOME；生产只读；要写必须逐次授权。
3. **重启/部署逐次授权**，批一次不算下次。siren 仓由另一窗口维护基线，不碰。
4. 多路代理并行：提交前 `git status`+`git log -3`，只 add 自己的文件；home 前端（apps/web/src/home、home-assets.ts）是并行代理地盘；两测试文件 `home-butterfly-renderer/home-cords` 的失败是它 WIP 缺文件，与本线无关。

## 1. 当前状态快照（2026-11-09 凌晨）

**生产运行**：E host+content=`album-master-b78b170`，M=`album-master-37a94be`（venv=`~/Data/mariposa/venv-album-p2a`），embedding=`audit-fix-20261108-70c7609`。M 首页 **503**（release 已补 dist 文件但静态挂载需重启）。

**仓库领先生产**（都已全量测试绿、未部署）：
- E：`8e37a09`(R2/R3/R4/R7)、`531a4ae`(R6门槛/R8)、`66b8a20` 及文档
- M：`df509bf`(R1: conversation.get 附 attachments_meta + App.tsx TS 修复)、`8420588`(合同 R9)。dist 已复制进在线 release 目录（`album-master-37a94be/frontend/dist`，11-09 01:36 构建）但未重启未生效。
- M 生产 DB：estomago_builtin 白名单已含 `media.*`+`source.search`（热更过，备份在 mariposa/scripts/allowlist-backup-*.json）。
- E 生产 DB：schema v69；61 资产全 synced（含语音 23 条），E 本地媒体文件≈0（M 唯一正本+按需缓存）。

**待授权的生产操作**（按序）：
1. 重启 M（kickstart mariposa-runtime）→ 503 消失、R1 数据接线生效、R9 无关运行时。
2. E 部署：`make-release.sh HEAD album-r5` + start.sh/content plist 切换 + 重启 host/content（content plist 也要指新 release，bootout/bootstrap）。
3. 部署后建议跑一遍只读冒烟：carry-set、archives、首页 200、语音回源（node 一次性脚本见 git 历史里多次用过的方式，勿写库除 cache 重建）。

## 2. 剩余工作（复审 R5/R6 完整清单）

复审报告：`ALBUM_FULL_AUDIT.md` 的 R5（四入口动作）/R6（存档闭环）两节是需求正本，位置和反例都在里面。要点与实施建议：

### R5 四入口动作（纯 E 仓）
- **聊天图片收藏**：AlbumPanel 的 photos 空态文案已承诺"多选可收藏"但没有 handler。最小实现：聊天图片消息长按/菜单加"收藏到我们的相册"→ `POST /api/v1/content/albums/important_photos/entries {asset_id, caption?}`（经 host 代理 `/api/v1/content/...`，带 Idempotency-Key）。
- **表情上传归类**：➕ 菜单上传文件时增加"作为表情包"选项（或面板 stickers 标签内上传按钮）→ 上传 `POST /api/v1/assets?purpose=chat_sticker` 后建 stickers 条目。
- **作品入表情**：creations 卡片加"加入表情包"按钮（同 entries 接口 kind=stickers）。
- **模型写工具**：`apps/host/src/modules/content/module.ts` 现有读工具；补 `content_album_entry_write`（收藏/归类/携带模式一体：kind+asset_id+caption+carry_mode），走既有 ContentWriteService。
- **creation_save_artifact 自动入作品**：`modules/content/service.ts` 保存后补 creations 条目（imagegen/service.ts 已有同款免桶写法可抄）。
- 非图片作品打开链接（现只有文字提示）：work_kind svg/html → `/api/v1/assets/:id/preview`（沙箱端点已存在）。
- 注意：前端改动后 `npm --prefix apps/web/react run build`，dist 一起提交。

### R6 存档闭环剩余（E+M 两仓）
- **M 双标记+反查**（R31/A44）：M 原文页消息显示"已存档"（含类型）与"已绑定记忆"两个独立标记。数据源：E 侧 content 是正本——需要 M 读 content 只读投影或 E 推送。建议最小：E 在存档成功后经 `source.attachments.sync`(kind=observation) 附加存档事实，M 前端渲染标记（附件元数据链路 ALB-03 同款已通）。
- **无 PNG 存档总览**（A65）：M 媒体总览页列存档条目。数据同上投影。
- **封存精确化**：现为"命中任一 source_ref 整包扣留"（supervisor.ts 搜 `surfacing_suppressed_quarrel`）。要逐项：冻结 text/items 一体导致不能删项——可改为"命中项占比"或让 M 侧 surfacing 作业请求时带上排除集（M surfacing/candidates.py 已有 blocked refs 机制 `normalized_blocked_refs`，可把 quarrel sm 集随请求传入）。另：>100 存档分页、默认携带材料过滤、content 不可达时的降级语义。
- **存档打开链**：archives 详情返回 messages 引用，前端/M 端"打开原文"→ 经 `source.message.get`（M）或 E 会话跳转。UI 侧最小：AlbumPanel 存档卡片点开列出 message_id 对应正文（E 库可查，走新只读端点）。
- **同图多条留言**（R2 残余）：carry-images.ts 规划器现只保留第一条相册留言；执行包 03 §7.2 要求全部原话保留。改 planCarryImages 的 entry 结构为留言数组，片段文本逐条列出。

### 已知工程陷阱（都踩过）
- **工具目录底座标定**：每加一个模型工具，四个换窗夹具软线要重标定（or-rotation 14.8k、remediation×2、context-rotation-root/joint-audit-b2/wp3/wp7 24.8k——grep `soft_limit_tokens`），且三个 golden 要按序再生成：`export-tool-package.mjs /tmp/tp --update-golden` → `ESTOMAGO_UPDATE_GOLDEN=1` 跑 module-contract-session-snapshot + envelope-golden-baseline → frozen-tool-package.test.ts 计数 49→51→53/54 手改四处。
- **.mjs 脚本禁 TS 断言**（`as`），跑之前 `node --check` 或直接执行验证。
- `docs/reports/` 被 .gitignore 的 `reports/` 误伤，add 要 `-f`。
- 测试隔离：共享 content server 的用例跨测试可见，建档类测试用独立 conversation。
- M pytest 必须带隔离 `MARIPOSA_ROOT=/private/tmp/...`（白名单校验拒绝业务根）；scripts/export_contracts.py 同理。
- golden 的 `ESTOMAGO_UPDATE_GOLDEN=1` 开关是显式重建用，重建后必须无开关复跑确认。

## 3. 提交历史（本线全部）

P2a `7e9f8ea`→脚本修 `83124a5`→P3携带 `9db2dba`→P5携图 `b4a2364`→P4存档 `3ba33bc`→P3生图 `62e4384`→整改1批 `f8c6739`→2批 `a8f9af3`→3批 `0ec2641/78a099c/9940fd7`→语音进M `42b09da`→复审修 `8e37a09/531a4ae`。M：`e3ad5c5/0cde74f/bc025a6/d21908a/37a94be/df509bf/8420588`。

## 4. 验收状态基线

复审（2026-11-09）判定：ALB-01/06/12 关闭；ALB-02 历史事实保留；ALB-03 部分（R1 代码完）；ALB-05 主修+R8 已补；ALB-07 R2 已接线（待部署复审验证）；ALB-08 主反例过；ALB-11 R4 已修（待复审）；ALB-13 R7 已修（待复审）。R5/R6 上述清单未动。最终验收=用户指定的 17 场景 + 执行包 06 矩阵，须真实用户路径，不得以测试绿替代。
