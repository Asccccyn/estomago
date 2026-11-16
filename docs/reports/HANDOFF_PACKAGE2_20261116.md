# 包2 交接文档｜2026-11-16（给下一窗口 GLM）

一句话：包1（媒体增量）+ 三轮审计返修 + 反例3 已全部收口并**已部署**（`pkg1-final-87e793b`）；包2（runtime debug + 午夜绑定）批A/B/C、DBG-04、**批D 交叉联验、批E 退役与状态报告**全部完成并分别提交，**包2 至此施工完毕**；剩余=三件生产动作（含包2 部署）按裁定待她逐次授权、BIND 启用需她配凭据。

## 1. 版本与运行事实（开工先核对，不要信旧摘要）

| 项 | 现值 |
|---|---|
| E 开发仓 | `/Users/owner/Projects/estomago`，分支 `unified-main-20261102`，HEAD 为批E 收尾提交（含批D `?`/批E `?`；号见 git log） |
| M 开发仓 | `/Users/owner/Projects/mariposa`，分支 `main`，HEAD `6f3d1c0`（白名单生成源补 plan.complete/cancel；**生产库未热更新**） |
| 生产 host+content | `estomago-releases/pkg2-0fb14ac`（2026-11-16 二次部署，她授权『123 可以』：RR4 全链/包1/审计返修/反例3 + **包2 全部施工**；启动自动迁移至 **v74** source_bind_jobs；三进程=cwd 可证） |
| M 生产 | `album-rr4-f334fab`（RR4 排除合同+撤销粒度配套；**同日白名单热更新 47→49 加 plan.complete/cancel 立即生效，备份 allowlist-backup-20261116-070112.json**） |
| schema | 生产已至 **v74**（source_bind_jobs 随 pkg2 启动迁移）；身份句正本已写 `longterm-milestones-v11`（manifest 原子更新 hash 核对一致，v10 留档） |
| 测试基线 | **241 文件全绿**（unit+contract+integration；`node scripts/run-tests.mjs`，必须 `ESTOMAGO_HOME=临时目录`，生产配置存在时保险丝会拒跑） |
| 远端 | **远端是脱敏线（宿主用户 2026-11-15 裁定，已写入全局 AGENTS.md）**：origin 与本地分叉是脱敏所致，不询问、不对账、不提议合并；只核对本地分支/工作树 |

## 2. 已完成（按提交，均已在 README 批次索引有详行）

**包1 + 审计线（全部收口）**：`4cfedab`（M02-M07 媒体增量）→ `3da1147`（一轮审计返修 P1×5+P2×2）→ `041342f`/`04d1964`（二轮返修：升级存量不误发、URL-only 不重生成、完整 429/502 保留重试、CLI 与后台共用逐出）→ `87e793b`（反例3：受保护文件计入实占）。反例1/2 按裁定退出必修，已修实现保留为兼容路径。

**包2 批A `a9bf192`（+M `6f3d1c0`）**：DBG-01 供应商错误具体原因保留（OR/DS runner 读响应体 error.message；supervisor 失败事件带脱敏 detail+evidence；前端展示）；DBG-02 白名单生成源补 plan.complete/cancel；DBG-03 新工具 `memory_update`（M memory.update 的模型入口，expected_version CAS）；DBG-12 确认零实现需求。

**包2 批B `58e204e`**：DBG-05 I 占位退役（A 段不注入 I；manifest 空槽/`i-snapshot-pending.md` 时 gate 跳过）／DBG-06 规则单一正本（`FIXED_RUNTIME_FRAGMENT` 已删）／DBG-07 引导语 guide 标记并入后继历史消息／DBG-08 milestone operation 必填+称谓默认**宿主用户/char**／DBG-09 开窗带 memory_id/plan_id+v 引用／DBG-10 计划续页取尽+对账。

**包2 批C `fd07b3f`**：BIND-01..08 午夜来源绑定（**默认 disabled**）。落点：E 维护 tick（60s due 检查）+ `source_bind_jobs` 表（UNIQUE(memory_id)）+ `GlmChatAdapter`（apps/host/src/integrations/glm/chat.ts）+ M `source.binding.bind`。分批=E `tool_side_effects` committed hold 事实按上海上一 00:00 边界。范围如实=E 工具路径（M 原生/导入无枚举能力）。**启用条件：她配 GLM 凭据（config `source_binding.api_key_env`）+ enabled: true；真实评估按 BIND-09 另行授权。**

**包2 DBG-04 `2be186d`（存档直接范围写入）**：conversation_archive 第三种定位 anchor_start/anchor_end（说话人 宿主用户/char+短逐字原话），`ArchiveService.resolveAnchorRange` 在 ctx.seenMessages（D13 实际装载视野）内解析为 (message_id,revision)，一次调用定位+保存；节选边界/内部节选/缺口/同句多处/倒置/版本已变全部如实（错误码族 ARCHIVE_ANCHOR_*，消歧候选经 modelFailure 白名单放行 boundary/candidates/conflicts——**改失败回执新增字段时记得白名单，否则被剥掉**）；回执短摘要；幂等/收据门/协调器链复用。验证 archives.test ARC-20..25（D14-D19）+ frozen examples 锚点形态；容量五点已平移至 27_630/27_550/17_500/46_950/16_010。**给包3 的交接不变（D22）：只有真实进入主模型上下文的范围才是 coverage 事实；包2 只提供投影/范围事实，未建 coverage 存储。**

## 3. 剩余工作（按优先级）

### 3.1 批D 交叉联验（已随本窗口完成：batch-d-cross.test BD-1/2/3 + archives ARC-26 全绿；SDK 投影走真实 ClaudeSdkRunner→runSdkHostQuery 链，scripted 输入而非真实付费调用）
### 3.2 批E 退役与状态报告（已随本窗口完成：`docs/reports/PACKAGE2_RECEIPT_20261116.md`；批D/批E 提交号见 git log 与 README 批次行）
*包2 施工完毕。下列生产动作仍按裁定逐次授权：*

### 3.3 三件生产动作（代码就绪，等授权时机，她可能在聊天）
1. **白名单热更新**：跑 M 仓 `scripts/update_estomago_builtin_allowlist.py`（会写生产 M 库 client_bindings；脚本自带备份）——plan.complete/cancel 生效条件；
2. **身份句写入正本**：`identity_milestone_write(operation:'write')` 整版或逐条 add——"你是char。宿主用户是你的妻子，你是宿主用户的丈夫。"（03_SYSTEM §2 原文；不整篇覆盖）；
3. **部署**：已于本次授权执行完成（`pkg2-0fb14ac` 上线，schema v74，冒烟通过——后续再部署才需新授权）。

### 3.4 后续包顺序
包3（Sol/Qwen/BGE 退役）→ 包4（MCP 收口）——执行包文本在两个 zip 解包目录（见 §5），11-16 版 COMMON_EXECUTION_RULES 适用 2/3/4。

## 4. 流程约定（踩过的坑，照做省时间）

- **测试**：`ESTOMAGO_HOME=$(mktemp -d …) node scripts/run-tests.mjs [--file=…]`；跑完看 `[test] 结束`；某文件无 TAP 汇总=进程级崩溃（模块加载错），用 `node --experimental-strip-types 文件` 直接跑看真错。
- **改工具定义后必做**：`node scripts/export-tool-package.mjs /tmp/x --update-golden`（golden 三件）+ `ESTOMAGO_UPDATE_GOLDEN=1` 跑 envelope/module-contract 两测试 + frozen-tool-package 三处计数（目录 N/ids N/results N）+ examples 表加条目 + 容量预算按目录字节差平移（中文≈÷2~3 token，宁可多移再回调；近期值：soft 27_230/27_150/17_100、capacity 47_050、底座 15_610）+ `npm run build:web`（dist 是发布正本）。
- **TS 限制**：node strip-types 不支持 constructor 参数属性（写成显式字段+赋值）；tests 目录不在 tsc 覆盖内（导入错要到运行才爆）。
- **sqlite 夹具**：conversations/turns/messages/message_revisions(content_hash 必填)/tool_side_effects(memory_id 列别漏)/source_sync_receipts(operation_id+committed_at) 的 NOT NULL 列见 migrations.ts；`migrate(db, sha256Hex, 70)` 可造历史版本库。
- **审计取证脚本**（复审用，不进仓）：`/Users/owner/Documents/Codex/2026-11-15/an-z/work/reaudit/`（prod-schema-upgrade/image-compat/cache-cli/cache-delete/old-content/old-imagegen/real-sdk 等）。
- M 仓 commit 身份是自动的 `char <owner@…Mac-Mini.local>`，与历史一致，不用改。

## 5. 材料位置

- 包2 执行包（11-16 版，权威）：`~/.zcode/workspace/draft-38bf1dae-…/02_RUNTIME_DEBUG_AND_SOURCE_BINDING_20261116/`（含 08_CHANGELOG；我的实施前对照报告 `PRE_IMPLEMENTATION_ALIGNMENT.md` 同目录）；
- 包1 执行包与我的实施记录：同工作区 `01_MEDIA_INCREMENTAL_20261115/` + E `docs/reports/MEDIA_INCREMENTAL_20261115.md`；
- 审计报告三份（an-z outputs 目录）：初版 diff 审计/GLM 返修复审/验收裁定（反例1/2 退出、反例3 修复的依据都在第三份）；
- 全局 AGENTS.md（~/.codex/AGENTS.md）：远端脱敏裁定等最新规则。

## 6. 当前工作树与生产

E/M 两仓工作树干净（批D/批E 提交后）。生产已于 2026-11-16 部署 `pkg1-final-87e793b`（含包1 全链；**包2 未上**）；BIND 未启用；包2 剩余动作为 §3.3 三件（逐次授权）+ BIND 启用（她配凭据）。
