# 三轮整改复审指令（RR3 · 2026-11-10）

写给复审代理。前置阅读顺序：本文件 → `docs/reports/ALBUM_HANDOFF_20261109_RR.md`（二轮交接）→ 用户目录 `Documents/Codex/2026-11-08/files-pasted-by-the-user-codex/outputs/ALBUM_FULL_AUDIT.md`（二轮复审报告，即本轮整改的合同来源）。本文件由实施方（GLM）撰写——**实施方宣称的一切"已修"都是待验证假设，不是事实**。你的工作是把它们证实或证伪。

## 0. 铁律（继承，逐条有效）

- 不把"已实施"当"已验证"；不把"测试绿"当"生产已验证"；不按测试标题判定对错。
- 每项结论先读源码（入口→写入者→持久状态→恢复消费者→最终读者），再选择验证；能区分就标注：源码推断 / 隔离验证 / 生产观测。
- 生产一律只读；不发真实付费模型请求；不写生产库；任何重启/部署需她另行逐次授权。
- 多代理并行：动手前 `git status` + `git log -3`，只提交自己的东西。
- 报告写到用户目录 `Documents/Codex/.../outputs/`（按时间取最新目录），结论带 `file:line`；每项给 PASS / FAIL / NOT VERIFIED 三态；FAIL 给函数级修法与验收条件。
- 发现的新问题同样举证：可达触发路径、实际影响、现有保护为何不足。没有证据的"理论上可能"不作为已确认缺陷。

## 1. 版本锚点（复审开始时先核对，不符即停）

| 项 | 应为 |
|---|---|
| E 源码 | `unified-main-20261102`，HEAD 含 `fd70497`（三轮主批）→ `8b730c3`（合同副本）→ `236bee3`（SDK 型号测试对齐）→ `7936999`/`cdec29b`（docs）。复审 diff 范围：`c0ec1cd..cdec29b` |
| M 源码 | `main`，HEAD 含 `45f8a06`（F2/F3 配套）→ `b1752b0`（合同再生成）→ `cc866c7`/`e3d8efb`（docs）。复审 diff 范围：`946e577..e3d8efb` |
| 生产 | E host+content=`album-rr-236bee3`（cwd 可用 lsof 核对），M=`album-rr-b1752b0`；chat schema v70、content v7；E live/ready 与 M health 200 |
| 数据 | M 生产 FTS 已重建：source_fts=source_search_docs=42936（=带正文消息数；其中 4214 为旧版补回）。备份：`~/Backups/20261110-pre-album-rr/`（E chat+content）、`~/Backups/20261110-pre-fts-reindex/mariposa.sqlite3` |
| 测试基线 | E 三组全量 237 文件/1316 项全绿（注意：`run-tests.mjs --unit --contract` 的 `--contract` 会被组逻辑忽略，只跑 unit；全量请无参跑）；M 全量 1549 过/13 败=存量（清单见 §7，可在 `946e577` 复现对照） |

## 2. 宣称已修项与逐项复审要求

### F1 · 携带配置三入口身份（合同=二轮报告 §3）

宣称：`apps/content/src/service.ts` `assertCarryWithinLimit` 第 4 参去默认值（~:805）；POST 已有分支传 `existing.content_sha256 ?? sha256`（~:566）、PUT 传 `row.content_sha256`（~:598）；代理 `apps/host/src/server/routes/content.ts` 无条件按 E 资产行覆盖 hash、未知资产删除自报值；存量 NULL 行由 `runtime/supervisor.ts` `resolveWindowCarry` 对账补齐（幂等键 `carry-hash:<entry_id>`，POST 既有入口），content 侧补身份不再触碰 `updated_at`（它是 consume-next-once 的 before 基线）。

复审要求：
1. 经真实入口验收三场景（真实代理+真实协调器+真实 ContentServer，参考 `tests/unit/carry-alias-identity.test.ts` 的装配方式但**自建数据**）：满 10 张时同原件别名经 POST 已有/PUT 放行、真第 11 张 422、改模式后携带集去重身份数不变。
2. 审两个新测试文件本身：有没有在测试里替生产调用者补 hash、假 MediaService 漏洞、或自证式断言。
3. 边界自查点（实施方如实申报，请独立判断是否可接受）：对账回填 POST 与用户删除的毫秒级竞态可能重建"仅收藏"条目（仅 warn 日志 `carry_hash_backfill_recreated`）；PUT 对存量 NULL 行在补齐前按 asset 身份保守计数。若你认定需要防御，先给出可达路径与实际损害。
4. `updated_at` 不动是否引入回归：POST 已有分支补身份后，consume-next-once(before) 语义是否仍正确（时间线推演+测试）。

### F2 · 固定版本合同（合同=二轮报告 §4）

宣称：E `modules/archives/service.ts` 新增 `syncedSourceIdsForRefs` 对键解析（只返回请求对键），建档门槛/`searchArchives`/`quarrelBlockedSourceRefs` 三读者共用；`searchArchives` content 存档分页续全量（10×100）+ M `include_ids` 500 分批；`archiveOriginals` 返回固定修订附件（`message_attachments` 按 (message,revision,position)），web `AlbumPanel.tsx` 用既有 `/assets/:id/content` 渲染。M `source/query.py` `search()` include_ids 分支去掉 `live_superseded` 过滤（published 仍过滤）；`source/ingest.py` 不再删旧版 `source_fts/source_search_docs`（失败批清理保留）；合同 include_ids 描述更新并重生成（108 项，E/M 字节一致）。

复审要求：
1. 验收用真实 revision→ingest→索引→查询链（M 隔离根 + `tests/unit/test_source_pinned_revisions.py` 同型自建数据）：归档 v1 后旧词能经 include_ids 命中 v1、新词命中 v2 不归属该存档、封存 v1 不连带 v2、普通检索仍只当前版。不允许假 M 无条件返回期望。
2. 边缘审查：M `search()` 的 `in_ids[:500]` 静默截断与 E 分批（每批 500）的相互作用——E 单批恰 500 时无截断，但请核对两处上限是否同一常量/有无漂移风险；`exclude_ids` 与 `include_ids` 同用行为。
3. `searchArchives` 折叠上限 5 条存档/每批 limit 20 的取舍是否会在多存档场景漏报（对照 03 §2.4"有限摘录"语义）。
4. 生产只读抽查（可用）：抽 2-3 条 superseded 消息，经 `source.search(include_ids=...)` 验证已可命中（FTS 重建效果），普通检索不变。
5. 审 `test_source_pinned_revisions.py` 与 ARC-11b/10b 是否真链路。

### F3 · 存档投影持久恢复 + 读面统一（合同=二轮报告 §5）

宣称：建档/删除经 `ContentOperationCoordinator.write`（`modules/archives/service.ts` createArchive、`server/routes/archives.ts` DELETE 分支）；`confirmSnapshot` 在确认 content 权威快照的**同一本地事务**登记 outbox（target=`mariposa.archive_projection`，稳定键 `archive-projection:<archive_id>:<type>`，upsert：acked 且同 payload 不重开）；content `referenceSnapshot('conversation_archive')` 读墓碑并带 `archive{kind,created_by,messages}`；`ArchiveSyncService.drainArchiveProjections` 复用既有 60s timer（attempt≤20 有界，超限 failed），幂等 op 键 `att-arc:<archive_id>:<message_id>:<type>` 与旧推送同形；删前抢快照+void 尽力推送旧链已整体删除。M：`archives_overview`/`_fold_archive_observations` 撤销终态+先归并全部 observation 再分页；`_archived_marks_for` 派生 `archived_marks` 附在 `get_conversation`/`get_message`；前端 `App.tsx` 改读派生标记。

复审要求：
1. 验收必须含：真实 DELETE 路由（参考 ARC-18 装配）、M 暂时失败→自动恢复、删除确认后"重启"（新消费者实例同 db）沿原身份收口、同键重放不重复登记/推送、M 侧迟到创建不复活（对照 `test_source_archives_overview.py` 新增用例）。
2. 重点审查实施方如实申报的**已知边界**：`reconcileOwner('conversation_archive')` 走 `confirmSnapshot` 时不带 archive 字段（confirmOperation 才带）——存量对账不会登记投影。生产 conversation_archives=0 行（已核实），当前无实际影响；判断这是否需要收口（如给 reconcileOwner 补 archive 映射），还是接受为边界并记录。
3. 检查行为变化点是否有意为之：createArchive 幂等键缺席时新错误码 `ARCHIVE_IDEMPOTENCY_REQUIRED`（原来 null 键直发 content）；`enqueueNotice` dedupe 键从可空变为必带；协调器 503/504 时 createArchive 对工具的 retryable 语义（`HTTP_503` 类 code 是否被调用方正确处理）。
4. drain 逐条推送、首败 break 整行重试（幂等）——判断可接受性。
5. 审 `tests/unit/archives.test.ts` 重写后的 ARC-12/15/18：是否用真实协调器与真实 content，有没有手工按序调 helper 冒充路由/恢复链。

### GIF · 测试证据与参数合同（合同=二轮报告 §6）

宣称：`integrations/imagegen/adapter.ts` `size=auto` 放行、`frame_duration_ms≥20`；工具描述同步（`modules/imagegen/module.ts`），golden 三件按脚本重建（`scripts/export-tool-package.mjs --update-golden` + `ESTOMAGO_UPDATE_GOLDEN=1`）并无开关复跑；`tests/unit/imagegen.test.ts` 夹具换 Pillow 真双帧（157B/2 帧/loop=0）、fake M 落实际 stage 字节+魔数 MIME、缓存逐出后经真实资产 HTTP 路由（`server/routes/assets.ts` handler）回读验证字节保真与帧数。

复审要求：
1. 核对 golden 再生成路径（不能手改文件）；frozen window_toolsets 未被手改（新 GIF 工具定义应待受控滚窗自然装载——这是**部署后仍未发生**的事，属预期状态，不是缺陷）。
2. 审 IG-GIF 是否真的经 HTTP fetch 断言（不是把 service 返回对象冒充 HTTP 响应）；`gifFrameCount` 解析器本身是否正确（可对夹具独立解码验证）。
3. 明确边界：真实供应商 GIF 生成、账号 GIF preview 权限、真实浏览器循环播放——**NOT VERIFIED**，不得因本地链路 PASS 而改判。真实付费调用逐次问她。

## 3. 生产部署面复审（只读）

1. `lsof` 核对三进程 cwd 分别指向 `album-rr-236bee3`（host/content）与 `album-rr-b1752b0`（M）；plist/start.sh 的 `.bak-20261110-albumrr` 备份在位。
2. schema：chat `MAX(version)=70`、content `=7`；`message_attachments.object_meta_synced_at` 已由 60s 回填补齐（28 项）；E outbox：`content.operation` 无 pending/unknown、`mariposa.archive` 全 acked、`mariposa.archive_projection` 0 行（无存档，首次建档即产生）。
3. M：FTS 42936、缺口 0；archives.list 返回空集（无存档）；前端页面引用 `index-Ubhwjrue.js`（含 archived_marks 消费的新构建）。
4. E 日志 `launchd.err.log` 无 WARN/ERROR 风暴（experimental warning 除外）。

## 4. 复审方法工具箱（本仓既有流程，勿自创新流程）

- E 测试：`node scripts/run-tests.mjs`（全三组；单文件加 `--file=tests/unit/<name>.test.ts`；须隔离 `ESTOMAGO_HOME=$(mktemp -d ...)`，生产根会被保险丝拒绝）。typecheck：`npm run typecheck` / `typecheck:web`。
- M 测试：`.venv/bin/python -m pytest tests/unit/<file> -q`（conftest 自动隔离；资源纪律见 M AGENTS.md）。合同：`MARIPOSA_ROOT=$(mktemp -d) .venv/bin/python scripts/export_contracts.py --check`；E 副本 diff 字节一致。
- M 隔离数据根复现链路：参照 `test_source_pinned_revisions.py` 的 fixture 形态。
- 对照法分辨存量/新问题：在改动前提交（E `c0ec1cd`、M `946e577`）用 `git worktree` 复跑同一失败。

## 5. 实施方如实申报的未闭合/未验证清单（复审请独立核实并评判）

1. 真实用户路径终验收（她指定的 17 场景+执行包 06 矩阵）未做——需她操作（首次真实存档→M 标记/总览、删档→撤下、携带满额别名、GIF 真机）。
2. GIF 真实供应商/账号权限/浏览器交互 NOT VERIFIED。
3. `reconcileOwner` 存档分支不登记投影（见 F3-2）。
4. 存量存档投影回填未做脚本——因生产 0 存档判定为空操作（若复审时已有真实存档产生且历史链正常，则无需；判定标准：content conversation_archives 行数与 M observation 是否自洽）。
5. 二轮报告 §7 的其余未闭合项（封存 192 项排除集上限/终检整包扣留、相册语义检索 scope、照片原话后补、表情补索引计数前移）本轮**未触碰**——不要重复整改，但如与你复审发现相关请关联记录。
6. E `run-tests.mjs --unit --contract` 参数陷阱（--contract 被忽略）已知未修——复审如认为值得修，给最小改法建议。

## 6. 交付要求

报告写入用户目录 outputs（同前几轮格式）：结论先行（放行/不放行完整相册），逐项 PASS/FAIL/NOT VERIFIED + `file:line` + 复现步骤；FAIL 给函数级修法、配套接口、验收条件（对标二轮报告 §3-§6 的写法）。区分生产观测与隔离验证。完成后不部署、不重启、不 push——这些另行授权。
