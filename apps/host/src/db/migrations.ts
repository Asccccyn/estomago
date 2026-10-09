// 建库迁移：01 §16 最小数据表。迁移前记录 code_hash；不可逆变更需先备份（18.2）。
import type { Db } from './connection.ts';
import { validateAbsoluteIso } from '../util/time.ts';
import { tx } from './connection.ts';

const MIGRATIONS: Array<{ version: number; name: string; sql: string; preSql?: string; postSql?: string; repair?: (db: Db) => number }> = [
  {
    version: 1,
    name: 'base-schema',
    sql: `
CREATE TABLE conversations(
  id TEXT PRIMARY KEY,
  owner_service TEXT NOT NULL DEFAULT 'estomago',
  origin_room_id TEXT,
  scope TEXT NOT NULL DEFAULT 'private',
  title TEXT,
  active_window_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE members(
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (conversation_id, participant_id)
);

CREATE TABLE messages(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sequence INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('owner','assistant','system')),
  turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text','sticker','voice','system')),
  client_message_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX idx_messages_client_id
  ON messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE message_revisions(
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (message_id, revision)
);

CREATE TABLE turns(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  trigger TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','completed','interrupted','blocked','failed','route_pending')),
  input_message_id TEXT,
  time_context_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE attempts(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attempt_no INTEGER NOT NULL,
  input_revision INTEGER,
  input_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','running','completed','interrupted','blocked','failed','route_pending')),
  blocked_reason TEXT,
  window_id TEXT,
  sdk_session_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (turn_id, attempt_no)
);

CREATE TABLE windows(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL CHECK (status IN
    ('NEW','PREPARING','IDENTITY_VERIFIED','READY','ACTIVE','ROTATION_REQUESTED','DRAINING','HANDOFF_READY','CLOSED','BLOCKED','DEGRADED')),
  sdk_session_id TEXT,
  manifest_ref TEXT,
  receipt_id TEXT,
  cutoff_sequence INTEGER,
  active_generation INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  conversation_id TEXT,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','claimed','done','expired','failed','unknown_outcome')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  fence INTEGER,
  UNIQUE (source, dedupe_key)
);

CREATE TABLE outbox(
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sent','acked','failed','disabled','unknown_outcome')),
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target, operation_key)
);

CREATE TABLE runtime_stream_events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  stream_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  turn_id TEXT,
  attempt_id TEXT,
  entity_ref TEXT,
  entity_revision INTEGER,
  scope TEXT NOT NULL DEFAULT 'private',
  occurred_at TEXT NOT NULL,
  payload_ref TEXT NOT NULL
);
CREATE INDEX idx_stream_turn ON runtime_stream_events(turn_id);

CREATE TABLE reasoning_blocks(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  window_id TEXT,
  sdk_session_id TEXT,
  sdk_message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'stream' CHECK (origin IN ('stream','complete_message','snapshot')),
  visibility TEXT NOT NULL DEFAULT 'summary'
    CHECK (visibility IN ('summary','omitted','redacted','no_block','unavailable','unknown')),
  state TEXT NOT NULL DEFAULT 'streaming'
    CHECK (state IN ('streaming','complete','partial','interrupted','failed','truncated','conflict')),
  received_text TEXT NOT NULL DEFAULT '',
  final_text TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  completeness TEXT NOT NULL DEFAULT 'partial',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (attempt_id, sdk_message_id, block_index)
);

CREATE TABLE bootstrap_receipts(
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL,
  manifest_ref TEXT,
  desired TEXT NOT NULL,
  assembled TEXT NOT NULL,
  observed TEXT NOT NULL,
  probe TEXT NOT NULL,
  gate_state TEXT NOT NULL,
  gate_reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE usage_observations(
  id TEXT PRIMARY KEY,
  request_id TEXT,
  attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('request','turn','cumulative')),
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  source TEXT NOT NULL,
  completeness TEXT NOT NULL DEFAULT 'complete',
  observed_at TEXT NOT NULL
);

CREATE TABLE route_decisions(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  target_model TEXT,
  source_evidence TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed','expired','superseded')),
  choice TEXT CHECK (choice IN ('approve','edit','cancel') OR choice IS NULL),
  consumed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE wakeups(
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('agreed_reminder','autonomous_contact','module_event')),
  reason TEXT,
  source_ref TEXT,
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  expiry_policy TEXT,
  catch_up_policy TEXT,
  notification_policy TEXT,
  state TEXT NOT NULL DEFAULT 'scheduled',
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, dedupe_key)
);

CREATE TABLE effects(
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL,
  state TEXT NOT NULL,
  external_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events(
  id TEXT PRIMARY KEY,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  scope TEXT,
  result TEXT NOT NULL,
  trace_id TEXT,
  detail_ref TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'v0.2.2-core-correctness',
    sql: `
CREATE TABLE capability_probes(
  id TEXT PRIMARY KEY,
  probe_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('supported','unsupported','blocked','unknown')),
  sdk_version TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (probe_key, sdk_version)
);

CREATE INDEX idx_route_decisions_conv_state ON route_decisions(conversation_id, state);
CREATE INDEX idx_windows_sdk_session ON windows(sdk_session_id);
CREATE INDEX idx_usage_turn_attempt ON usage_observations(turn_id, attempt_id);
`,
  },
  {
    version: 3,
    name: 'v0.3-route-states-context-boundary',
    preSql: 'PRAGMA foreign_keys=OFF', // F01：FK 开关只能在事务外设置
    postSql: 'PRAGMA foreign_keys=ON',
    sql: `
CREATE TABLE attempts_v3(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attempt_no INTEGER NOT NULL,
  input_revision INTEGER,
  input_hash TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('pending','running','waiting_route_gate','route_owner_pending','ready_after_route','completed','interrupted','blocked','failed')),
  blocked_reason TEXT,
  window_id TEXT,
  sdk_session_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (turn_id, attempt_no)
);
INSERT INTO attempts_v3 SELECT id, turn_id, attempt_no, input_revision, input_hash,
  CASE WHEN state = 'route_pending' THEN 'route_owner_pending' ELSE state END,
  blocked_reason, window_id, sdk_session_id, started_at, completed_at FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_v3 RENAME TO attempts;

CREATE TABLE turns_v3(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  trigger TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('pending','running','route_owner_pending','completed','interrupted','blocked','failed')),
  input_message_id TEXT,
  time_context_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO turns_v3 SELECT id, conversation_id, trigger,
  CASE WHEN state = 'route_pending' THEN 'route_owner_pending' ELSE state END,
  input_message_id, time_context_json, generation, started_at, completed_at, created_at FROM turns;
DROP TABLE turns;
ALTER TABLE turns_v3 RENAME TO turns;

CREATE TABLE windows_v3(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL CHECK (status IN
    ('NEW','PREPARING','IDENTITY_VERIFIED','READY','ACTIVE','ROTATION_REQUESTED','DRAINING','HANDOFF_READY','CLOSED','BLOCKED','DEGRADED','CONTEXT_STALE')),
  sdk_session_id TEXT,
  manifest_ref TEXT,
  receipt_id TEXT,
  cutoff_sequence INTEGER,
  active_generation INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  context_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO windows_v3 SELECT id, conversation_id, status, sdk_session_id, manifest_ref, receipt_id,
  cutoff_sequence, active_generation, blocked_reason, revision, NULL, created_at, updated_at FROM windows;
DROP TABLE windows;
ALTER TABLE windows_v3 RENAME TO windows;

ALTER TABLE route_decisions ADD COLUMN message_id TEXT;
ALTER TABLE route_decisions ADD COLUMN input_revision INTEGER;
`,
  },
  {
    version: 4,
    name: 'v0.3.1-occurred-at-repair',
    // F14：存量坏时间修复——历史入库的非 ISO occurred_at（如数字 0/相对值）统一回填为宿主接收时间，
    // 否则下一轮读取/排序会抛 Invalid time value
    sql: `
UPDATE message_revisions SET occurred_at = received_at
WHERE occurred_at IS NULL
   OR occurred_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*';
`,
  },
  {
    version: 5,
    name: 'v0.3.2-sdk-route-events-and-fresh-session',
    // F10：SDK 结构化路由事实（fallback 已发生/拒绝未切换）持久化+可回放；
    // route-edit 新 attempt 标记 fresh_session（不 resume 旧 session——旧输入排除语义未验证）
    sql: `
CREATE TABLE sdk_route_events(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  subtype TEXT NOT NULL,
  original_model TEXT,
  actual_model TEXT,
  scope TEXT,
  notice_id TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sdk_route_events_conv ON sdk_route_events(conversation_id, created_at);

ALTER TABLE attempts ADD COLUMN fresh_session INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 6,
    name: 'v0.3.3-occurred-at-calendar-repair',
    // F14：v4 的 GLOB 形状检查漏掉日历无效值（如 2026-99-01、2月30日）。
    // 本迁移保留原始值（occurred_at_raw）+ 修复原因（occurred_at_repair），occurred_at 回填 received_at——
    // 接收时间不冒充真实发生时间，语义由 repair 列如实标注
    sql: `
ALTER TABLE message_revisions ADD COLUMN occurred_at_raw TEXT;
ALTER TABLE message_revisions ADD COLUMN occurred_at_repair TEXT;
`,
    repair: (db: Db): number => {
      const rows = db.prepare('SELECT rowid, occurred_at, received_at FROM message_revisions').all() as Array<{ rowid: number; occurred_at: string | null; received_at: string | null }>;
      let fixed = 0;
      for (const r of rows) {
        if (r.occurred_at !== null && validateAbsoluteIso(r.occurred_at).ok) continue;
        db.prepare('UPDATE message_revisions SET occurred_at_raw = ?, occurred_at = ?, occurred_at_repair = ? WHERE rowid = ?')
          .run(r.occurred_at, r.received_at ?? r.occurred_at, 'v6_calendar_repair_to_received_at', r.rowid);
        fixed++;
      }
      return fixed;
    },
  },
  {
    version: 7,
    name: 'v0.4.0-source-sync-receipts',
    // ESTOMAGO_OR_SELF_HOLD §1.2 + 生命周期包 §4.1：远端原文同步 ACK 落库——
    // origin(消息,修订) → Mariposa source 身份映射，后续 hold/source_selections 用正主 ID。
    // outbox 状态机（pending/sent/acked/failed/disabled/unknown_outcome）自 v0.2.1 已存在，本迁移只加收据表。
    sql: `
CREATE TABLE source_sync_receipts(
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_conversation_id TEXT,
  source_message_id TEXT,
  content_hash TEXT,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (origin_message_id, revision)
);
CREATE INDEX idx_source_sync_receipts_op ON source_sync_receipts(operation_id);
`,
  },
  {
    version: 8,
    name: 'v0.4.1-hold-checkpoint-rotation-review',
    // ESTOMAGO_OR_SELF_HOLD §2.3/§3：成功书签（仅真实已核实 hold 收据推进）、换窗评审、
    // 工具副作用账本（评审完成前的未决写检查）、模型请求已见清单（提醒范围的定位依据）。
    sql: `
CREATE TABLE hold_checkpoints(
  window_id TEXT PRIMARY KEY REFERENCES windows(id),
  room_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  seen_sequence INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE rotation_reviews(
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(id),
  room_id TEXT NOT NULL,
  epoch_revision INTEGER NOT NULL,
  range_keys_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','completed','failed','skipped_empty')),
  decision TEXT CHECK (decision IN ('no_new_hold','holds_completed')),
  memory_ids_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tool_side_effects(
  id TEXT PRIMARY KEY,
  review_id TEXT,
  turn_id TEXT,
  window_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('hold','source_bind','review_complete')),
  state TEXT NOT NULL CHECK (state IN ('pending','running','unknown','failed_unresolved','failed_resolved','committed','cancelled')),
  verified INTEGER NOT NULL DEFAULT 0,
  memory_id TEXT,
  operation_id TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_requests(
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(id),
  attempt_id TEXT,
  turn_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('chat','pre_rotate_review','proactive_turn','cache_keepalive')),
  seen_manifest_json TEXT NOT NULL,
  generation_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rotation_reviews_window ON rotation_reviews(window_id, created_at);
CREATE INDEX idx_tool_side_effects_review ON tool_side_effects(review_id);
CREATE INDEX idx_provider_requests_window ON provider_requests(window_id, created_at);
`,
  },
  {
    version: 9,
    name: 'v0.4.2-window-trajectory',
    // ESTOMAGO_OR_SELF_HOLD §2.2/§7：每窗口 append-only 协议轨迹（实际送出的有序输入投影）。
    // 跨轮 previousPayload 断言与保护点 G 的定位依据；受不低于原文的访问保护（同库同权限）。
    sql: `
CREATE TABLE window_trajectories(
  window_id TEXT PRIMARY KEY REFERENCES windows(id),
  messages_json TEXT NOT NULL,
  last_boundary_json TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 10,
    name: 'v0.5.0-ingest-batch-freeze-and-credentials',
    // 审计 F09/F16/F11（estomago-audit-18a1f1f）：
    //  - ingest_batches：首次发送前冻结规范化 payload 与成员键集——unknown/崩溃重试按字节一致重放，
    //    新消息只进新批次（不重组批、不重读可变前驱版本）。
    //  - outbox.batch_id：行与冻结批次绑定，恢复按原批重放。
    sql: `
CREATE TABLE ingest_batches(
  operation_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  keys_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','acked','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE outbox ADD COLUMN batch_id TEXT REFERENCES ingest_batches(operation_id);
ALTER TABLE tool_side_effects ADD COLUMN seen_sequence INTEGER;
`,
  },
  {
    version: 11,
    name: 'v0.5.1-request-replay-and-trajectory-manifest',
    // 审计 F17/F06（estomago-audit-18a1f1f）：
    //  - provider_requests.payload_json：实际发送的不可变协议投影（受保护；重放/对账依据）
    //  - window_trajectories.manifest_json：实际已见对话清单（id/revision/seq）——
    //    提醒范围与书签视野从"实际发送"产生，不再从聊天库投影。
    sql: `
ALTER TABLE provider_requests ADD COLUMN payload_json TEXT;
ALTER TABLE window_trajectories ADD COLUMN manifest_json TEXT;
`,
  },
  {
    version: 12,
    name: 'v0.5.2-usage-cost-raw',
    // 审计 F19（estomago-audit-18a1f1f）：已返回的实际费用与 raw usage 不在桥接中丢失——
    // cost/reasoning/anomalies/原始帧持久化（展示"已知小计+存在未知"，账单与估计分栏）。
    sql: `
ALTER TABLE usage_observations ADD COLUMN cost_usd REAL;
ALTER TABLE usage_observations ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE usage_observations ADD COLUMN anomalies_json TEXT;
ALTER TABLE usage_observations ADD COLUMN raw_usage_json TEXT;
`,
  },
  {
    version: 13,
    name: 'v0.5.3-request-dispatch-and-usage-attribution',
    // 复审 F17/F18/F28/F31：每次实际派发生效的 sent_at/attempt_no（重试逐笔留证、TTL 锚定真实发送）；
    // usage_observations.window_id 直接归属（手动评审费用不再依赖不存在的 attempt 才能JOIN）。
    sql: `
ALTER TABLE provider_requests ADD COLUMN sent_at TEXT;
ALTER TABLE provider_requests ADD COLUMN attempt_no INTEGER;
ALTER TABLE usage_observations ADD COLUMN window_id TEXT;
`,
  },
  {
    version: 14,
    name: 'joint-audit-b2-skipped-empty-basis',
    // F-J-40（联合审计 2026-10-06）：skipped_empty 凭证补定位依据——
    // 空键集本身无法证明"为什么空"；存书签/清单高水位/触发原因等
    // 事实（不伪造 reviewed/held 全覆盖，只可定位复核）。
    sql: `
ALTER TABLE rotation_reviews ADD COLUMN basis_json TEXT;
`,
  },
  {
    version: 15,
    name: 'joint-audit-d7-retire-envelope-events',
    // D7：旧 events/recordEnvelope 死链退役（零调用零读者；活跃事件流是
    // runtime_stream_events，不受影响）。纯死表 DROP，无数据保留需求。
    sql: `
DROP TABLE IF EXISTS events;
`,
  },
  {
    version: 16,
    name: 'daily-digest-yesterday',
    // 昨天日结（她裁定 2026-10-07）：昨天（上海自然日）未归档闲聊的话题
    // 索引——DS 写、与换窗 hold 提醒共用一个开关（config.reminders）
    sql: `
CREATE TABLE IF NOT EXISTS daily_digests(
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('ready','empty','failed')),
  summary TEXT,
  model TEXT,
  message_count INTEGER,
  last_error TEXT,
  generated_at TEXT NOT NULL
);
`,
  },
  {
    version: 17,
    name: 'manual-context-selections',
    // WP3（MANUAL_HANDOFF_JUDGE_SWITCH_V1，她裁定 2026-10-08）：人工历史
    // 选集——新窗历史携带的唯一来源（引用既有消息，不复制正文）。
    // awaiting(items=NULL，未提交≠空选) / confirmed(items='[]'=明确空选)
    // / consumed / cancelled；同一源窗至多一条活跃方案（部分唯一索引）。
    sql: `
CREATE TABLE IF NOT EXISTS context_selections(
  selection_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source_window_id TEXT NOT NULL,
  expected_window_revision INTEGER NOT NULL,
  source_cutoff_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting','confirmed','consumed','cancelled')),
  items_json TEXT,
  selection_hash TEXT,
  target_window_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_selections_active
  ON context_selections(conversation_id, source_window_id)
  WHERE status IN ('awaiting','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_selections_idem
  ON context_selections(idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
  {
    version: 18,
    name: 'retire-daily-digests',
    // WP5（MANUAL_HANDOFF_JUDGE_SWITCH_V1，她裁定 2026-10-08）：DS 昨天日结
    // 整链退役——派生表 DROP（幂等）；历史迁移 16 不改；已发给旧窗口的日结
    // 文本属过去输入证据，不篡改。messages/revisions/outbox/checkpoints/
    // reviews 全部保留。
    sql: `
DROP TABLE IF EXISTS daily_digests;
`,
  },
  {
    version: 19,
    name: 'runtime-settings',
    // 她裁定 2026-10-08：聊天窗内置换模型/推理等级——override 持久正本
    //（config 文件仍是默认值来源；改设置不重启）
    sql: `
CREATE TABLE IF NOT EXISTS runtime_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];;

export function migrate(db: Db, codeHashOf: (sql: string) => string, upTo?: number): { applied: number[] } { // upTo：测试构造历史版本库用
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    code_hash TEXT NOT NULL
  )`);
  const rows = db.prepare('SELECT version, code_hash FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    code_hash: string;
  }>;
  const have = new Map(rows.map((r) => [r.version, r.code_hash]));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (upTo !== undefined && m.version > upTo) break;
    if (have.has(m.version)) {
      if (have.get(m.version) !== codeHashOf(m.sql + (m.repair ? '\n--with-repair' : ''))) {
        throw new Error(`迁移 v${m.version} code_hash 与历史不一致：不可逆 schema 变更需按 18.2 走备份/兼容验证，不许原地改`);
      }
      continue;
    }
    if (m.preSql) db.exec(m.preSql); // F01：事务外 PRAGMA
    try {
      tx(db, () => {
        db.exec(m.sql);
        if (m.repair) m.repair(db); // F14：数据修复与 schema 变更同事务（repair 的存在参与 code_hash）
        db.prepare('INSERT INTO schema_migrations(version, name, applied_at, code_hash) VALUES (?,?,?,?)').run(
          m.version,
          m.name,
          new Date().toISOString(),
          codeHashOf(m.sql + (m.repair ? '\n--with-repair' : '')),
        );
      });
    } finally {
      // 迁移事务回滚后也必须恢复 PRAGMA（否则同连接 FK 保持 OFF，孤儿写入可成功）
      if (m.postSql) db.exec(m.postSql);
    }
    applied.push(m.version);
  }
  return { applied };
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as { v: number };
  return row.v;
}
