// 建库迁移：01 §16 最小数据表。迁移前记录 code_hash；不可逆变更需先备份（18.2）。
import type { Db } from './connection.ts';
import { validateAbsoluteIso } from '../util/time.ts';
import { tx } from './connection.ts';

export const MIGRATIONS: Array<{ version: number; name: string; sql: string; preSql?: string; postSql?: string; repair?: (db: Db) => number }> = [
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
// 39（2026-10-24，B2 电话核心 P0）：通话生命周期与电话轮幂等接纳。
//  - voice_calls：Siren 通话↔est 会话绑定（active 期间该会话模型工具走 memory_only 策略）；
//  - voice_stream_turns：(call_id, turn_key) 幂等接纳——同键同文=重放终态回执；同键异文=409。
MIGRATIONS.push({ version: 39, name: 'voice_calls_and_stream_turns', sql: `
CREATE TABLE voice_calls(
 call_id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('active','ended')),
 started_at TEXT NOT NULL,
 ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_conv ON voice_calls(conversation_id, state);
CREATE TABLE voice_stream_turns(
 call_id TEXT NOT NULL,
 turn_key TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 text_sha256 TEXT NOT NULL,
 est_turn_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('admitted','running','completed','failed','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(call_id, turn_key)
);
` });
// 40（2026-10-24，拒接/取消留言调度）：程序事实轮——宿主注入的事实（她拒接/他取消来电），
// 非用户发言（不进 messages 表）；turn=input_message_id NULL 的空尾轮，事实文本存本表，
// runTurn 组装时以 [program_fact] 块注入 prompt。dedupe_key（invite+action）幂等：重试不重建轮。
MIGRATIONS.push({ version: 40, name: 'program_fact_turns', sql: `
CREATE TABLE program_fact_turns(
 turn_id TEXT PRIMARY KEY,
 dedupe_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 fact_text TEXT NOT NULL,
 created_at TEXT NOT NULL
);
` });
// 41（2026-10-24，她发起通话·char可拒）：dial_requests——她→他方向的通话请求
//（区别于 Siren 邀请=他→她来电）。pending→accepted(带连接)|declined|cancelled|expired；
// 惰性过期（GET current 判定）；declined 时他的话=拒绝轮正文自然落会话。
MIGRATIONS.push({ version: 41, name: 'dial_requests', sql: `
CREATE TABLE dial_requests(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','expired')),
 ttl_ms INTEGER NOT NULL,
 ws_url TEXT, call_token TEXT, call_id TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
` });
// 42（2026-10-26，复审 R-03）：invite_call_handoffs——他→她邀请的接听建呼归属。
// 同一 invite 的接听重试（Siren 幂等返回 accepted/changed=false）取回同一交接结果，
// 不再重复建呼遗留无连接的 active 记录；expires_at 过期或通话结束后如实告知。
MIGRATIONS.push({ version: 42, name: 'invite_call_handoffs', sql: `
CREATE TABLE invite_call_handoffs(
 invite_id TEXT PRIMARY KEY,
 call_id TEXT NOT NULL,
 ws_url TEXT NOT NULL,
 call_token TEXT NOT NULL,
 expires_at TEXT,
 created_at TEXT NOT NULL
);
` });
// 43（2026-10-26，复审二 R-03B）：voice_calls.connected_at——Siren WS 会话注册
//（lifecycle register 通知）= 通话真实建立连接的事实。连接 token 过期只影响新握手、
// 不等于通话结束；收口只依据连接/结束事实，不按 token 时效推断。
MIGRATIONS.push({ version: 43, name: 'voice_calls_connected_at', sql: `
ALTER TABLE voice_calls ADD COLUMN connected_at TEXT;
` });
// 44（2026-10-26，联合审计 JV-04）：voice_calls.reserved_until——建呼签发的连接资格
// 时效（Siren 短 token expires_at）。启动对账时：Siren 正本已 ended → 收口；
// 正本 active 但无 WS 会话且从未连接、签发时效已过 → 永不可连，收口孤儿。
MIGRATIONS.push({ version: 44, name: 'voice_calls_reserved_until', sql: `
ALTER TABLE voice_calls ADD COLUMN reserved_until TEXT;
` });
// 45（2026-10-26，GLM_VOICE_UNIFICATION）：通话分析模式——P04：普通电话不自动
// oído；深听电话由服务端模式分流（不能只以 oido configured 判断）。NULL=历史
// 未记录（不伪造）；新通话显式写 'ordinary'/'deep_listen'。dial_requests 同步
// 记录她发起方向的模式，accept_call 建呼时沿用。
MIGRATIONS.push({ version: 45, name: 'voice_analysis_mode', sql: `
ALTER TABLE voice_calls ADD COLUMN analysis_mode TEXT;
ALTER TABLE dial_requests ADD COLUMN analysis_mode TEXT;
` });
// 46（2026-10-26，GLM_VOICE_UNIFICATION P1/P2）：voice_observations——声音观察 sidecar。
// 观察是原消息附属信息（P07/P11：隐藏只改展示）；三事实分列：分析状态（oído 真实
// 枚举）/显示正文/模型投影快照+投递事实（dispatched_turn_id）。迟到结果只更新本表
//（03§5），不回写已派发历史。UNIQUE(message_id,revision,asset_id) 幂等。
MIGRATIONS.push({ version: 46, name: 'voice_observations', sql: `
CREATE TABLE voice_observations(
 id TEXT PRIMARY KEY,
 message_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 asset_id TEXT NOT NULL,
 direction TEXT NOT NULL CHECK (direction IN ('user','assistant','system_filler')),
 status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','partial','failed','unsupported')),
 display_text TEXT,
 model_projection TEXT,
 dispatched_turn_id TEXT,
 dispatched_at TEXT,
 analysis_id TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(message_id, revision, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_obs_msg ON voice_observations(message_id, revision);
` });
// 47（2026-10-26，GLM_VOICE_UNIFICATION F03）：观察补同步标记——ready 且正文已
// ACK 后发 M 附属补同步（幂等键=obs 身份）；成功时间戳防重发。
MIGRATIONS.push({ version: 47, name: 'voice_obs_sync_marker', sql: `
ALTER TABLE voice_observations ADD COLUMN attachment_synced_at TEXT;
` });
// 48（2026-10-26，GLM_VOICE_UNIFICATION JV-17 03§4.2）：快观察幂等键留档——
// 深听同资产同 profile 无 range 时复用同一分析任务（oído 同 digest 去重），
// 不再重复 DSP；带 range=不同语义身份照旧新键。
MIGRATIONS.push({ version: 48, name: 'oido_quick_analysis_key', sql: `
ALTER TABLE oido_ingest_receipts ADD COLUMN analysis_key TEXT;
` });
// 分析结果与首次实际请求的投影分开，不为旧数据伪造派发证明。
MIGRATIONS.push({ version: 49, name: 'voice_observation_projection', sql: `
ALTER TABLE voice_observations ADD COLUMN evidence_json TEXT;
ALTER TABLE voice_observations ADD COLUMN projection_request_id TEXT;
` });
// 50（2026-10-27，联合审计 A04）：通话回复媒体关联——Siren 持有原声/回复 WAV 与播放
// 事实，est 按真实 turn UUID 拉取并为已发布助手消息建立持久绑定（附件行+交付状态）。
// (call_id, turn_key) 唯一：晚到/重复拉取收敛为同一行，不新增消息、不重编号。
MIGRATIONS.push({ version: 50, name: 'voice_reply_links', sql: `
CREATE TABLE voice_reply_links(
 call_id TEXT NOT NULL,
 turn_key TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 est_turn_id TEXT,
 message_id TEXT,
 revision INTEGER,
 siren_turn_id TEXT,
 siren_asset_id TEXT,
 est_asset_id TEXT,
 completeness TEXT CHECK (completeness IS NULL OR completeness IN ('complete','partial')),
 sent_audio_ms INTEGER,
 playback_json TEXT,
 link_state TEXT NOT NULL DEFAULT 'pending' CHECK (link_state IN ('pending','linked','unavailable')),
 observation_registered INTEGER NOT NULL DEFAULT 0,
 source_media_synced_at TEXT,
 source_call_synced_basis TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(call_id, turn_key)
);
CREATE INDEX IF NOT EXISTS idx_voice_reply_links_msg ON voice_reply_links(message_id);
` });
// v51：接在当前SDK/语音发布线之后；既有v1–v50迁移及其hash保持原样。
//  - surfacing_jobs 增列：sol 判定/依据/计划/usage（旧 hypotheses_json 保留
//    存量行，不再写入——旧分句假设链退役）；
//  - surfacing_settings：自动浮现设置覆盖（模板/模型；与配置文件同源合并，
//    预览与实际请求共用同一生效值读者）。
MIGRATIONS.push({
  version: 51,
  name: 'surfacing-sol-decision-state',
  sql: `
ALTER TABLE surfacing_jobs ADD COLUMN sol_decision TEXT;
ALTER TABLE surfacing_jobs ADD COLUMN sol_topic TEXT;
ALTER TABLE surfacing_jobs ADD COLUMN sol_basis TEXT;
ALTER TABLE surfacing_jobs ADD COLUMN sol_plan_json TEXT;
ALTER TABLE surfacing_jobs ADD COLUMN sol_usage_json TEXT;
CREATE TABLE surfacing_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
});
// v52（R9，裁定 2026-11-03）：surfacing_jobs 增列——M 响应返回的真实
// 政策/提示词版本。作业唯一键继续用 E 自身调度身份（schema
// memory_surfacing.job_policy_revision / job_prompt_revision）；本列只做
// 观测与失效对账依据（"M 实际执行的是什么版本"），不参与键。
MIGRATIONS.push({
  version: 52,
  name: 'surfacing-m-execution-versions',
  sql: `
ALTER TABLE surfacing_jobs ADD COLUMN m_policy_revision INTEGER;
ALTER TABLE surfacing_jobs ADD COLUMN m_prompt_revision TEXT;
`,
});

MIGRATIONS.push({version:53,name:'frozen-tool-groups-and-delivery',sql:`
ALTER TABLE window_toolsets ADD COLUMN groups_json TEXT;
ALTER TABLE window_toolsets ADD COLUMN initial_text TEXT;
ALTER TABLE provider_requests ADD COLUMN tool_context_json TEXT;
`});
// 54（2026-11-04，执行稿 B4）：pending_program_facts——一次性程序事实待消费
// （首个用例：通话结束事实，随下一次正常文字请求附带，不为此花独立模型轮）。
// 消费=该事实随本轮尾部装配发出（onBeforeDispatch 后置 consumed）；崩溃/取消保留待重试。
MIGRATIONS.push({version:54,name:'pending-program-facts',sql:`
CREATE TABLE pending_program_facts(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 fact_text TEXT NOT NULL,
 created_at TEXT NOT NULL,
 consumed_at TEXT
);
CREATE INDEX idx_pending_facts_conv ON pending_program_facts(conversation_id, consumed_at);
`});
// 55（2026-11-04，四仓联合审计 F04）：analysis_input_digest——快观察键复用时的输入
// 版本快照（转写文本摘要；'-'=无转写）。修复：E 把分析操作键永久绑定音频资产，
// 迟到转写改变 O 输入 digest 后同键 409，提示"重新发起"但下一次仍取旧键→永远失败。
// 旧行 digest=NULL 视为不匹配→不复用快键（保守自愈，走 legacy 新键）。
MIGRATIONS.push({version:55,name:'oido-analysis-input-digest',sql:`
ALTER TABLE oido_ingest_receipts ADD COLUMN analysis_input_digest TEXT;
`});
// 56（2026-11-06，四仓合并审计 F06/F07 P1）：content owner 已应用版本锚——
// 每个内容对象最近一次按权威快照确认到的 owner_revision 与成员集合（含删除/零集合）。
// 迟到旧确认按单调准入跳过；零集合完成版本不依赖活跃引用行（旧确认不能复活删除）。
// 确认事务 = 本表 + asset_external_refs 映射 + outbox(content.operation) ack 同步维护。
MIGRATIONS.push({version:56,name:'content-owner-applied-state',sql:`
CREATE TABLE IF NOT EXISTS content_owner_state(
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  applied_revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  asset_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
`});
// 57（2026-11-06，四仓审计 V01/P2）：语音观察资格终结——每个正式消息修订的深听
// 采纳决定只落一次（delivered=随首次模型输入提交；abandoned=资格放弃）。决定之后：
// 不再驱动分析、迟到结果不写行、UI/Source 不再消费新成功、在途 O 分析被取消。
MIGRATIONS.push({version:57,name:'voice-observation-decisions',sql:`
CREATE TABLE IF NOT EXISTS voice_observation_decisions(
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('delivered','abandoned')),
  turn_id TEXT,
  request_id TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (message_id, revision)
);
`});

// RB05（复审 20261106）：free-activity 显式入口接通正式分派后，origin='free_activity'
// 被 v33 的 CHECK 拒绝（handler 此前 404 不可达，从未真实执行）。backgroundControl 按
// origin!=='self_schedule' 路由 free_activity 控制——补列值 CHECK 需整表重建
//（SQLite 不能改 CHECK；background_runs 无 FK 引用本表，重建安全；索引重建）。
MIGRATIONS.push({version:58,name:'background-task-origin-free-activity',sql:`
CREATE TABLE background_tasks_v58(
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
  updated_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK (origin IN ('self_schedule','system_keepwarm','legacy_unknown','free_activity')),
  control_reason TEXT,
  client_operation_key TEXT
);
INSERT INTO background_tasks_v58(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,local_time,interval_ms,payload_json,created_by_actor_id,created_at,updated_at,origin,control_reason,client_operation_key)
  SELECT id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,local_time,interval_ms,payload_json,created_by_actor_id,created_at,updated_at,origin,control_reason,client_operation_key FROM background_tasks;
DROP TABLE background_tasks;
ALTER TABLE background_tasks_v58 RENAME TO background_tasks;
CREATE INDEX IF NOT EXISTS idx_bg_tasks_due ON background_tasks(enabled, next_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_tasks_client_op ON background_tasks(conversation_id, client_operation_key) WHERE client_operation_key IS NOT NULL;
`});

// RV2-01（复审 20261106 第二轮）：区分"消息已发"与"分析被本轮采纳"——观察行记录
// 该次分析快照是否真正随首次模型输入采用（analysis_adopted）。未采纳的分析（超时
// 占位轮的迟到结果）不得再被任何消费面当成功读取。历史行按"已用于派发且有模型
// 投影"回填为已采纳。
MIGRATIONS.push({version:59,name:'voice-observation-analysis-adopted',sql:`
ALTER TABLE voice_observations ADD COLUMN analysis_adopted INTEGER NOT NULL DEFAULT 0;
UPDATE voice_observations SET analysis_adopted = 1
 WHERE status IN ('ready','partial') AND projection_request_id IS NOT NULL AND model_projection IS NOT NULL;
`});

// RB2-01（复审 20261106 第二轮）：模型主动邀请的宿主忠实投影——S 是邀请正本，
// E 只保存同步准入（Sol 门/忙时判定）所需的活动事实；期限=S 的 expires_at，
// 读时解释，不依赖前端轮询。接听/拒接/过期由 state=ended 收口。
MIGRATIONS.push({version:60,name:'voice-invites-mirror',sql:`
CREATE TABLE IF NOT EXISTS voice_invites(
  invite_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','ended')),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_invites_activity ON voice_invites(conversation_id, state, expires_at);
`});

// R3-M01（第三轮复审 20261106）：v61 重建 tool_side_effects 时把既有 seen_sequence 一并
// SELECT 成 NULL（该列自旧迁移早已存在，7 条生产 committed 行被清空）。v61 已在生产应用、
// code_hash 校验禁止原地改写，且保留 v61 会让未升级库（如从 G4 前备份恢复）先丢数据再无据可恢复
// ——因此从迁移序列移除 v61，由 v62 以条件重建统一两种库形：v61 前形状（有 seen_sequence、
// 无 args_json、CHECK 无 i_write）整表重建并**保留 seen_sequence**；v61 后形状（生产）已是
// 目标 schema，v62 幂等跳过。生产已清空的 7 条为 committed 终态、无消费者，不回填（复审已撤销）。
MIGRATIONS.push({version:62,name:'tool-side-effects-rebuild-preserve-seen-sequence',sql:`
SELECT 1; -- 结构性重建由 repair 按到达形状条件执行（两种库形列集不同，无法用单一 SQL 同时覆盖）
`, repair: (db): number => {
  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_side_effects'").get() as { sql: string } | undefined)?.sql ?? '';
  const cols = new Set((db.prepare('PRAGMA table_info(tool_side_effects)').all() as Array<{ name: string }>).map((c) => c.name));
  if (cols.has('args_json') && tableSql.includes("'i_write'")) return 0; // v61 后形状：已是目标 schema
  db.exec(`CREATE TABLE tool_side_effects_v62(
    id TEXT PRIMARY KEY,
    review_id TEXT,
    turn_id TEXT,
    window_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('hold','source_bind','review_complete','i_write')),
    state TEXT NOT NULL CHECK (state IN ('pending','running','unknown','failed_unresolved','failed_resolved','committed','cancelled')),
    verified INTEGER NOT NULL DEFAULT 0,
    memory_id TEXT,
    operation_id TEXT,
    tool_call_id TEXT,
    seen_sequence INTEGER,
    args_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  // R3-M01：seen_sequence 原值保留（旧库自早期迁移已有该列）；args_json 为新列，旧库无则置 NULL
  db.exec(`INSERT INTO tool_side_effects_v62(id,review_id,turn_id,window_id,kind,state,verified,memory_id,operation_id,tool_call_id,seen_sequence,args_json,created_at,updated_at)
    SELECT id,review_id,turn_id,window_id,kind,state,verified,memory_id,operation_id,tool_call_id,
           ${cols.has('seen_sequence') ? 'seen_sequence' : 'NULL'},
           ${cols.has('args_json') ? 'args_json' : 'NULL'},
           created_at,updated_at FROM tool_side_effects`);
  db.exec('DROP TABLE tool_side_effects');
  db.exec('ALTER TABLE tool_side_effects_v62 RENAME TO tool_side_effects');
  return 1;
}});

// R3-V02（第三轮复审 20261106）：v59 回填把"先冻结尚未就绪占位、后晚到 ready"的旧行误判
// 为已采纳（projection 非空可能是占位文案而非分析证据）。生产命中 0（复审核实），本迁移
// 保护从旧备份恢复的库：占位文案行改回未采纳。
MIGRATIONS.push({version:63,name:'voice-observation-placeholder-adoption-corrective',sql:`
UPDATE voice_observations SET analysis_adopted = 0
 WHERE analysis_adopted = 1
   AND model_projection LIKE '%尚未就绪%';
`});

// v64（相册重构 P2，GLM_ALBUM_REFACTOR_EXECUTION 20261108）：M 成为媒体字节唯一长期
// 正本——media_assets 记录每个资产在 M 的落正状态。m_sync_state 仅两值：
// pending=本地已存、M 落正待完成（初始与可重试失败都回到这里）；synced=M 已确认
// content_hash。attempts/last_error 供可见状态与退避重试；不设终态 failed——重试由
// 后台循环带退避推进，不静默放弃也不假装成功。存量行默认 pending，由存量迁移脚本补齐。
MIGRATIONS.push({
  version: 64,
  name: 'media-assets-mariposa-master',
  sql: `
ALTER TABLE media_assets ADD COLUMN m_content_hash TEXT;
ALTER TABLE media_assets ADD COLUMN m_sync_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE media_assets ADD COLUMN m_sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN m_synced_at TEXT;
ALTER TABLE media_assets ADD COLUMN m_last_sync_error TEXT;
UPDATE media_assets SET m_sync_state='out_of_scope' WHERE ingest_purpose='chat_voice';
`,
});

// v65（相册重构 P5）：随窗携带计划——新窗初始化时把开窗携带图片集合（选集图+相册
// 携带，去重 ≤CARRY_IMAGE_LIMIT）定格。plan_json 为审计/减选提示的正本快照；
// has_next_once 标记本窗初始资料含"下次滚窗一次"项，窗内首次成功投递后置
// consumed_at（对应 content carry-set 的 next_once 消费），未成功前保持 NULL。
MIGRATIONS.push({
  version: 65,
  name: 'window-carry-plans',
  sql: `
CREATE TABLE IF NOT EXISTS window_carry_plans(
  window_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  has_next_once INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
`,
});

// v66（相册重构 P4）：宿主一次性通知——用户侧操作（如对话存档）的结果告知模型，
// 在下一次正常请求的信封装配时投递一次（独立 system 数据块，authority=none），
// 投递即标记 delivered_at（SDK 会话前缀保留已发内容，重试不重复）。工具发起的
// 操作回执即通知，不排队。dedupe_key 幂等（同操作身份只投一次）。
MIGRATIONS.push({
  version: 66,
  name: 'host-notices',
  sql: `
CREATE TABLE IF NOT EXISTS host_notices(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_host_notices_pending ON host_notices(conversation_id, delivered_at);
`,
});

// v67（相册重构 P3）：图片生成两阶段操作账——生成成功即暂存字节（result_b64），
// 入库失败重试只走存储不二次付费生成；saved 后清空暂存（字节正本在 media/M）。
// unknown=供应商结果未确认（禁止自动重发）。
MIGRATIONS.push({
  version: 67,
  name: 'imagegen-operations',
  sql: `
CREATE TABLE IF NOT EXISTS imagegen_operations(
  op_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  result_b64 TEXT,
  asset_id TEXT,
  creation_id TEXT,
  revised_prompt TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
});

// v68（相册整改 ALB-01，审计 2026-11-08）：E 本地媒体缓存 LRU 逐出——仅 M 已落正
// (m_sync_state='synced') 的资产可逐（语音/未 synced 永不）；行保留、读取回源 M。
MIGRATIONS.push({
  version: 68,
  name: 'media-assets-cache-lru',
  sql: `
ALTER TABLE media_assets ADD COLUMN cache_last_used_at TEXT;
`,
});

// v69（宿主用户 2026-11-08 裁定：语音同图片进 M 唯一正本——撤销 v64 对 chat_voice 的
// out_of_scope 标记）：存量语音行回到 pending，由 media-master-backfill 迁入 M。
MIGRATIONS.push({
  version: 69,
  name: 'chat-voice-to-mariposa-master',
  sql: `
UPDATE media_assets SET m_sync_state='pending' WHERE ingest_purpose='chat_voice' AND m_sync_state='out_of_scope';
`,
});

// v70（相册整改复审 2026-11-09，RR5/GIF）：
// ① 附件对象元数据补传标记——post-ACK 推送与存量/失败回推（backfillObjectMeta）
//    共用的"已推"正本（幂等 op 键在 M 侧去重，本地标记防无限重放放大）；
// ② imagegen 格式留存——同键重试的生成调用沿用首次请求的 output_format
//    （GIF 动图生成，她 2026-11-09 裁定 gpt-image 可生动图；不带格式供应商默认
//    静态 PNG，"画动图"被静默降级）。
MIGRATIONS.push({
  version: 70,
  name: 'album-rework-rr5-object-meta-marker-and-imagegen-format',
  sql: `
ALTER TABLE message_attachments ADD COLUMN object_meta_synced_at TEXT;
ALTER TABLE imagegen_operations ADD COLUMN output_format TEXT;
`,
});

// v71（包1 M02 2026-11-15）：附件 presentation 增加 work——SVG/HTML 代码作品引用。
// 交付走沙箱预览（/api/v1/assets/:id/preview），不进普通图片白名单。SQLite 不能改
// CHECK，整表重建（message_attachments 为叶子表，无 FK 引用，重建安全；索引重建）。
MIGRATIONS.push({
  version: 71,
  name: 'attachment-presentation-work',
  sql: `
CREATE TABLE message_attachments_v71(
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  presentation TEXT NOT NULL CHECK (presentation IN ('image','sticker','voice','work')),
  caption TEXT,
  derived_text TEXT,
  derived_source TEXT,
  created_at TEXT NOT NULL,
  object_meta_synced_at TEXT,
  PRIMARY KEY (message_id, revision, position)
);
INSERT INTO message_attachments_v71 SELECT message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at, object_meta_synced_at FROM message_attachments;
DROP TABLE message_attachments;
ALTER TABLE message_attachments_v71 RENAME TO message_attachments;
CREATE INDEX IF NOT EXISTS idx_msg_attachments_asset ON message_attachments(asset_id);
`,
});

// v72（包1审计返修 2026-11-15 P1-c/D02）：同键业务请求指纹——同 opKey 异参
// （prompt/格式/尺寸/帧参数/交付选择）按冲突拒绝，不把第一次的图当第二次结果。
MIGRATIONS.push({
  version: 72,
  name: 'imagegen-request-fingerprint',
  sql: `
ALTER TABLE imagegen_operations ADD COLUMN request_fingerprint TEXT;
`,
});

// v73（二轮返修 2026-11-15 P1-2/D01）：供应商 200+URL-only 应答的结果 URL 留存——
// 同键重试只重取 URL 恢复字节，不重新发起付费生成。
MIGRATIONS.push({
  version: 73,
  name: 'imagegen-result-url',
  sql: `
ALTER TABLE imagegen_operations ADD COLUMN result_url TEXT;
`,
});

// v74（包2 批C BIND 2026-11-16）：午夜来源绑定任务状态——每条已提交记忆的自动补绑
// 处理状态唯一正本（E 持有调度与状态；绑定写入走 M source.binding.bind 领域服务）。
MIGRATIONS.push({
  version: 74,
  name: 'source-bind-jobs',
  sql: `
CREATE TABLE IF NOT EXISTS source_bind_jobs(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE,
  memory_version INTEGER,
  conversation_id TEXT,
  turn_id TEXT,
  batch_boundary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','bound','no_match','source_unavailable','failed','version_conflict','skipped_existing')),
  detail TEXT,
  binding_ids_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_bind_jobs_status ON source_bind_jobs(status);
`,
});

// v75（包2 返修 2026-11-17，Codex 复审指令）：①status 封闭枚举加 credential_blocked
//（402/401 凭据余额类故障——当日熔断不耗尝试次数，跨上海日界自动复活；SQLite 不能
// ALTER CHECK，整表重建保留数据）；②加 pending_segments_json（多段部分成功时存
// 剩余段——恢复时只补缺段不重新付费判断）。
MIGRATIONS.push({
  version: 75,
  name: 'source-bind-jobs-retry-semantics',
  sql: `
CREATE TABLE IF NOT EXISTS source_bind_jobs_v75(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE,
  memory_version INTEGER,
  conversation_id TEXT,
  turn_id TEXT,
  batch_boundary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','bound','no_match','source_unavailable','failed','version_conflict','skipped_existing','credential_blocked')),
  detail TEXT,
  binding_ids_json TEXT,
  pending_segments_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO source_bind_jobs_v75(id, memory_id, memory_version, conversation_id, turn_id, batch_boundary, status, detail, binding_ids_json, pending_segments_json, attempts, created_at, updated_at)
  SELECT id, memory_id, memory_version, conversation_id, turn_id, batch_boundary, status, detail, binding_ids_json, NULL, attempts, created_at, updated_at FROM source_bind_jobs;
DROP TABLE source_bind_jobs;
ALTER TABLE source_bind_jobs_v75 RENAME TO source_bind_jobs;
CREATE INDEX IF NOT EXISTS idx_source_bind_jobs_status ON source_bind_jobs(status);
`,
});

// v76（包2 生命周期返修 2026-11-17）：status 枚举加 judging（判断已发出的在途事实——
// 发出前落账，重启后可追溯不重记；SQLite 不能 ALTER CHECK，整表重建保留数据）。
MIGRATIONS.push({
  version: 76,
  name: 'source-bind-jobs-judging',
  sql: `
CREATE TABLE IF NOT EXISTS source_bind_jobs_v76(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE,
  memory_version INTEGER,
  conversation_id TEXT,
  turn_id TEXT,
  batch_boundary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','judging','bound','no_match','source_unavailable','failed','version_conflict','skipped_existing','credential_blocked')),
  detail TEXT,
  binding_ids_json TEXT,
  pending_segments_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO source_bind_jobs_v76(id, memory_id, memory_version, conversation_id, turn_id, batch_boundary, status, detail, binding_ids_json, pending_segments_json, attempts, created_at, updated_at)
  SELECT id, memory_id, memory_version, conversation_id, turn_id, batch_boundary, status, detail, binding_ids_json, pending_segments_json, attempts, created_at, updated_at FROM source_bind_jobs;
DROP TABLE source_bind_jobs;
ALTER TABLE source_bind_jobs_v76 RENAME TO source_bind_jobs;
CREATE INDEX IF NOT EXISTS idx_source_bind_jobs_status ON source_bind_jobs(status);
`,
});

MIGRATIONS.push({
  version: 77, name: 'source-bind-decision',
  sql: `ALTER TABLE source_bind_jobs ADD COLUMN operation_id TEXT;
    ALTER TABLE source_bind_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    UPDATE source_bind_jobs SET status='failed', detail='上次判断结果未知，请在日历中手动重算。'
      WHERE status='judging' OR (status='pending' AND attempts>0);
    UPDATE source_bind_jobs SET detail=substr(detail,1,instr(detail,'——')-1) || '。请在日历中手动重算。'
      WHERE status IN ('failed','source_unavailable','credential_blocked','version_conflict') AND instr(detail,'——')>0;`,
});

MIGRATIONS.push({
  version: 78, name: 'verified-hold-commit-time',
  sql: 'ALTER TABLE tool_side_effects ADD COLUMN hold_committed_at TEXT;',
});

MIGRATIONS.push({
  version: 79, name: 'imagegen-origin-target',
  sql: `ALTER TABLE imagegen_operations ADD COLUMN origin_room_id TEXT;
    ALTER TABLE imagegen_operations ADD COLUMN origin_background_run_id TEXT;`,
});

MIGRATIONS.push({
  version: 80, name: 'require-observed-hold-commit-time',
  // v78 accepted transaction-internal timestamps. Keep the successful effects
  // and existing jobs, but handle uncollected ones as unproven for time-of-day.
  sql: "UPDATE tool_side_effects SET hold_committed_at=NULL WHERE kind='hold' AND hold_committed_at IS NOT NULL;",
});

MIGRATIONS.push({
  version: 81, name: 'turn-completion-intent',
  sql: `ALTER TABLE attempts ADD COLUMN completion_outcome TEXT CHECK (completion_outcome IN ('done', 'noop'));`,
});

MIGRATIONS.push({
  version: 82,
  name: 'heartbeat-decks-and-delivery',
  sql: `
CREATE TABLE heartbeat_decks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  business_date TEXT NOT NULL,
  UNIQUE (conversation_id, business_date)
);
CREATE TABLE heartbeat_cards (
  deck_id TEXT NOT NULL REFERENCES heartbeat_decks(id),
  card_number INTEGER NOT NULL CHECK(card_number BETWEEN 1 AND 10),
  source_identity TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('wishstar','memory','archive','album','moments','reserved_note')),
  source_ref_json TEXT NOT NULL,
  first_response_replay INTEGER NOT NULL DEFAULT 0 CHECK(first_response_replay IN (0,1)),
  invalid_reason TEXT,
  PRIMARY KEY (deck_id, card_number),
  UNIQUE (deck_id, source_identity)
);
CREATE TABLE heartbeat_runs (
  run_id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  deck_id TEXT REFERENCES heartbeat_decks(id),
  mode TEXT NOT NULL CHECK(mode IN ('unprepared','source_unavailable','draw','exhausted_keepwarm')),
  corrections INTEGER NOT NULL DEFAULT 0 CHECK(corrections BETWEEN 0 AND 2)
);
CREATE TABLE heartbeat_draw_operations (
  run_id TEXT NOT NULL REFERENCES heartbeat_runs(run_id),
  operation_id TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  deck_id TEXT,
  card_number INTEGER,
  source_identity TEXT,
  state TEXT NOT NULL CHECK(state IN ('rejected','claimed','prepared','dispatching','delivered','not_dispatched','unknown')),
  reason TEXT,
  remaining_json TEXT,
  retry_allowed INTEGER CHECK(retry_allowed IN (0,1)),
  attempted_at TEXT,
  delivered_at TEXT,
  provider_request_id TEXT,
  PRIMARY KEY (run_id, operation_id),
  FOREIGN KEY (deck_id, card_number) REFERENCES heartbeat_cards(deck_id, card_number),
  CHECK(state != 'delivered' OR (provider_request_id IS NOT NULL AND delivered_at IS NOT NULL))
);
CREATE INDEX idx_heartbeat_draw_source ON heartbeat_draw_operations(source_identity,state,delivered_at,attempted_at);
CREATE INDEX idx_heartbeat_draw_card ON heartbeat_draw_operations(deck_id,card_number,state);
CREATE UNIQUE INDEX idx_heartbeat_draw_one_per_run ON heartbeat_draw_operations(run_id)
  WHERE state IN ('claimed','prepared','dispatching','delivered','unknown');
CREATE UNIQUE INDEX idx_heartbeat_draw_source_in_flight ON heartbeat_draw_operations(source_identity)
  WHERE state IN ('claimed','prepared','dispatching');
CREATE UNIQUE INDEX idx_heartbeat_card_delivered ON heartbeat_draw_operations(deck_id,card_number)
  WHERE state = 'delivered';
`,
});

MIGRATIONS.push({
  version: 83, name: 'imagegen-photo-album-destination',
  sql: `ALTER TABLE imagegen_operations ADD COLUMN album_kind TEXT;
    ALTER TABLE imagegen_operations ADD COLUMN album_caption TEXT;
    ALTER TABLE imagegen_operations ADD COLUMN album_entry_id TEXT;`,
});

MIGRATIONS.push({
  version: 84, name: 'recoverable-completion-protocol',
  sql: 'ALTER TABLE attempts ADD COLUMN completion_recovery_json TEXT;',
});

MIGRATIONS.push({
  version: 85, name: 'trusted-heartbeat-source-extensions',
  // Rebuild both sides of the FK together, preserving every existing fixed
  // reference, draw receipt and uniqueness constraint. Registration lives in Host.
  sql: `
CREATE TABLE heartbeat_cards_v85 (
  deck_id TEXT NOT NULL REFERENCES heartbeat_decks(id),
  card_number INTEGER NOT NULL CHECK(card_number BETWEEN 1 AND 10),
  source_identity TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('wishstar','memory','archive','album','moments','reserved_note')
    OR (source_kind GLOB 'ext:[a-z]*' AND length(source_kind) BETWEEN 5 AND 68
       AND substr(source_kind,5) NOT GLOB '*[^a-z0-9_-]*' AND source_kind!='ext:family')),
  source_ref_json TEXT NOT NULL,
  first_response_replay INTEGER NOT NULL DEFAULT 0 CHECK(first_response_replay IN (0,1)),
  invalid_reason TEXT,
  PRIMARY KEY (deck_id, card_number),
  UNIQUE (deck_id, source_identity)
);
INSERT INTO heartbeat_cards_v85 SELECT * FROM heartbeat_cards;
CREATE TABLE heartbeat_draw_operations_v85 (
  run_id TEXT NOT NULL REFERENCES heartbeat_runs(run_id),
  operation_id TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  deck_id TEXT,
  card_number INTEGER,
  source_identity TEXT,
  state TEXT NOT NULL CHECK(state IN ('rejected','claimed','prepared','dispatching','delivered','not_dispatched','unknown')),
  reason TEXT,
  remaining_json TEXT,
  retry_allowed INTEGER CHECK(retry_allowed IN (0,1)),
  attempted_at TEXT,
  delivered_at TEXT,
  provider_request_id TEXT,
  PRIMARY KEY (run_id, operation_id),
  FOREIGN KEY (deck_id, card_number) REFERENCES heartbeat_cards_v85(deck_id, card_number),
  CHECK(state != 'delivered' OR (provider_request_id IS NOT NULL AND delivered_at IS NOT NULL))
);
INSERT INTO heartbeat_draw_operations_v85 SELECT * FROM heartbeat_draw_operations;
DROP TABLE heartbeat_draw_operations;
DROP TABLE heartbeat_cards;
ALTER TABLE heartbeat_cards_v85 RENAME TO heartbeat_cards;
ALTER TABLE heartbeat_draw_operations_v85 RENAME TO heartbeat_draw_operations;
CREATE INDEX idx_heartbeat_draw_source ON heartbeat_draw_operations(source_identity,state,delivered_at,attempted_at);
CREATE INDEX idx_heartbeat_draw_card ON heartbeat_draw_operations(deck_id,card_number,state);
CREATE UNIQUE INDEX idx_heartbeat_draw_one_per_run ON heartbeat_draw_operations(run_id)
  WHERE state IN ('claimed','prepared','dispatching','delivered','unknown');
CREATE UNIQUE INDEX idx_heartbeat_draw_source_in_flight ON heartbeat_draw_operations(source_identity)
  WHERE state IN ('claimed','prepared','dispatching');
CREATE UNIQUE INDEX idx_heartbeat_card_delivered ON heartbeat_draw_operations(deck_id,card_number)
  WHERE state = 'delivered';
`,
});

MIGRATIONS.push({
  version: 86, name: 'heartbeat-business-action-references',
  sql: `
ALTER TABLE heartbeat_runs ADD COLUMN invite_text TEXT;
CREATE TABLE heartbeat_actions (
  run_id TEXT NOT NULL REFERENCES heartbeat_runs(run_id),
  call_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  PRIMARY KEY (run_id, call_id)
);
`,
});

MIGRATIONS.push({
  version: 87, name: 'heartbeat-midnight-memory-choice',
  sql: `
CREATE TABLE background_tasks_v87(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('autonomous','keepwarm','reminder','heartbeat_memory')),
  enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once','daily','interval','cache_idle')),
  scheduled_at TEXT, next_due_at TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', local_time TEXT,
  interval_ms INTEGER, payload_json TEXT NOT NULL DEFAULT '{}', created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK (origin IN ('self_schedule','system_keepwarm','legacy_unknown','free_activity','system_heartbeat_memory')),
  control_reason TEXT, client_operation_key TEXT
);
INSERT INTO background_tasks_v87 SELECT * FROM background_tasks;
DROP TABLE background_tasks;
ALTER TABLE background_tasks_v87 RENAME TO background_tasks;
CREATE INDEX idx_bg_tasks_due ON background_tasks(enabled,next_due_at);
CREATE UNIQUE INDEX idx_bg_tasks_client_op ON background_tasks(conversation_id,client_operation_key) WHERE client_operation_key IS NOT NULL;
CREATE TABLE heartbeat_daily_memory_choices(
  conversation_id TEXT NOT NULL REFERENCES conversations(id), business_date TEXT NOT NULL,
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL, frozen_at TEXT NOT NULL, selected_at TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES background_runs(id), provider_response_id TEXT,
  PRIMARY KEY(conversation_id,business_date)
);
`,
});

// NULL preserves historical native/deferred snapshots. New native windows
// start with an empty ordered list of discoveries alongside their frozen opener.
MIGRATIONS.push({
  version: 88, name: 'window-on-demand-tools',
  sql: 'ALTER TABLE window_toolsets ADD COLUMN activated_tools_json TEXT;',
});

// NULL keeps the discovery and parameter semantics of already-open windows.
MIGRATIONS.push({
  version: 89, name: 'frozen-tool-capability-summaries',
  sql: 'ALTER TABLE window_toolsets ADD COLUMN tool_summaries_json TEXT;',
});

MIGRATIONS.push({
  version: 90, name: 'milestone-write-receipts',
  sql: 'ALTER TABLE audit_events ADD COLUMN receipt_json TEXT;',
});

// 0 keeps every existing conversation on its current schedule. Rest is only
// established by a new owner statement or an explicit control operation.
MIGRATIONS.push({
  version: 91, name: 'conversation-rest-decision',
  sql: `ALTER TABLE conversation_activity ADD COLUMN resting INTEGER NOT NULL DEFAULT 0 CHECK (resting IN (0,1));
    ALTER TABLE conversation_activity ADD COLUMN rest_decided_at TEXT;
    ALTER TABLE conversation_activity ADD COLUMN rest_source TEXT;
    ALTER TABLE conversation_activity ADD COLUMN rest_message_id TEXT;`,
});

// v92（心跳规则重构 v2.1）：分离"她是否出现"、"双方末句/有效心跳锚点"与"连续未出现次数"；
// 区分正常夜休（次晨 08:00 兜底）与 02:00 起补觉/午睡（等下条新消息）；绑定夜间四小时判定、
// 异步 Sol 休息判断版本栅栏与在线让位事实。不扫描历史对话；旧库保留既有手动关、有效休息与
// 已确认机会，连续未出现次数从 0 起算（旧库无独立出现版本与单机会计数标记，无法可靠反推）。
MIGRATIONS.push({
  version: 92,
  name: 'heartbeat-unified-v21-state',
  sql: `
ALTER TABLE conversation_activity ADD COLUMN user_appearance_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_activity ADD COLUMN last_user_message_id TEXT;
ALTER TABLE conversation_activity ADD COLUMN last_user_message_at TEXT;
ALTER TABLE conversation_activity ADD COLUMN rest_recovery_mode TEXT CHECK (rest_recovery_mode IS NULL OR rest_recovery_mode IN ('morning_0800','next_user_message'));
ALTER TABLE conversation_activity ADD COLUMN rest_morning_date TEXT;
ALTER TABLE conversation_activity ADD COLUMN early_resumed_date TEXT;
ALTER TABLE conversation_activity ADD COLUMN morning_fallback_superseded_date TEXT;
ALTER TABLE conversation_activity ADD COLUMN morning_yielded_date TEXT;
ALTER TABLE conversation_activity ADD COLUMN morning_yielded_at TEXT;
ALTER TABLE conversation_activity ADD COLUMN consecutive_unanswered_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_activity ADD COLUMN last_effective_heartbeat_at TEXT;
ALTER TABLE conversation_activity ADD COLUMN last_effective_heartbeat_run_id TEXT;
ALTER TABLE conversation_activity ADD COLUMN last_effective_heartbeat_window_id TEXT;
ALTER TABLE conversation_activity ADD COLUMN streak_paused_date TEXT;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_message_id TEXT;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_revision INTEGER;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_accepted_at TEXT;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_control_revision INTEGER;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_user_appearance_revision INTEGER;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_was_night_pause INTEGER;
ALTER TABLE conversation_activity ADD COLUMN pending_rest_gap_eligible INTEGER;
ALTER TABLE background_runs ADD COLUMN input_user_appearance_revision INTEGER;
ALTER TABLE background_runs ADD COLUMN streak_counted_at TEXT;
`,
  repair: (db: Db): number => {
    const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
    const rows = db.prepare('SELECT conversation_id, rest_decided_at FROM conversation_activity WHERE resting = 1 AND rest_recovery_mode IS NULL').all() as Array<{ conversation_id: string; rest_decided_at: string | null }>;
    let touched = 0;
    for (const row of rows) {
      const ms = row.rest_decided_at ? Date.parse(row.rest_decided_at) : NaN;
      let mode: 'morning_0800' | 'next_user_message' = 'next_user_message';
      let morningDate: string | null = null;
      if (Number.isFinite(ms)) {
        const sh = new Date(ms + SHANGHAI_OFFSET_MS);
        const hour = sh.getUTCHours();
        const dateStr = sh.toISOString().slice(0, 10);
        if (hour >= 18) {
          mode = 'morning_0800';
          morningDate = new Date(Date.parse(`${dateStr}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        } else if (hour < 2) {
          mode = 'morning_0800';
          morningDate = dateStr;
        }
      }
      db.prepare('UPDATE conversation_activity SET rest_recovery_mode = ?, rest_morning_date = ? WHERE conversation_id = ?')
        .run(mode, morningDate, row.conversation_id);
      touched++;
    }
    return touched;
  },
});

// v93（心跳 2.1 复审修复）：记录手动关→开事务内已过期的旧机会截止时间，
// 避免手动重新开启时补发关闭期间错过的 08:00 或 50 分钟心跳，同时不伪造真实发言时间。
MIGRATIONS.push({
  version: 93,
  name: 'heartbeat-v21-reenable-suppression',
  sql: 'ALTER TABLE conversation_activity ADD COLUMN keepwarm_suppressed_due_before_at TEXT;',
});

export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
