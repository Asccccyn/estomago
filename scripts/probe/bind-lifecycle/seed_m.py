# M 侧种子：真实 schema 迁移 + 白名单 binding（发 token）+ 记忆/会话/消息预置（SQL 夹具，
# 与 E 收据共享 sm/sc id；验收操作全走正式 HTTP/registry）
import sys, os, json, secrets
root = sys.argv[1]
os.environ['MARIPOSA_ROOT'] = root
sys.path.insert(0, os.path.join(sys.argv[2], 'backend'))
sys.path.insert(0, os.path.join(sys.argv[2], 'scripts'))
from mariposa import schema
from mariposa import db as mdb
from mariposa.identity import service as identity_svc
from update_estomago_builtin_allowlist import ALLOWLIST
schema.migrate()
schema.migrate_runtime()
token = secrets.token_urlsafe(32)
with mdb.formal() as conn:
    conn.execute(
        "INSERT OR IGNORE INTO principals(principal_id, display_name, kind)"
        " VALUES ('jiaming','char','agent')")
    conn.execute(
        "INSERT INTO client_bindings(binding_id, token_hash, principal_id, entry_source,"
        " capabilities_allowlist, created_at) VALUES(?,?,?,?,?,datetime('now'))",
        ("bdg_probe", identity_svc._hash_token(token), "jiaming",
         "estomago_builtin", json.dumps(sorted(set(ALLOWLIST)))))
    t = '2026-01-01T00:00:00Z'
    conn.execute(
        "INSERT INTO source_conversations(id, provider, provider_conversation_id,"
        " message_count, first_import_batch_id, last_import_batch_id)"
        " VALUES ('sc_probe','estomago','conv_probe',16,'b1','b1')")
    for mid in ('probe_a', 'probe_b', 'probe_c', 'probe_d', 'probe_e', 'probe_f', 'probe_g'):
        conn.execute(
            "INSERT INTO memories(memory_id, current_version_no, memory_date, created_at, updated_at)"
            " VALUES (?,1,'2026-01-01',?,?)", (mid, t, t))
        conn.execute(
            "INSERT INTO memory_versions(memory_id, version_no, representation, hold_text,"
            " authored_by, origin_kind, payload_hash, created_at)"
            " VALUES (?,1,'full',?,'jiaming','initial_hold',?,?)",
            (mid, f'probe body {mid}', 'h' * 64, t))
        import hashlib as _hl
        for i in range(1, 5):
            smid = f'sm_msg_{mid}_{i}'
            prev = f'pm_sm_msg_{mid}_{i - 1}' if i > 1 else None
            conn.execute(
                "INSERT INTO source_messages(id, conversation_id, provider,"
                " provider_conversation_id, provider_message_id,"
                " parent_provider_message_id, normalized_sender,"
                " sequence, published, content_hash, import_batch_id, occurred_date, text)"
                " VALUES (?,'sc_probe','estomago','conv_probe',?,?,?, ?, 1, ?, 'b1', '2026-01-01', 'synthetic original')",
                (smid, f'pm_{smid}', prev,
                 'human' if i != 2 else 'assistant', i,
                 _hl.sha256(('probe:' + smid).encode()).hexdigest()))
print(token)
