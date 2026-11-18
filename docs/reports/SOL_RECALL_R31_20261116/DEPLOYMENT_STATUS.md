# DEPLOYMENT_STATUS｜03 包 R3.1 部署状态

日期：2026-11-17。

## 1. 分列状态

| 层 | 状态 |
| --- | --- |
| 本地代码（两仓工作树） | 已完成并提交（提交号见 README 基线条目） |
| 隔离验证 | pytest/node--test 全绿（见 REGRESSION）；真实 Qwen warmup+D07 语义区分+DB 副本迁移 PASS |
| 生产发布 | **未执行**（E 仍 `bind-calendar-0fb8cfa`，M 仍 `bind-calendar-82b8eb4`） |
| 生产重启 | **未执行，需另行取得本次明确同意**（含中断说明） |
| 真实付费模型调用 | **0 次**（Sol gpt-6.1-sol、JEV、主模型均未调用；D07/迁移为本地 MLX 推理） |
| 生产 DB / 生产 env | 零改动 |

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
