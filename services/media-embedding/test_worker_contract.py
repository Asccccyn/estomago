"""Offline configuration tests: no model load/download, audio or production worker calls."""
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(os.environ.get("AUDIT_WORKER_SOURCE", str(Path(__file__).with_name("worker.py"))))


def load_worker():
    spec = importlib.util.spec_from_file_location("audit_worker", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Contract(unittest.TestCase):
    def test_configured_missing_token_does_not_disable_auth(self):
        with patch.dict(os.environ, {"MEDIA_WORKER_TOKEN_FILE": "/nonexistent/audit-token-file"}, clear=True):
            with self.assertRaises(FileNotFoundError):
                load_worker()

    def test_unknown_backend_fails_closed(self):
        with patch.dict(os.environ, {"EG2_BACKEND": "eg22"}, clear=True):
            worker = load_worker()
            with self.assertRaises(ValueError):
                worker.backend_impl()

    def test_fake_requires_test_mode(self):
        with patch.dict(os.environ, {"EG2_BACKEND": "fake"}, clear=True):
            worker = load_worker()
            with self.assertRaises(ValueError):
                worker.backend_impl()

    def test_explicit_test_fake_is_deterministic(self):
        with patch.dict(os.environ, {"EG2_BACKEND": "fake", "ESTOMAGO_TEST_MODE": "1"}, clear=True):
            worker = load_worker()
            self.assertEqual(worker.backend_impl(), "fake")
            self.assertEqual(worker._fake_vector(b"test"), worker._fake_vector(b"test"))

    def test_real_loader_pins_full_revision_and_offline_only(self):
        calls = []
        class FakeModel:
            def __init__(self, *args, **kwargs):
                calls.append(kwargs)
        with patch.dict(sys.modules, {"sentence_transformers": types.SimpleNamespace(SentenceTransformer=FakeModel)}):
            worker = load_worker()
            backend = worker.Eg2Backend()
        self.assertRegex(calls[0].get("revision", ""), r"^[0-9a-f]{40}$")
        self.assertTrue(calls[0].get("local_files_only"))
        self.assertFalse(calls[0].get("trust_remote_code", True))
        self.assertIsNone(calls[0]["config_kwargs"]["audio_config"])
        self.assertIn(calls[0]["revision"], backend.fingerprint)

    def test_wrong_dimension_not_silently_truncated(self):
        class FakeModel:
            def __init__(self, *args, **kwargs):
                pass
            def encode(self, *args, **kwargs):
                return [[1.0] * 769]
        with patch.dict(sys.modules, {"sentence_transformers": types.SimpleNamespace(SentenceTransformer=FakeModel)}):
            worker = load_worker()
            backend = worker.Eg2Backend()
            with self.assertRaises(ValueError):
                backend.encode("text", b"synthetic")


if __name__ == "__main__":
    unittest.main(verbosity=2)
