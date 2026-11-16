# 包2 交接文档｜2026-11-16（给下一窗口 GLM）

一句话：包1（媒体增量）+ 三轮审计返修 + 反例3 已全部收口；包2（runtime debug + 午夜绑定）批A/B/C 已完成并分别提交，**剩 DBG-04（存档直接范围写入）、批D 交叉联验、批E 退役文档**；一切仅在开发仓，生产未动，BIND 未启用。

## 1. 版本与运行事实（开工先核对，不要信旧摘要）

| 项 | 现值 |
|---|---|
| E 开发仓 | `/Users/owner/Projects/estomago`，分支 `unified-main-20261102`，HEAD `fd07b3f`（包2批C） |
| M 开发仓 | `/Users/owner/Projects/mariposa`，分支 `main`，HEAD `6f3d1c0`（白名单生成源补 plan.complete/cancel） |
| 生产 host | `estomago-releases/call-ui-20261110-1363302`（launchd start.sh 指向；进程 cwd 可证） |
| 生产 content | `estomago-releases/album-rr-236bee3`；M 生产 `album-rr-b1752b0` |
| schema | 开发已至 **v74**（v71 work 附件/v72 生图指纹/v73 结果 URL/v74 source_bind_jobs）；生产库 v70——升级走正式迁移即可，无手工步骤 |
| 测试基线 | **240 文件全绿**（unit+contract+integration；`node scripts/run-tests.mjs`，必须 `ESTOMAGO_HOME=临时目录`，生产配置存在时保险丝会拒跑） |
| 远端 | **远端是脱敏线（宿主用户 2026-11-15 裁定，已写入全局 AGENTS.md）**：origin 与本地分叉是脱敏所致，不询问、不对账、不提议合并；只核对本地分支/工作树 |

## 2. 已完成（按提交，均已在 README 批次索引有详行）

**包1 + 审计线（全部收口）**：`4cfedab`（M02-M07 媒体增量）→ `3da1147`（一轮审计返修 P1×5+P2×2）→ `041342f`/`04d1964`（二轮返修：升级存量不误发、URL-only 不重生成、完整 429/502 保留重试、CLI 与后台共用逐出）→ `87e793b`（反例3：受保护文件计入实占）。反例1/2 按裁定退出必修，已修实现保留为兼容路径。

**包2 批A `a9bf192`（+M `6f3d1c0`）**：DBG-01 供应商错误具体原因保留（OR/DS runner 读响应体 error.message；supervisor 失败事件带脱敏 detail+evidence；前端展示）；DBG-02 白名单生成源补 plan.complete/cancel；DBG-03 新工具 `memory_update`（M memory.update 的模型入口，expected_version CAS）；DBG-12 确认零实现需求。

**包2 批B `58e204e`**：DBG-05 I 占位退役（A 段不注入 I；manifest 空槽/`i-snapshot-pending.md` 时 gate 跳过）／DBG-06 规则单一正本（`FIXED_RUNTIME_FRAGMENT` 已删）／DBG-07 引导语 guide 标记并入后继历史消息／DBG-08 milestone operation 必填+称谓默认**宿主用户/char**／DBG-09 开窗带 memory_id/plan_id+v 引用／DBG-10 计划续页取尽+对账。

**包2 批C `fd07b3f`**：BIND-01..08 午夜来源绑定（**默认 disabled**）。落点：E 维护 tick（60s due 检查）+ `source_bind_jobs` 表（UNIQUE(memory_id)）+ `GlmChatAdapter`（apps/host/src/integrations/glm/chat.ts）+ M `source.binding.bind`。分批=E `tool_side_effects` committed hold 事实按上海上一 00:00 边界。范围如实=E 工具路径（M 原生/导入无枚举能力）。**启用条件：她配 GLM 凭据（config `source_binding.api_key_env`）+ enabled: true；真实评估按 BIND-09 另行授权。**

## 3. 剩余工作（按优先级）

### 3.1 DBG-04 存档直接范围写入（包2 最大的剩余单项）
执行包 11-16 版 `01_BUG_SPEC.md` DBG-04 节 + `05_ACCEPTANCE.md` D14-D22 是唯一权威，先读原文。要点：
- 三种定位：已有 ref／latest_completed_turn（已实现）／**当前上下文已见内容给双边界锚点（speaker+短逐字原话），宿主内解析为真实 (message_id,revision)**——第三种是要新增的。
- 复用设施：`modules/archives/service.ts` validateRefs/同步收据门；`context/manual-selection.ts` 可见性谓词；边界唯一直接保存、歧义最小消歧、非连续保留缺口、短回执不回显全文、内部读不计已读（D19）。
- 参数挂在现有 `conversation_archive`（不新建工具）；包4 再撤 seq。
- 注意：模型可见的对话投影现在无 seq → 锚点用说话人+原话引语；解析范围=本窗实际可见消息（轨迹/选集），不是全库。
- 交接给包3：只有真实进入主模型上下文的范围才是 coverage 事实（D22）；包2 只提供投影/范围事实，不建 coverage 存储。

### 3.2 批D 交叉联验
同时聊天/跨日/编辑冲突的交叉场景（各批隔离验证已覆盖单路径）；SDK 与 API 投影分别核对（引导语归位后 SDK systemPrompt 变了——真实 SDK 冒烟未做）。

### 3.3 批E 退役与状态报告
- 旧 I 占位文件 `identity/i-snapshot-pending.md` 生产清理（部署窗口做，gate 已不依赖）；
- 按执行包 06_STATUS_AND_RETIREMENT 输出状态/退役/部署差异报告（对照本文件与 README 批次行，不要重写已交付内容）。

### 3.4 三件生产动作（代码就绪，等授权时机，她可能在聊天）
1. **白名单热更新**：跑 M 仓 `scripts/update_estomago_builtin_allowlist.py`（会写生产 M 库 client_bindings；脚本自带备份）——plan.complete/cancel 生效条件；
2. **身份句写入正本**：`identity_milestone_write(operation:'write')` 整版或逐条 add——"你是char。宿主用户是你的妻子，你是宿主用户的丈夫。"（03_SYSTEM §2 原文；不整篇覆盖）；
3. **部署**：`bash deploy/macos/make-release.sh HEAD <label>` 从 HEAD 建新检出 + start.sh 切换 + content 同批——**重启必须按次征得她同意**。

### 3.5 后续包顺序
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

## 6. 当前工作树

E/M 两仓工作树干净（本交接文档与 README 队列更新随本提交入库）。生产三进程未动、未重启、未付费调用、BIND 未启用。
