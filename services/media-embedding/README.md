# media-embedding worker（est 归属）

本地叶子编码进程：只接文本/图片字节并返回向量，不读聊天库、不回调宿主、不抓取 URL。
业务资产权限、索引、删除失效归 est 的 `apps/host/src/media/index/service.ts`。

## 后端与证据边界

- 必须显式设置 `EG2_BACKEND=eg2` 或测试专用 `EG2_BACKEND=fake`；缺失/拼错配置退出。
- `fake` 仅 `ESTOMAGO_TEST_MODE=1` 可启用；哈希向量没有语义能力。
- `eg2` 使用 `google/embeddinggemma-2`，仅加载文本与图像（`audio_config=None`），不提供音频编码。
- 默认锁定现场已有权重 revision `914f7f89142e33e77833254d9c9b90c3cef7303b`；显式 `EG2_REVISION` 必须为完整40位提交。`local_files_only=True`，禁止 remote code，缺权重退出，不下载、不退回 fake。
- 指纹包含实际传入加载器的完整 revision、text-image profile、查询预处理版本、768维和 L2；不同指纹分索引，不原地混写旧向量。
- `requirements-eg2.lock` 是已有依赖版本清单。锁定权重不等于评测效果；本轮未执行真实中文 Recall/nDCG、音频或 Qwen 对照，不宣称语义质量。
- 2026-10-23 审计只读见运行 worker 自报 eg2 与上述 revision 前12位；缓存 config 确有相同完整 revision。审计未重新加载重模型，旧运行进程尚未加载此修复。

## 隔离运行

```sh
EG2_BACKEND=fake ESTOMAGO_TEST_MODE=1 python3 worker.py --port 18792
# 已有缓存/依赖、获准启动真实模型时：
EG2_BACKEND=eg2 python3 worker.py --port 8792
python3 test_worker_contract.py
```

只允许回环绑定。配置 `MEDIA_WORKER_TOKEN_FILE` 时强制非空有效 token 文件；文件缺失/为空即失败，不静默关闭认证。

## 协议与资源

- `GET /health`：backend、modalities（text/image）和指纹；健康是运维响应，不进入主模型。
- `POST /v1/embed`：items 1–16，64MiB 请求上限、文本100KB；返回float32小端base64，仅服务间使用。
- 单在途请求、忙时503，没有无界等待队列；socket 30秒超时；图像最多4000万像素。
- Node宿主取消会中止HTTP请求并阻止迟到向量写库。已开始的本地模型计算不能据此承诺立即被内核抢占。
- 图片检索仅返回候选引用。精确视觉理解仍须走现有原图输入，不能以候选替代OCR、数量或关系判断。
- 中文文字记忆检索保留 Mariposa Qwen3-Embedding-4B；没有同域评测证据，不启用双模型全跑或混向量。

## 清理与状态

2026-10-23 独立审计修复：拒绝非法/fake生产配置、离线固定加载、拒绝错误维度与非有限向量、token配置失败关闭、并发限额；索引结果在取消/删除/源变更后禁止写回。修复仅隔离工作树，未部署。
