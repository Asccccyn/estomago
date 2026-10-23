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
  {
    version: 20,
    name: 'drop-dead-tables',
    // 她 2026-10-10 批"删吧"（run-160858 复审开放项）：清退零读零写死表
    // wakeups/effects 与 1 写 0 读的 members（写入点已同步移除，
    // messages/service.ts ensureConversation）。audit_events **保留**——
    // prune 维护审计（runtime/prune.ts、scripts/prune.mjs）在写，破坏性
    // 维护动作的审计账本属合法保留，非死表（复审勘误：审计期"4 死表"
    // 的口径在 WP-04 prune 落地后对 audit_events 已过时）。
    sql: `
DROP TABLE IF EXISTS wakeups;
DROP TABLE IF EXISTS effects;
DROP TABLE IF EXISTS members;
`,
  },
  {
    version: 21,
    name: 'system-alerts',
    // ESTOMAGO_CHAT_EXEC_V1 §05（WP1）：独立持久系统异常红点。
    // system_alerts 聚合行（dedupe_key 唯一；复发 reopen 不并新故障）；
    // system_alert_reads 按读者记已见 sequence（已读≠恢复）；system_alert_observations
    // 是稳定 observation_id 消费账本——乱序重放同一输入不重复计数（ALERT-04）。
    sql: `
CREATE TABLE IF NOT EXISTS system_alerts(
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  dedupe_key TEXT NOT NULL UNIQUE,
  lifecycle TEXT NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open','resolved')),
  revision INTEGER NOT NULL DEFAULT 1,
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  resolved_at TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  safe_summary_json TEXT NOT NULL DEFAULT '{}',
  related_request_id TEXT,
  related_run_id TEXT,
  related_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_last_event ON system_alerts(last_event_sequence DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_lifecycle ON system_alerts(lifecycle, severity);
CREATE TABLE IF NOT EXISTS system_alert_reads(
  actor_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  seen_event_sequence INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, alert_id)
);
CREATE TABLE IF NOT EXISTS system_alert_observations(
  observation_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_alert_obs_alert ON system_alert_observations(alert_id);
`,
  },
  {
    version: 22,
    name: 'usage-attribution',
    // ESTOMAGO_CHAT_EXEC_V1 §05.6（WP1）：所有费用要有归属——按派发时上海日聚合
    //（budget_day 来自 dispatch_started_at；usage.observed_at 只是证据时间）；
    // purpose/background_run_id 为 WP4 后台预留（本批不启动后台）。
    // 旧记录无可靠派发时间：budget_day 取 observed_at 的上海日并标 legacy_observed_at=1，
    // 不回填虚构时间。attempt/turn 保持 NOT NULL——后台跑（proactive_turn/cache_keepalive）
    // 沿既有 trigger 建 turn，费用不因"没有用户消息 turn"从统计中消失。
    sql: `
ALTER TABLE usage_observations ADD COLUMN purpose TEXT;
ALTER TABLE usage_observations ADD COLUMN background_run_id TEXT;
ALTER TABLE usage_observations ADD COLUMN budget_day TEXT;
ALTER TABLE usage_observations ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE usage_observations ADD COLUMN legacy_observed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_usage_budget_day ON usage_observations(budget_day, purpose);
UPDATE usage_observations
   SET budget_day = strftime('%Y-%m-%d', observed_at, '+8 hours'),
       legacy_observed_at = 1
 WHERE budget_day IS NULL;
`,
  },
  {
    version: 23,
    name: 'revision-token-estimate',
    // ESTOMAGO_CHAT_EXEC_V1 §05.7.2/§9（WP1）：随 message revision 保存发送前估计快照。
    // additive：旧消息 NULL（显示层不得伪造"发送时估计"；本地按当前模型粗估必须另标）。
    // 估计刷新不改 content_hash/修订号——快照是独立列，旧 revision 旧快照原样保留。
    sql: `
ALTER TABLE message_revisions ADD COLUMN token_estimate_json TEXT;
`,
  },
  {
    version: 24,
    name: 'provider-dispatch-evidence',
    // ESTOMAGO_CHAT_EXEC_V1 02 §4.2 / 04 §5.1、§8.3（WP2）：每次真实 transport 前落
    // dispatch_started_at（旧 onDispatch 在响应后，429/网络重试不进回调——不能靠它计费/续期）。
    // sent_at 语义保持"真实发送确认（响应头已到）"，与 dispatch_started_at 分列。
    // payload_wire_json=payload_format='wire_v1' 是最终发包体证据（旧行 null=envelope_legacy，
    // 不重写历史冒充）。background_* 两列为 WP4 预留（本批不启动后台）。
    sql: `
ALTER TABLE provider_requests ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE provider_requests ADD COLUMN background_run_id TEXT;
ALTER TABLE provider_requests ADD COLUMN background_dispatch_id TEXT;
ALTER TABLE provider_requests ADD COLUMN payload_wire_json TEXT;
ALTER TABLE provider_requests ADD COLUMN payload_format TEXT;
CREATE INDEX IF NOT EXISTS idx_provider_requests_dispatch ON provider_requests(window_id, dispatch_started_at);
CREATE INDEX IF NOT EXISTS idx_provider_requests_bg_run ON provider_requests(background_run_id) WHERE background_run_id IS NOT NULL;
`,
  },
  {
    version: 25,
    name: 'media-assets',
    // ESTOMAGO_CHAT_EXEC_V1 §03.4（WP3/M1）：媒体底座三表 + 修订指纹。
    // asset_id=不可变内容身份；message_attachments 按 (message,revision,position) 固定（旧修订
    // 引用计入禁止物理删除判断）；asset_external_refs 的 protected/committed/released 三态承担
    // 内容后端引用与 pending pin（不再另设 pin 计数）。message_fingerprint 覆盖正文+有序附件，
    // 不动旧 content_hash（Mariposa 合同不变）。
    sql: `
CREATE TABLE IF NOT EXISTS media_assets(
  id TEXT PRIMARY KEY,
  creation_operation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','available','failed','missing')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('upload','import','generated','service')),
  origin_service TEXT, origin_ref TEXT,
  created_by TEXT NOT NULL,
  ingest_purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_assets_sha ON media_assets(content_sha256);
CREATE TABLE IF NOT EXISTS message_attachments(
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  presentation TEXT NOT NULL CHECK (presentation IN ('image','sticker','voice')),
  caption TEXT,
  derived_text TEXT,
  derived_source TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, revision, position)
);
CREATE INDEX IF NOT EXISTS idx_msg_attachments_asset ON message_attachments(asset_id);
CREATE TABLE IF NOT EXISTS asset_external_refs(
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  owner_service TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_revision INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('protected','committed','released')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (asset_id, owner_service, owner_type, owner_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_refs_asset ON asset_external_refs(asset_id, state);
ALTER TABLE message_revisions ADD COLUMN message_fingerprint TEXT;
`,
  },
  {
    version: 26,
    name: 'background-tasks-runs-dispatches',
    // ESTOMAGO_CHAT_EXEC_V1 §04.8（WP4）：有界后台三张小表——不做通用工作流。
    // tasks：三类任务（autonomous/keepwarm/reminder；schedule_kind 首版 once/daily/interval/cache_idle）；
    // runs：一次领取（occurrence_key 唯一防并发双领；状态机 §9.1；首派发启动 60min 冷却）；
    // dispatches：逐次收费预占/重试计数/未知结果恢复（每真实尝试独立定位）。
    sql: `
CREATE TABLE IF NOT EXISTS background_tasks(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('autonomous','keepwarm','reminder')),
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once','daily','interval','cache_idle')),
  scheduled_at TEXT,
  next_due_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  local_time TEXT,
  interval_ms INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_due ON background_tasks(enabled, next_due_at);
CREATE TABLE IF NOT EXISTS background_runs(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL UNIQUE,
  scheduled_for TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','running','cancelling','completed','noop','skipped','cancelled','failed','unknown')),
  window_id TEXT, window_revision INTEGER, driver TEXT, model TEXT,
  settings_revision INTEGER,
  budget_snapshot_json TEXT,
  claimed_at TEXT, first_dispatch_started_at TEXT, finished_at TEXT,
  model_requests_started INTEGER NOT NULL DEFAULT 0,
  tool_calls_started INTEGER NOT NULL DEFAULT 0,
  output_tokens_observed INTEGER NOT NULL DEFAULT 0,
  reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  known_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  unknown_cost_count INTEGER NOT NULL DEFAULT 0,
  result_code TEXT, cancel_reason TEXT,
  cache_observation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_runs_open_kind ON background_runs(actor_id, kind) WHERE state IN ('claimed','running','cancelling');
CREATE TABLE IF NOT EXISTS background_dispatches(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  logical_action_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('model','tool','delivery')),
  capability_name TEXT,
  operation_id TEXT,
  provider_request_id TEXT,
  external_receipt_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','started','settled','cancelled_before_send','unknown')),
  budget_day TEXT,
  reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  actual_cost_micro_usd INTEGER,
  dispatch_started_at TEXT, response_received_at TEXT, settled_at TEXT,
  outcome_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, logical_action_key, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_bg_dispatches_run ON background_dispatches(run_id);
`,
  },
];

// 只添加新迁移，不更改已落盘迁移的 code_hash。
MIGRATIONS.push({
  version: 27,
  name: 'trusted-voice-transcripts',
  sql: `
CREATE TABLE IF NOT EXISTS voice_transcripts(
  asset_id TEXT PRIMARY KEY REFERENCES media_assets(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('processing','ready','failed','unknown')),
  content_sha256 TEXT NOT NULL,
  derived_text TEXT,
  derived_source TEXT NOT NULL DEFAULT 'siren:transcribe',
  language TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
});

// 只添加新迁移，不更改已落盘迁移的 code_hash。
MIGRATIONS.push({
  version: 28,
  name: 'provider-request-context-fingerprint',
  sql: `
ALTER TABLE provider_requests ADD COLUMN context_fingerprint_json TEXT;
`,
});

// v29（EST_MARIPOSA_AUTO_SURFACING_V1，2026-10-19）：自动浮现运行面四表。
// 有界运行数据（docs/02）：候选选择/预留/实际交付分开存；coverage 是
// 投影清单可重建，不是永久 seen。表含对话/记忆投影——不进日志/Git。
MIGRATIONS.push({
  version: 29,
  name: 'memory-surfacing-runtime-tables',
  sql: `
CREATE TABLE surfacing_jobs(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_body_hash TEXT,
  target_message_id TEXT,
  target_revision INTEGER,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  m_operation_id TEXT,
  m_snapshot_ref TEXT,
  policy_revision INTEGER,
  prompt_revision TEXT,
  hypotheses_json TEXT,
  receipt_id TEXT,
  items_json TEXT,
  reason_code TEXT,
  deadline_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(conversation_id, source_message_id, source_revision, policy_revision, prompt_revision)
);
CREATE INDEX idx_surfacing_jobs_state ON surfacing_jobs(state);
CREATE INDEX idx_surfacing_jobs_target ON surfacing_jobs(conversation_id, target_message_id);
CREATE TABLE surfacing_candidates(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES surfacing_jobs(id),
  event_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_version TEXT,
  body_hash TEXT,
  event_group_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_surfacing_candidates_job ON surfacing_candidates(job_id);
CREATE TABLE surfacing_deliveries(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_text TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  selected_refs_json TEXT NOT NULL,
  retained INTEGER NOT NULL DEFAULT 0,
  dispatched_at TEXT,
  retained_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, payload_hash)
);
CREATE INDEX idx_surfacing_deliveries_attempt ON surfacing_deliveries(attempt_id);
CREATE TABLE surfacing_coverage(
  conversation_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_version TEXT,
  body_hash TEXT NOT NULL,
  occurrence_key TEXT,
  detail_ref TEXT,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, window_id, memory_id, body_hash)
);
`,
});

MIGRATIONS.push({
  version: 30,
  name: 'message-retry-receipts',
  sql: `
ALTER TABLE attempts ADD COLUMN retry_window_id TEXT;
CREATE TABLE message_retry_receipts(
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, message_id, operation_key)
);
`,
});

// Pending legacy selections deliberately retain an unknown cause.
MIGRATIONS.push({
  version: 31,
  name: 'selection_rotation_cause_and_projection_clock',
  sql: `
ALTER TABLE context_selections ADD COLUMN rotation_cause TEXT CHECK(rotation_cause IN ('manual','capacity','identity_change','initial'));
ALTER TABLE context_selections ADD COLUMN projection_reference_at TEXT;
`,
});

MIGRATIONS.push({
  version: 32,
  name: 'persistent_window_tool_protocol',
  sql: `CREATE TABLE window_toolsets(
    window_id TEXT PRIMARY KEY REFERENCES windows(id),
    protocol TEXT NOT NULL CHECK(protocol IN ('legacy','deferred')),
    wire_tools_json TEXT NOT NULL,
    catalog_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
});

// v33（WAKE_KEEPWARM_V1，2026-10-22）：自主预约唤醒 + 心跳保温的持久面。
//  - background_tasks.origin/control_reason：区分 self_schedule / system_keepwarm / legacy_unknown，
//    旧 daily/interval 自主任务标 needs_review 并停用（不静默转换/补发，07 升级语义）；
//  - background_runs.turn_id/activity_revision/retention/trajectory_committed_at：
//    后台轮与真实轮共用轨迹提交凭据；retention 区分 ephemeral_ack/retained（06 §2）；
//  - conversation_activity：真实发布锚点 L 与维护回执的会话级投影（07"最小新增数据"；
//    维护回执按 activity_revision CAS，新真实消息使旧回执失效）；
//  - background_operations：后台管理操作（schedule/update/cancel/settings）幂等账本，
//    同键同参数返回原回执、同键不同参数 409。
// repair：从既有正式发布证据（published_at + 修订 received_at）一次性重建各会话的
// L 投影——只读允许字段，不调用模型、不扫正文语义推断；证据不足保持空行（unknown）。
MIGRATIONS.push({
  version: 33,
  name: 'wake_keepwarm_activity_and_operations',
  sql: `
ALTER TABLE background_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK (origin IN ('self_schedule','system_keepwarm','legacy_unknown'));
ALTER TABLE background_tasks ADD COLUMN control_reason TEXT;
ALTER TABLE background_tasks ADD COLUMN client_operation_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_tasks_client_op ON background_tasks(conversation_id, client_operation_key) WHERE client_operation_key IS NOT NULL;
ALTER TABLE background_runs ADD COLUMN turn_id TEXT;
ALTER TABLE background_runs ADD COLUMN input_activity_revision INTEGER;
ALTER TABLE background_runs ADD COLUMN retention TEXT CHECK (retention IN ('ephemeral_ack','retained'));
ALTER TABLE background_runs ADD COLUMN trajectory_committed_at TEXT;
ALTER TABLE background_runs ADD COLUMN published_message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_runs ADD COLUMN tool_calls_observed INTEGER NOT NULL DEFAULT 0;
CREATE TABLE conversation_activity(
  conversation_id TEXT PRIMARY KEY,
  activity_revision INTEGER NOT NULL DEFAULT 0,
  last_real_message_id TEXT,
  last_real_message_revision INTEGER,
  last_real_activity_at TEXT,
  maintenance_request_id TEXT,
  maintenance_for_activity_revision INTEGER,
  maintenance_window_id TEXT,
  maintenance_dispatch_started_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE background_operations(
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, conversation_id, action, operation_id)
);
`,
  repair: (db: Db): number => {
    const nowIso = new Date().toISOString();
    let touched = 0;
    // 旧系统保温任务归位 system_keepwarm；旧自主任务（daily/interval/once 旧语义）
    // 标 needs_review 并停用——重开不突发补发，未来任务按原时间继续由新代码创建。
    db.prepare("UPDATE background_tasks SET origin = 'system_keepwarm' WHERE kind = 'keepwarm' AND schedule_kind = 'cache_idle'").run();
    const legacyAuto = Number((db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE kind = 'autonomous' AND origin = 'legacy_unknown'").get() as { n: number }).n);
    if (legacyAuto > 0) {
      db.prepare("UPDATE background_tasks SET enabled = 0, next_due_at = NULL, control_reason = 'legacy_needs_review' WHERE kind = 'autonomous' AND origin = 'legacy_unknown'").run();
      touched += legacyAuto;
    }
    // L 投影一次性重建：每会话取最近一条已正式发布的 owner/assistant 消息
    // （发布证据=messages.published_at 非空；段落后缀时间=该消息最新修订的
    // received_at——appendAssistantPublication 语义 B18）。只认服务端发布字段，
    // 不读 occurred_at（可编辑）、不算 system/历史导入。
    const convs = db.prepare("SELECT DISTINCT m.conversation_id AS cid FROM messages m WHERE m.speaker IN ('owner','assistant') AND m.published_at IS NOT NULL").all() as Array<{ cid: string }>;
    for (const c of convs) {
      const row = db.prepare(
        `SELECT m.id AS id, m.current_revision AS rev, MAX(r.received_at) AS at
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.speaker IN ('owner','assistant') AND m.published_at IS NOT NULL
         ORDER BY at DESC LIMIT 1`,
      ).get(c.cid) as { id: string; rev: number; at: string } | undefined;
      if (!row) continue;
      db.prepare(
        `INSERT INTO conversation_activity(conversation_id, activity_revision, last_real_message_id, last_real_message_revision, last_real_activity_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO NOTHING`,
      ).run(c.cid, row.id, row.rev, row.at, nowIso);
      touched++;
    }
    return touched;
  },
});

// 单一口径：代码支持的 schema 最高版（restore 等外部脚本引用，不手写数字——
// v20 批前 restore.mjs 硬编码 19 与迁移链分叉曾误拒合法备份）


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

// JOINT-VOICE-20261022（07）P4：图片语义索引——est 归属的 media-index 存储。
// 向量本体（float32 小端 BLOB）进表；namespace = worker 指纹（model_id+revision+
// modality/profile+preprocess_version+dims+normalization）——版本不同=不同 namespace，
// 绝不混库混查（M02）。读路径权限门在查询时 join 活资产与会话绑定（删除/撤权立即
// 阻断），索引行只做候选源；孤儿行由可重试清理收（读不依赖清理成功）。
MIGRATIONS.push({
  version: 34,
  name: 'media_embedding_index',
  sql: `
CREATE TABLE IF NOT EXISTS media_embedding_index(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('image','audio')),
  namespace TEXT NOT NULL,
  vector BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, namespace)
);
CREATE INDEX IF NOT EXISTS idx_media_embed_namespace ON media_embedding_index(namespace, modality);
`,
});

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as { v: number };
  return row.v;
}

// Local authorization receipts; no analysis facts or user content are copied here.
MIGRATIONS.push({ version: 35, name: 'oido_source_bindings', sql: `
CREATE TABLE oido_source_bindings(
 analysis_id TEXT NOT NULL, conversation_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 PRIMARY KEY(analysis_id, conversation_id)
);
CREATE INDEX idx_oido_source_asset ON oido_source_bindings(asset_id);
` });

// R2（2026-10-23，E08/DS 新型号协议适配）：每窗冻结的 reasoning 继续态回传政策。
// NULL = legacy_turn_only（旧 D01：跨用户轮剥除，deepseek-chat/代理/旧窗默认）；
// 'ds_tools_all_turns_v1' = 仅官方直连 deepseek-flash/v4-pro 的新窗（带 tools 的后续请求
// 按当前官方合同回传全部轮次 assistant 的 reasoning_content，含最终无工具回复）。
// additive 列：旧窗 NULL 不回填、不因升级被重标。
MIGRATIONS.push({ version: 36, name: 'windows_reasoning_replay_policy', sql: `
ALTER TABLE windows ADD COLUMN reasoning_replay_policy TEXT;
` });

// R6′（2026-10-23，她批 R6P 方案）：oído 导入定位与删除传播意图。
//  - oido_ingest_receipts：est asset ↔ oído audio_id 持久映射（此前 host-tools 调
//    ingestVoice 后丢弃回执，删除传播无从定位远端副本）
//  - oido_delete_intents：est 源删除 → 远端物理清理的 outbox 式重试意图
//    （成功/404=删除行；失败退避下跳再试；重启恢复=表即状态）
MIGRATIONS.push({ version: 37, name: 'oido_ingest_and_delete_intents', sql: `
CREATE TABLE oido_ingest_receipts(
 est_asset_id TEXT PRIMARY KEY,
 content_sha256 TEXT NOT NULL,
 oido_audio_id TEXT NOT NULL,
 deduplicated INTEGER NOT NULL,
 ingested_at TEXT NOT NULL
);
CREATE TABLE oido_delete_intents(
 est_asset_id TEXT PRIMARY KEY,
 oido_audio_id TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
` });
// 36（2026-10-24，RE-05）：oído 测量图派生工件——PNG 字节落本地媒体资产（derived_view 用途），
// 本表记 analysis+range → asset 映射；UI 二进制路由与宿主原生图物化共用。base64 不入模型 JSON。
MIGRATIONS.push({ version: 38, name: 'oido_view_artifacts', sql: `
CREATE TABLE oido_view_artifacts(
 analysis_id TEXT NOT NULL,
 range_json TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(analysis_id, range_json)
);
CREATE INDEX IF NOT EXISTS idx_oido_view_asset ON oido_view_artifacts(asset_id);
` });
export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
