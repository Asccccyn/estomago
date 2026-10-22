# media-embedding worker（est 归属）

联合施工 JOINT-VOICE-20261022（07）：EmbeddingGemma 2 的代码与部署归属 estómago，
作为隔离的本地媒体推理 worker。est 用它做图片语义检索；oído 只在需要声音语义检索时
才调用它。worker 不读聊天数据库、不管会话、不回调任何上层，故障不拖电话。

## 现状（如实）
- backend = **fake**：确定性哈希向量（768 维 L2），供合同/管线离线验证。
- **真实 google/embeddinggemma-2 权重未下载**（未获批准）——模型效果 = NOT_EXECUTED；
  接真实后端时：独立 venv、依赖锁、模型 revision 与预处理配置锁、内存预算后启用。
- 中文文字记忆检索仍走 Mariposa 的 Qwen3-Embedding-4B（不迁移、不混库、不同空间不比较）。

## 运行
```
python3 worker.py --port 8792
```
stdlib only（无第三方依赖）。只绑回环。worker 停止时：图片直看、文字聊天、录音、
oído 韵律、电话全部不受影响（宿主侧能力单独降级 unavailable）。

## 端点
- `GET /health` → `{ok, backend, fingerprint}`；fingerprint 含 model/revision/preprocess/dims/norm
- `POST /v1/embed`（JSON）→ 向量 float32 小端 base64；items ≤16；体 ≤64MB；并发由宿主侧队列控制

## 边界（07）
- worker 只编码；业务索引（候选→资产映射、权限过滤、删除失效）在 est 宿主的
  `apps/host/src/media/index/` 持有——共享模型不等于共享素材与权限。
- 不提供图片解说/语气分析/OCR：模型说"图里是什么"时走 est 既有真实视觉输入；
  索引只帮助找原图。
