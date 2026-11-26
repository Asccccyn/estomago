# 相册整改交接协议·二轮（2026-11-09 夜）

写给下一个接手的会话/代理（她开新窗继续）。前置阅读顺序：本文件 → `docs/reports/ALBUM_HANDOFF_20261109.md`（一轮交接）→ 最新复审报告（用户目录 `Documents/Codex/2026-11-08/files-pasted-by-the-user-codex/outputs/` 按时间取最新；**本轮她判定"又没修好"但她当时在手机上，未见新报告——新窗第一件事是向她要最新复审结论或让她贴报告，逐条对照下方"已实施清单"核实哪些仍是反例，不要凭猜测重做**）。

## 0. 铁律（不变）

真实付费调用逐次问；测试数据禁入生产库；重启/部署逐次授权（她手机上够不到 Mac=本交接不包含任何生产操作）；多代理并行提交前 `git status`+`git log -3` 只 add 自己文件；全量测试输出禁 `| head` 截断（SIGPIPE 假绿，输出进文件再统计）。

## 1. 当前状态（2026-11-09 夜，交接时）

**生产运行**：E host+content=`album-r5-37b9997`，M=`album-master-8d13f65`（均为一轮 R5/R6 部署版；**下列二轮提交全部未部署**）。

**源码 HEAD（未部署）**：
- E：`3323671`（RR1-RR7+GIF 批）→ `5715db4`（自查修正）→ `800038f`（孤儿测试清理）→ `6b66216`(docs)
- M：`af60c87`（撤销投影 latest-wins）→ `901cdee`（合同重生成）→ `946e577`(docs)
- 两树干净、未 push。E 测试基线 **235/235 全绿**（孤儿清理后首次全绿，此后任何失败都是新问题，没有"在案 WIP"缓冲）；M 相关批次全绿。

**交接动因**：她判定二轮"又没修好"。二轮报告（RELEASE_GATE.md 当时五项）我已全部实施+自查（见 §2），但她终判未过且暂未给出新反例明细——以她的判定为准，新窗从最新复审报告/她的口述重新对表。

## 2. 已实施清单（二轮 RR 编号；新窗勿重做，先核对是否真是反例）

| 项 | 实现 | 关键文件 | 测试 |
|---|---|---|---|
| RR1 语音错误分类 | 外层 catch 只分类已派发 ASR 的错误；预派发 MediaError（回源不可达/格式不支持）直通，不再改写 unknown 卡死重试 | `apps/host/src/media/voice.ts` | voice-transcription RR1 |
| RR2 原图身份去重 | 装配去块按 content_sha256；content v7 `album_entries.content_sha256`（E 补注：host 代理+模型工具两入口）；限额 `COUNT(DISTINCT COALESCE(hash,'est:'||asset_id))`；carrySet 随行带 hash；本地查不到时 content 值兜底（自查修正） | `runtime/supervisor.ts`（装配+resolveWindowCarry）、`server/routes/content.ts`、`apps/content/src/service.ts` | wp7 T12、wp5 RR2 |
| RR3 存档精确版本 | 门槛按 (message_id,revision) 精确匹配；M 推送用 ref.revision；删档先取快照（archiveRefsForRevoke，删后读必 404——自查修正的死路）再推 revoked observation | `modules/archives/service.ts`、`server/routes/archives.ts`、M `source/query.py`（latest-wins） | ARC-14/15、M test_source_archives_overview |
| RR4 作品成功门 | creation_save_artifact：M 未落正=CREATION_MASTER_PENDING；快照未确认=CREATION_SNAPSHOT_PENDING（均同键重试只补缺） | `modules/content/service.ts` | imagegen IG-11 |
| RR5 附件元数据补传 | 迁移 v70 `object_meta_synced_at`；`backfillObjectMeta` 60s 周期消费者（≤50/跳，幂等 op 键）；存量 22 项/未 synced/失败三类同链 | `db/migrations.ts`、`integrations/mariposa/archive-sync.ts`、`app-context.ts` | ARC-16 |
| RR6 检索语义 | stickers scope 未索引/编码失败按集合真实候选统计（coverage incomplete+pending_index+失败说明） | `modules/media/service.ts` | media-index RR6 |
| RR7 生图快照恢复 | 快照未确认→行留 stored（含 creation_id）+IMAGEGEN_SNAPSHOT_PENDING；storedResume 真实可达 | `modules/imagegen/service.ts` | IG-10 |
| GIF 动图 | 适配器传 `output_format`（gif 可带 frame_count 2..16 官方范围/frame_duration_ms 正整数/size）；旧实现不带格式→供应商默认静态 PNG（生产实证三张动图全落 PNG=根因）；creation_work 白名单+gif；格式随操作持久（v70 列）；工具描述要求动图显式 format=gif | `integrations/imagegen/adapter.ts`、`modules/imagegen/{module,service}.ts`、`media/assets.ts` | IG-GIF（本地全链零付费：参数→字节保真→image/gif） |
| RR8 合同 | M 重生成（source_commit=8d13f65=最后触碰合同源文件的提交，脚本语义如此）+ E 副本同步 108 项 | M `contracts/`、E 副本 | schema_single_source |
| 附带 | image_generate 参数面 +547B→golden 三件重建并无开关复跑；软线未越（or-rot 15.15k/batch1 13.66k/24.8k 家族 25.2k）；孤儿测试清理（800038f） | tests/golden、八夹具 | 8/8 |

## 3. 未验证/待办（新窗的工作面）

1. **拿到她的最新复审结论**（报告或口述），逐条对表 §2——已实施≠她验证通过；上次教训：实施完仍被判未过（如撤销链死路是自查才抓到的）。
2. **部署队列（需她逐次授权）**：①E `bash deploy/macos/make-release.sh HEAD album-rr` + start.sh/content plist 双切换 + 重启；②M 把 af60c87 代码同步进 release（建议新目录 `album-rr-af60c87` 并改 `~/Data/mariposa-secrets/start.sh` 指向，M dist 需从 `~/Projects/maripago/frontend/dist` 带上）+ kickstart `com.charstarearth.mariposa-runtime`；③部署后只读冒烟。E 生产迁移自动走 v70、content 走 v7。
3. **部署后自动/需验证的链**：backfill 60 秒内自动补存量 22 项对象元数据（M 侧原文页图片应可显）；首次真实存档→M"已存档"标记+总览（observation 链生产首验）；删档→标记撤下。测试数据禁入生产库，这些只能等她真实操作。
4. **GIF 真机**：她原说自己测；若改由新窗测，一次真实付费生成需她逐次授权（工具 format=gif）。
5. **我方仍薄弱、复审可能抓的点（诚实列）**：proxy hash 补注只盖 host 代理与模型工具两入口（新入口需自带）；M `_attachments_meta_for` LIMIT 20 行截断（超多附件消息的标记可能被截，量小未处理）；RR5 backfill 依赖 archive.enabled；voice RR1 只覆盖回源/格式两类预派发错误（其他 MediaError 直通是否合理未逐个审）；E 合同副本与 M 的同步是手工 cp，无自动校验。

## 4. 工程陷阱（继承+新增）

- 加模型工具的完整链条见一轮交接 §2 末尾（本批刚走过：golden 三件→无开关复跑→frozen 计数→八夹具软线）。
- `.mjs` 禁 TS 断言；`docs/reports/` 被 gitignore 误伤要 `add -f`。
- M pytest 隔离 `MARIPOSA_ROOT`（mktemp + `MARIPOSA_TEST_ROOTS` 白名单）；合同导出同理。
- M release 是普通目录非 git 检出；运行目录以 `~/Data/mariposa-secrets/start.sh` 的 cd 为准（别信交接文档写的目录名）。
- wp7 装配 supervisor 默认无 media/视觉声明——测图片投影需传 MediaService 且 deepseek 通道无 vision 键（发送轮会被 MODEL_VISION_UNAVAILABLE 拦，属生产行为）。

## 5. 本线提交史（全部未 push）

E：`20e2917`(R5/R6)→`37b9997`(docs)→`7cfaa99`(基线)→`3323671`(RR 批)→`5715db4`(自查)→`800038f`(孤儿清理)→`6b66216`(docs)→本交接 docs。M：`8d13f65`(R6+R1 崩溃修)→`a0dcef9`→`a2e1bdc`→`af60c87`→`901cdee`→`946e577`→本交接。

## 6. 验收基线

E 全量 235/235（2026-11-09 起无任何在案失败）；M 相关批次全绿。终验收=她指定的 17 场景+执行包 06 矩阵，真实用户路径，测试绿不能替代。上轮复审五项（RR1-RR7 编号见 §2）已全部实施+定向测试+自查，但她终判未过——以她的最新结论为唯一对表依据。
