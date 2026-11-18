# DEPLOYMENT_STATUS｜03 包 R3.1 部署状态

日期：2026-11-17。

## 1. 分列状态

| 层 | 状态 |
| --- | --- |
| 本地代码（两仓工作树） | 已完成并提交（提交号见 README 基线条目） |
| 隔离验证 | pytest/node--test 全绿（见 REGRESSION）；真实 Qwen warmup+D07 语义区分+DB 副本迁移 PASS |
| 生产发布 | **已执行（2026-11-17 21:34–21:36 北京时间，用户授权重启）**：M `solr31-2752fea`（含合同重生成提交）+ E host `solr31-88e1cb2` 成对上线 |
| 生产重启 | **已执行**：M launchctl kickstart（21:34）+ E host kickstart（21:35），中断各约 10–15 秒，无进行中会话 |
| 真实付费模型调用 | **0 次**（Sol gpt-6.1-sol、JEV、主模型均未调用；D07/迁移为本地 MLX 推理） |
| 生产 DB / 生产 env | **已执行**：env 切 `qwen3e4b`；生产库迁移 650/650 事件+481/481 words 全 Qwen 覆盖，purge 清 599 行 BGE 向量（核对后 0 残留）；生产 BGE 权重（~/Data/mariposa/runtime/models，90M+456K）已删 |

## 2. 发布前必做（成对切换，一次请求不跨代）

1. **M release 制作**：从工作仓 HEAD 出 release 目录；**Qwen 权重须可达**——release 目录无 `runtime/models/qwen3-embedding-4b-4bit`（2.1G），需复制或设 `MARIPOSA_QWEN_EMBED_MODEL_DIR=/Users/owner/Projects/mariposa/runtime/models/qwen3-embedding-4b-4bit`。
2. **M env 切换**：`~/Data/mariposa-secrets/start.sh`（或 mariposa.env）`MARIPOSA_SEMANTIC_PROVIDER=local_bge_zh` → **`qwen3e4b`**。注意：新代码下若漏改，provider 落在白名单外= dense 显式 degraded（无静默回退），不会错但语义检索不工作——这正是 11/15"漏启动"类事故的防点，须逐项核对。
3. **M 生产迁移**（重启前后皆可，建议重启前）：`MARIPOSA_ROOT=… ~/Data/mariposa/venv-album-p2a/bin/python scripts/migrate_qwen_embeddings.py ~/Data/mariposa/runtime/formal/mariposa.sqlite3`（幂等；隔离副本已完整演练：**650/650 事件 + 481/481 words 全覆盖（新嵌 626+457，约 9 分钟）；`--purge-bge` 在覆盖核对通过后清 599 行 BGE 向量，重跑零计算**）。venv 需已装 mlx 栈（requirements-dense.lock）。
4. **M 重启**（须本次同意）：启动日志应有 `[semantic] qwen ready` 与回填完成行；之后清理 `~/Data/mariposa/runtime/models` 下 BGE 权重（90M+456K）。
5. **E release + 重启**（须本次同意）：Sol 合同 v3_r31 与 M v6 合同必须同批上线（E 新 plan 形状对旧 M 是 SCHEMA_VIOLATION；旧 E 对新 M 同样被拒——成对发布，不存在单向兼容窗口）。上线后观察 `surface_sol_decision` 正常三态分布与 `surface_stage` 耗时。
6. 首窗观测：自动浮现带 covered_context、主动 recall 已读条目出现 `already_in_window` 短回执即接线生效。

## 3. 风险与回滚

- 迁移只新增 Qwen 行、不动 BGE 行（--purge-bge 前可随时回旧 env+旧 release）。
- 回滚=旧 release + 旧 env（BGE 权重在数据根未删前完整可用）；旧判断缓存按指纹隔离，无需清理。
- 若 Qwen 预热失败：服务照常（dense skipped_cold/failed 如实标记），聊天/FTS 不受影响；修复后重启或手动 warmup。


## 4. 上线执行回执（2026-11-17）

- 前置备份：`~/Backups/20261117-pre-solr31/mariposa.sqlite3`（204MB，VACUUM INTO）。
- 生产迁移：650 事件+481 words 全部 Qwen 覆盖（backfill 650+481）。
- M 重启核验：health 200、cwd=`mariposa-releases/solr31-2752fea`、日志 `[semantic] qwen ready` + `backfill done: 0e/0w`（迁移已全覆盖，启动回填零计算=接线自证）。
- E 重启核验：live/ready 双 200（端口 18787）、cwd=`estomago-releases/solr31-88e1cb2`；content 服务未动（pkg2-0fb14ac）。
- 终态核对：memory_embeddings 仅 `Qwen/…|eventbody-v1` 650 行、word_embeddings 仅 Qwen 481 行、BAAI 残留 0；生产模型目录仅剩 CACHEDIR.TAG（Qwen 权重在 release 内）。
- 新链路首次真实 Sol 判定：待用户下一条消息触发（部署后暂无新消息；重启前最后一笔判定 21:01 正常 none、Sol 前缀缓存命中 2078/2442 input tokens）。

## 5. 成对上线回执（2026-11-18）

- 上线完成于太平洋时间 01:28:56。用户确认当前空档并授权本次重启，依次切换 Mariposa 与 estómago host。
- M 运行 `solalign-a7fe3ad`（实现 `eeead1b`）；E host 运行 `solalign-69023a7`（实现 `6895224`）。进程工作目录与两份启动脚本相符，合同副本逐字节一致。
- M `/health` 200，Qwen 就绪，启动回填 0e/0w。沿用原有 Qwen 权重、正式库和白名单。E `/health/live` 与 `/health/ready` 均 200，schema v77，content 发布未切换。
- 切换前后新增主模型请求、自动浮现作业、后台派发均为 0。验收使用本机健康检查与已有状态，未发消息或触发真实 Sol/JEV。
- 切换前两份启动脚本保存在私有备份目录 `20261118-012853-pre-solalign-launchers`，对应旧发布 `solr31-2752fea` 和 `solr31-88e1cb2`。

## 6. 召回与观察池修复上线（2026-11-18，太平洋时间）

- 04:37:39 复查生产，聊天回合、尝试、通话及邀请、后台执行和派发、浮现作业、M 在途写入和浮现操作计数均为 0。
- 暂停 E 后切换 M，待 `/health` 返回 200、Qwen 就绪及启动回填完成，再启动 E。04:37:43 核验 E 运行 `recallfix-1e44ced`（实现 `070ec0b`、`8b9ea66`），M 运行 `recallfix-9c53bb7`（实现 `97dca38`）。E 的 `/health/live` 和 `/health/ready` 均返回 200，schema 为 v77，Sol 持久模型覆盖为 `gpt-6.2-sol`。
- 两份 110 项能力合同逐字节一致。Qwen 使用原发布的本地权重，启动回填 0 个事件、0 条存词。切换前后 E 的消息、主模型请求、浮现作业、后台派发数量增量均为 0。
- 启动脚本私有备份目录为 `20261118-043739-pre-recallfix-launchers`，对应原发布 E `solalign-69023a7`、M `solalign-a7fe3ad`。本次生产验证未创建测试业务数据，真实供应商语义未另行复测。
