# 相册重构 P0/P1/P2a 执行报告（GLM_ALBUM_REFACTOR_EXECUTION 20261108）

执行者：ZCode（GLM）；日期：2026-11-08。依据执行包 v1.1（滚窗语义修正版）。
本报告只声明已核实的事实；P2 后续与 P3–P6 未在本轮开工，逐条见 §5。

## 1. 基线（R01）

| 组件 | 提交 / 运行位置 | 状态 |
|---|---|---|
| E（estomago） | HEAD `0863105`（分支 unified-main-20261102，与 origin ahead 123/behind 120 为既有状态） | 工作树干净后施工 |
| E host 生产进程 | release `audit-fix-20261108-70c7609`（PID 13820，cwd=release） | 与 HEAD 仅差 release 检出制造脚本提交 |
| content 生产进程 | release `audit-r2-20261107-e762ff2`（PID 59016） | `e762ff2..70c7609` 无 apps/content 改动，无滞后 |
| M（mariposa） | HEAD `877dfbf`（main）；生产跑 `mariposa-releases/audit-fix-20261108-877dfbf`，MARIPOSA_ROOT=`~/Data/mariposa` | 一致 |
| media-embedding | 原直接跑开发树 `~/Projects/estomago/services/media-embedding/worker.py`（PID 27468，2026-11-02 起） | **本轮已切换，见 §2** |

已知偏差（记录，不在本轮处置）：运行中的 M 使用开发树 `.venv`（代码在 release）；E 分支与远端的 ahead/behind 既有分叉。

## 2. P0：media-embedding 固定 release 化（已完成，真实生产切换）

- **0.2 取证**：旧进程唯一开发树依赖=脚本路径+cwd（lsof 证实无 import/.pth/editable 回指；venv=`~/Data/media-embedding/venv`、HF cache=`~/Data/media-embedding/hf-cache` 均在 Data 区）。无文件监听/自动 reload/重复守护进程；单一 LaunchAgent。
- **0.3 release**：复用既有全量 release `estomago-releases/audit-fix-20261108-70c7609`；其 `services/media-embedding/worker.py` 与开发树 HEAD/70c7609 三处 sha256 一致（`9b3353cc…a149c`），70c7609→HEAD 对 services/ 零改动。release 副本离线合同测试 6/6 通过（fake 后端）。
- **0.4 切换**（执行包 00 明确授权的单服务切换；仅本服务，未动 host/content/M/tunnel）：
  - 旧 plist 备份 `com.charstarearth.media-embedding.plist.bak-20261108-devtree`（回滚=换回+bootout/bootstrap）。
  - plist 的 ProgramArguments/WorkingDirectory 指向 release；`launchctl bootout`+`bootstrap`。
- **0.5 验证**：
  1. 新进程 PID 26651，argv/cwd 均为 release 路径；旧实例 27468 已退出（ps 证实仅一个 worker）。
  2. `/health` ok；指纹与切换前逐字节一致：`google/embeddinggemma-2|rev=914f7f89142e33e77833254d9c9b90c3cef7303b|profile=text-image|preprocess=st-search-query-v1|dims=768|norm=l2`（权重/预处理/维数零变化，未升级模型）。
  3. 生产 token 真实调用 `/v1/embed`：文本（"char 相册 验证"）+ 合法 4×4 PNG → 各返回 768 维 L2 归一化有限向量；无远端付费请求。E 调用方（`apps/host/src/media/index/service.ts`）默认 `127.0.0.1:8792`+token，零配置改动。
  4. 新进程 lsof 无任何开发树文件句柄；venv 内仅标准 `distutils-precedence.pth`。
  5. 启动项唯一：仅该 plist 生效；`.bak*` 不被 launchd 加载。开发树副本保留仅用于开发/测试。
- 可变数据（HF cache）与索引（在 E host 库 `media_embedding_index`，namespace=指纹）不受重启影响；worker 无自身持久状态。

## 3. P1：共同合同与唯一职责映射（本轮交付勘察映射；代码接线见 P2a）

| 逻辑操作 | 现有实现 | 唯一责任模块 | 本轮改动 |
|---|---|---|---|
| 媒体字节上传落正/去重/读取 | M `media.upload.prepare`→`PUT /api/media/stage/{token}`→`media.upload.finalize`；`GET /api/media/object/{hash}`；`media_objects`（sha256 身份，runtime/objects/） | **M** | E 侧新增客户端接入（§4）；M mime 白名单 +svg/html |
| E 本地媒体库（旧正本） | `apps/host/src/media/assets.ts` `MediaService`（media_assets+内容寻址文件+asset_external_refs pin/commit） | E（降级为缓存） | 保存即落正 M；m_* 列；读回源 |
| 相册/留言/分类/引用快照 | `apps/content`（album_entries 三类、caption/meaning、幂等回执、`GET /references/:type/:id`） | **content** | 无（P3 扩展点已明确） |
| 原文/附件关系 | M source 域（source_messages. attachments、source.attachments.sync、版本表） | **M** | 无 |
| 媒体向量索引 | E `media_embedding_index`（namespace=worker 指纹）+ media-embedding worker | E host + worker（P0 已 release 化） | 无 |
| 存档文本检索 | M Qwen3-Embedding-4B/BM25（scope 机制已有） | M | P5 待接 |
| 滚窗装配 | `context/`（assembler/manual-selection/selection-projection）+`runtime/window-*` | E | 未动（P5 增量） |

关键合同事实（后续批次依据）：
- E 引用身份 `est:<asset_id>`；content 侧 asset_id 直连 E 资产身份——P2 稳定 M 引用=content_sha256，旧 `est:` 身份经 media_assets 行映射（不冻结改写历史）。
- content 相册 kind 现为 `chat_screenshots|important_photos|stickers`：与四入口（作品/我们的相册/对话存档/表情包）差距=对话存档类型（争吵/甜蜜）+携带设置（仅收藏/下次滚窗一次/每次滚窗）——P3/P4 施工点。
- **冲突记录**：`apps/host/src/media/model-input.ts` 2026-10-18 裁定"人工选集 textOnly（图片只带占位文本）"与执行包 03 §8.5"手选历史消息图片属用户选择内容，不得默默只带文字"冲突——按包优先级（2026-11-08 用户锁定裁定更高），P5 施工时以包为准改装配；本轮未动该行为。
- M 媒体 mime 白名单原缺 `image/svg+xml`/`text/html`（R10 作品源文件必需）——本轮已扩（§4）；E `chat_voice`（audio/webm）不在 M 白名单，且 A66 保护既有 oído/Siren 音频链路——语音不纳入本轮 M 正本范围。

## 4. P2a：新媒体进 M——实现/隔离验证完成；生产切换与存量迁移未执行

### E 侧（estomago）

- `apps/host/src/integrations/mariposa/media-store.ts`（新增）：`MariposaMediaStore.uploadBytes/fetchBytes`；capability 信封与 client.ts defaultTransport 同形；stage 字节 PUT；hash 双侧校验；错误如实 `MARMEDIA_*`，无静默兜底。
- `apps/host/src/media/assets.ts`：
  - `M_MASTER_PURPOSES`={chat_image, chat_sticker, creation_icon, creation_work, derived_view}；chat_voice=out_of_scope（A66）。
  - `saveBuffer` 本地原子写成功后 `attemptMSync` 落正 M；失败→pending+attempts/error 可见（本地唯一字节绝不清理）；幂等重放补同步。
  - `readContentResolvingMaster`：本地缓存缺失→M 回源（sha256 校验+原子重建缓存）；`readContent` 保持同步本地读（voice 认领时序不变——曾因异步化破坏 voice-transcription 并发认领合同，已回退并单列回源入口）。
  - M 正本消费者已切换：routes/assets.ts（preview/content/oido 视图）、oido-ui、index/service（索引进图）、modules/media readImage（模型看图）、supervisor readImage 回退、model-input 默认物化。
- 迁移 v64：media_assets +m_content_hash/m_sync_state('pending'|'synced'|'out_of_scope')/m_sync_attempts/m_synced_at/m_last_sync_error；存量 chat_voice 行标 out_of_scope。
- app-context：mariposa base_url+credential_ref 齐备才装配 store；待同步后台一跳（≤5/跳、单飞、进程内指数退避 30s·2^min(n,5)，backfill 同款）。
- `scripts/media-master-backfill.mjs`：存量迁移（默认 dry-run；--apply 上传+只改 m_* 列；不删任何本地文件；断点幂等）。**守卫**：media_assets 无 m_* 列即退出——防生产 host 在旧 release 时被推 schema。
- 测试：`tests/unit/mariposa-media-master.test.ts` 6 用例（真实 HTTP 形状 fake M）：落正+幂等不重复上传；M 不可达→pending→恢复补齐；读回源（回源 1 次+缓存重建+二次读零 M 调用）；voice out_of_scope；store 错误如实；未配置如实 pending。全量 232/232 文件通过；typecheck 通过。

### M 侧（mariposa）

- `backend/mariposa/media/service.py`：`_ALLOWED_MIME`+`image/svg+xml`/`text/html`（R10），`_ext_for`+.svg/.html。定向媒体测试 27/27 通过。
- `scripts/update_estomago_builtin_allowlist.py`：+`media.upload.prepare`/`media.upload.finalize`；**已对生产库执行**（44→46 项，jiaming binding；备份 `scripts/allowlist-backup-20261108-042515.json`；请求时读库立即生效；生产 E 未部署新代码前为休眠授权）。

### 未完成（如实）

- 生产 E host 未切新 release（部署需按 AGENTS 第 9 条另行同意；本轮授权仅 P0 单服务）→ 生产仍走旧代码（无 M 落正）。
- 存量迁移 dry-run/apply 未在生产执行（须先部署含 v64 的 host release）。
- SVG/HTML 落正依赖 M 侧 mime 扩展进生产 release（当前生产 M 未重发版——位图 mime 现网即兼容，SVG/HTML 落正在 M 发版前会保持 pending 退避重试，不假成功）。
- E 旧本地文件物理清理：P6 发布窗口，未执行（本批零删除）。

## 5. 其余批次状态（07 回执口径）

| 批次 | 状态 | 说明 |
|---|---|---|
| P0 | DONE（生产已切换+验证） | §2 |
| P1 | 映射完成；退出条件"共享合同被真实入口引用"由 P2a 部分满足（media 合同）；content/M 检索合同未动 | §3 |
| P2 | 实现/隔离验证 DONE；生产迁移闭环 NOT_RUN（未部署、未迁移、未清理） | §4 |
| P3 四类入口/制作/精选 | NOT_RUN | content 相册/creations 基座已在，缺存档类型/携带设置/生成适配 |
| P4 存档/通知/争吵停止 | NOT_RUN | |
| P5 检索/滚窗携图 10 张 | NOT_RUN | textOnly 冲突已记录待裁定执行顺序 |
| P6 发布/验收/回执 | NOT_RUN | |
