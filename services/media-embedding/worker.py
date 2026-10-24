#!/usr/bin/env python3
"""Local text/image embedding leaf worker. No host DB, callbacks or URL fetching.
Explicit EG2_BACKEND=eg2 loads pinned cached weights; fake requires TEST_MODE.
The loaded profile excludes audio. See README.md for contracts and evidence limits.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import re
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMS = 768
MAX_BODY = 64 * 1024 * 1024
BACKEND = os.environ.get("EG2_BACKEND", "").strip().lower()
MODEL_ID = "google/embeddinggemma-2"
# Lock the already approved/cache-present weights; updates require an explicit revision.
MODEL_REVISION = os.environ.get("EG2_REVISION", "914f7f89142e33e77833254d9c9b90c3cef7303b")
# 认证（09：同机不等于不需认证）：MEDIA_WORKER_TOKEN_FILE 给了就强制 Bearer（health 开放）
_TOKEN_FILE = os.environ.get("MEDIA_WORKER_TOKEN_FILE", "").strip()
_TOKEN = open(_TOKEN_FILE).read().strip() if _TOKEN_FILE else None
if _TOKEN_FILE and not _TOKEN:
    raise ValueError("MEDIA_WORKER_TOKEN_EMPTY")
_ENCODE_SLOT = threading.BoundedSemaphore(1)
# 官方非对称检索 prompt（模型卡 SearchQuery；本 worker 的文本输入恒为查询侧）
QUERY_PROMPT = "task: search result | query: "


def validate_backend() -> None:
    if BACKEND not in ("eg2", "fake"):
        raise ValueError("INVALID_BACKEND")
    if BACKEND == "fake" and os.environ.get("ESTOMAGO_TEST_MODE") != "1":
        raise ValueError("FAKE_BACKEND_REQUIRES_TEST_MODE")
    if not re.fullmatch(r"[0-9a-f]{40}", MODEL_REVISION):
        raise ValueError("EG2_REVISION_MUST_BE_FULL_COMMIT")


class Eg2Backend:
    """真实 EmbeddingGemma 2（sentence-transformers；文本+图像，audio_config=None）。
    bfloat16/float32（模型卡禁 float16）；cpu 设备；encode 串行锁（并发 1，07 资源保守）。"""

    def __init__(self) -> None:
        os.environ.setdefault("HF_HOME", os.path.expanduser("~/Data/media-embedding/hf-cache"))
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(
            MODEL_ID, revision=MODEL_REVISION, local_files_only=True,
            trust_remote_code=False, config_kwargs={"audio_config": None}
        )
        self._lock = threading.Lock()
        rev = MODEL_REVISION
        self.fingerprint = (
            f"{MODEL_ID}|rev={rev}|profile=text-image|preprocess=st-search-query-v1|dims=768|norm=l2"
        )
        self.backend = "eg2"

    def encode(self, modality: str, raw: bytes):
        with self._lock:
            if modality == "text":
                try:
                    text = raw.decode("utf-8", errors="strict")
                except UnicodeDecodeError as exc:
                    raise ValueError("INVALID_TEXT_ENCODING: text must be valid UTF-8") from exc
                vec = self._model.encode(
                    [QUERY_PROMPT + text], normalize_embeddings=True
                )[0]
            else:
                from PIL import Image

                with Image.open(io.BytesIO(raw)) as source:
                    if source.width * source.height > 40_000_000:
                        raise ValueError("IMAGE_PIXELS_LIMIT")
                    img = source.convert("RGB")
                    try:
                        vec = self._model.encode([img], normalize_embeddings=True)[0]
                    finally:
                        img.close()
        out = [float(x) for x in vec]
        if len(out) != DIMS or not all(math.isfinite(v) for v in out) or not any(out):
            raise ValueError("INVALID_MODEL_VECTOR")
        norm = math.sqrt(sum(v * v for v in out)) or 1.0
        return [v / norm for v in out]


_FINGERPRINT = None
_BACKEND_IMPL = None


def backend_impl():
    """懒初始化（首次调用时加载模型；启动烟测在 main 里先打一发触发加载）。"""
    global _BACKEND_IMPL, _FINGERPRINT
    validate_backend()
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
            self._json(200, {"ok": True, "backend": getattr(impl, "backend", "fake"), "modalities": ["text", "image"], "fingerprint": FINGERPRINT()})
        else:
            self._json(404, {"code": "NOT_FOUND", "message": self.path})

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def do_POST(self):
        if not _ENCODE_SLOT.acquire(blocking=False):
            self.close_connection = True
            self._json(503, {"code": "WORKER_BUSY", "message": "retry later"})
            return
        try:
            self._do_embed()
        finally:
            _ENCODE_SLOT.release()

    def _do_embed(self):
        if self.path != "/v1/embed":
            self._json(404, {"code": "NOT_FOUND", "message": self.path})
            return
        if _TOKEN is not None:
            import hmac

            authorization = self.headers.get("Authorization") or ""
            provided = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
            if not provided or not hmac.compare_digest(provided, _TOKEN):
                self._json(401, {"code": "UNAUTHORIZED", "message": "bearer token required"})
                return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(400, {"code": "INVALID_REQUEST", "message": "invalid content length"})
            return
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
            if not isinstance(it, dict):
                self._json(422, {"code": "INVALID_REQUEST", "message": "item must be object"})
                return
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
                try:
                    vec = backend_impl().encode(modality, raw)
                except ValueError as exc:
                    self._json(422, {"code": str(exc).split(":")[0], "message": str(exc)[:120]})
                    return
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
    validate_backend()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        ap.error("worker must bind loopback")
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
