# RETIREMENT｜03 包 R3.1 退役清单（BGE）与保护项

日期：2026-11-17。口径：旧职责 → 新唯一消费者 → 删除对象 → 尚存消费者/历史资料 → 验证证据。

## 1. 已退役（本批）

| 对象 | 旧职责 | 新唯一消费者 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| `semantic.py` BGE 分支（fastembed import/TextEmbedding/QUERY_PREFIX/BGE 阈值/_cache_path） | 事件语义检索备选 provider | Qwen3-Embedding-4B（唯一） | 执行可能移除：get_provider 仅 qwen3e4b；无回退链 | grep 无 `fastembed`/`TextEmbedding` 残留（backend/）；test_qwen_provider 等 11 文件迁移后全绿 |
| `words_semantic.py` 双 provider 分支 | words 语义检索 | 同上 | 同上；model key 恒 Qwen | `local_bge_zh` 在 backend/scripts 零命中 |
| `candidate_service.py:196` local_bge_zh 特判 | 降级标记条件 | "未配置→degraded" | 改写为 provider 无关语义 | test_surface_tiered_retrieval 绿 |
| `requirements.lock` fastembed==0.8.0 / onnxruntime==1.30.0 | BGE 推理依赖 | 无（mlx 栈在 requirements-dense.lock 供 Qwen） | 移除 2 行 | grep 零命中 |
| 仓内 BGE 权重 `runtime/models/blobs`（90M）、`models--Qdrant--bge-small-zh-v1.5`（456K） | fastembed 缓存 | 无（生产另有自己的数据根副本，见 §3） | 已删除（gitignored 资源，非历史数据） | `ls runtime/models/` 仅剩 qwen3-embedding-4b-4bit |
| 查询路径隐式补嵌（REINDEX_BUDGET 20 / WORDS_REINDEX_BUDGET 20） | 懒维护向量 | 显式索引维护（启动回填/after_write/warmup/迁移脚本） | 默认改 0；缺失以 `__pending_vectors__` 如实暴露 | wp05/wp03 迁移后经 backfill 建向量，绿 |
| M plan 计划级 time_hint/speaker | Sol 计划约束 | 查询级字段 | schema 移除（additionalProperties 拒绝旧形） | r31 schema 例 |

## 2. 生产侧 BGE 残留（待授权切换时处置，本批不动）

| 对象 | 位置 | 现状 | 处置计划 |
| --- | --- | --- | --- |
| 生产 env `MARIPOSA_SEMANTIC_PROVIDER=local_bge_zh` | `~/Data/mariposa-secrets/start.sh` | 仍生效（生产跑旧 release 代码） | 发布新 release 时同批改 `qwen3e4b`（成对切换，M04）；不提前改（改了旧进程也不读） |
| 生产 BGE 权重 | `~/Data/mariposa/runtime/models/{blobs,models--Qdrant--*}`（90M+456K） | 生产 fastembed 缓存 | 新 release 上线且 Qwen ready 核对后删除 |
| 生产 DB BGE 向量行（memory_embeddings 599 行 `BAAI/%`） | `~/Data/mariposa/runtime/formal/mariposa.sqlite3` | 仍在 | 迁移脚本 `--purge-bge`（覆盖核对通过才删）；隔离副本已演练 |
| 旧判断缓存行（surface v5 指纹） | DB feature cache | 保留不删 | 靠新指纹身份隔离，无需清理（既有合同） |

## 3. 保护项（明确不删）

- `requirements-dense.lock`（mlx/mlx-lm/transformers——Qwen 运行栈）。
- 媒体嵌入 worker（`estomago services/media-embedding`，独立服务，不经 M 文字向量链）。
- 原始记忆/来源/审计/版本历史、真实聊天、冻结轨迹。
- 历史报告与旧审计文本中的 "BGE" 字样（不是运行残留）。
- E 仓无 BGE 执行路径（基线 §8），无退役项。

## 4. "因真实消费者保留/待裁决"

无待裁决项。生产三处残留均为"等待发布授权"而非消费者冲突：切换后即无任何 BGE 执行可能（新代码无分支、依赖已出锁、权重按准确目录删）。
