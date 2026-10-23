#!/usr/bin/env python3
"""est 媒体 embedding worker（JOINT-VOICE-20261022 P4 · 07）。

独立叶子进程：只收受限媒体字节/文本并产向量；不读聊天库、不读 .env 主模型 key、
不回调 est/oído/Siren。单实例承载图像+文本编码（本轮 fake 后端；EG2 真实权重
未获批准不下载——backend=fake 如实上报，不冒充模型效果）。

合同（07）：
- 编码与查询必须同 namespace 配置；指纹= model_id+revision+modality+preprocess+dims+norm
- 向量 768 维 float32 L2 归一（fake 同口径）；并发 1、有界请求体（64MB）、超时拒绝
- 只绑回环；worker 不存在时图片直看/聊天/录音/电话不受影响（宿主侧降级）

启动：python3 worker.py --port 8792
后端：EG2_BACKEND=fake（默认，stdlib 零依赖）| eg2（sentence-transformers 真实
      EmbeddingGemma 2，文本+图像 440M 有效参数；指纹带 HF 快照 revision；并发 1）
端点：
  GET  /health            → {ok, backend, fingerprint}
  POST /v1/embed          → {"items":[{"id","modality":"text|image","data_b64"}]}
                          ← {"vectors":[{"id","vector_b64","dims","norm"}],"fingerprint"}
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMS = 768
MAX_BODY = 64 * 1024 * 1024
BACKEND = os.environ.get("EG2_BACKEND", "fake").strip().lower()
# 官方非对称检索 prompt（模型卡 SearchQuery；本 worker 的文本输入恒为查询侧）
QUERY_PROMPT = "task: search result | query: "


def _hf_snapshot_revision(hf_home: str) -> str:
    """从 HF 缓存目录取快照 revision 哈希（离线、确定性；权重指纹的一部分）。"""
    base = os.path.join(hf_home, "hub", "models--google--embeddinggemma-2", "snapshots")
    if not os.path.isdir(base):
        return "unknown"
    snaps = sorted(os.listdir(base))
    return snaps[0][:12] if snaps else "unknown"


class Eg2Backend:
    """真实 EmbeddingGemma 2（sentence-transformers；文本+图像，audio_config=None）。
    bfloat16/float32（模型卡禁 float16）；cpu 设备；encode 串行锁（并发 1，07 资源保守）。"""

    def __init__(self) -> None:
        os.environ.setdefault("HF_HOME", os.path.expanduser("~/Data/media-embedding/hf-cache"))
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(
            "google/embeddinggemma-2", config_kwargs={"audio_config": None}
        )
        self._lock = threading.Lock()
        rev = _hf_snapshot_revision(os.environ["HF_HOME"])
        self.fingerprint = (
            f"google/embeddinggemma-2|rev={rev}|preprocess=st-default|dims=768|norm=l2"
        )
        self.backend = "eg2"

    def encode(self, modality: str, raw: bytes) -> list[float]:
        with self._lock:
            if modality == "text":
                text = raw.decode("utf-8", errors="strict")
                vec = self._model.encode(
                    [QUERY_PROMPT + text], normalize_embeddings=True
                )[0]
            else:
                from PIL import Image

                img = Image.open(io.BytesIO(raw)).convert("RGB")
                vec = self._model.encode([img], normalize_embeddings=True)[0]
        out = [float(x) for x in vec[:DIMS]]
        norm = math.sqrt(sum(v * v for v in out)) or 1.0
        return [v / norm for v in out]


_FINGERPRINT = None
_BACKEND_IMPL = None


def backend_impl():
    """懒初始化（首次调用时加载模型；启动烟测在 main 里先打一发触发加载）。"""
    global _BACKEND_IMPL, _FINGERPRINT
    if _BACKEND_IMPL is None:
        if BACKEND == "eg2":
            _BACKEND_IMPL = Eg2Backend()
            _FINGERPRINT = _BACKEND_IMPL.fingerprint
        else:
            _FINGERPRINT = "google/embeddinggemma-2|rev=fake-offline|preprocess=v1|dims=768|norm=l2"
            _BACKEND_IMPL = "fake"
    return _BACKEND_IMPL


def FINGERPRINT() -> str:  # noqa: N802（沿用原常量名的小写化改法：函数化取当前指纹）
    backend_impl()
    return _FINGERPRINT

# fake 编码：种子哈希 → 确定性 768 维单位向量。语义无关、可复现——
# 供合同/管线离线验证；不代表 EmbeddingGemma 2 的真实语义质量（NOT_EXECUTED）。
def _fake_vector(seed: bytes) -> list[float]:
    out = []
    for block_no in range(DIMS // 4):  # 每块 sha256=32B → 4 个 uint64
        block = hashlib.sha256(seed + b"|" + str(block_no).encode()).digest()
        for j in range(4):
            u = struct.unpack_from(">Q", block, j * 8)[0]
            out.append(u / 2**64 - 0.5)  # [-0.5, 0.5) 有限、无溢出
    norm = math.sqrt(sum(v * v for v in out)) or 1.0
    return [v / norm for v in out]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 日志只记方法/路径/状态（09：不记内容）
        pass

    def _json(self, status: int, body: dict) -> None:
        raw = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            impl = backend_impl()
            self._json(200, {"ok": True, "backend": getattr(impl, "backend", "fake"), "fingerprint": FINGERPRINT()})
        else:
            self._json(404, {"code": "NOT_FOUND", "message": self.path})

    def do_POST(self):
        if self.path != "/v1/embed":
            self._json(404, {"code": "NOT_FOUND", "message": self.path})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(413 if length else 400, {"code": "BODY_LIMIT", "message": "bad body size"})
            return
        try:
            req = json.loads(self.rfile.read(length))
            items = req["items"]
            assert isinstance(items, list) and 1 <= len(items) <= 16
        except Exception:
            self._json(422, {"code": "INVALID_REQUEST", "message": "items[1..16] required"})
            return
        vectors = []
        for it in items:
            modality = it.get("modality")
            if modality not in ("text", "image"):
                self._json(422, {"code": "INVALID_MODALITY", "message": str(modality)})
                return
            data_b64 = it.get("data_b64")
            if not isinstance(data_b64, str) or not data_b64:
                self._json(422, {"code": "INVALID_INPUT", "message": "data_b64 required"})
                return
            try:
                raw = base64.b64decode(data_b64, validate=True)
            except Exception:
                self._json(422, {"code": "INVALID_BASE64", "message": "bad base64"})
                return
            if modality == "text" and len(raw) > 100_000:
                self._json(413, {"code": "TEXT_LIMIT", "message": "text too long"})
                return
            if BACKEND == "eg2":
                vec = backend_impl().encode(modality, raw)
            else:
                seed = hashlib.sha256(modality.encode() + b":" + raw).digest()
                vec = _fake_vector(seed)
            vectors.append({
                "id": it.get("id"),
                "vector_b64": base64.b64encode(struct.pack(f"<{DIMS}f", *vec)).decode(),
                "dims": DIMS,
                "norm": "l2",
            })
        self._json(200, {"vectors": vectors, "fingerprint": FINGERPRINT()})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8792)
    args = ap.parse_args()
    if BACKEND == "eg2":
        impl = backend_impl()  # 启动即加载并校验（失败=退出非 0，launchd 如实显示失败）
        probe = impl.encode("text", "启动自检".encode("utf-8"))
        assert len(probe) == DIMS and all(math.isfinite(v) for v in probe)
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()
