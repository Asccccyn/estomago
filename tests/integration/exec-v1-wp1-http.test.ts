// ESTOMAGO_CHAT_EXEC_V1 · WP1 HTTP 集成（05 §5/§9；TOKEN-03/04/05 + 红点端点鉴权与快照行为）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, OBSERVED_SDK } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildRecordSnapshot } from '../../apps/host/src/server/records.ts';

const root = tempRoot('exec-v1-wp1-http-');
writeApprovedIdentity(root);
let host: Host;
let base = '';
let token = '';
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

before(async () => {
  const config = buildConfig({
    deployment: { port: 0 },
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'mock' },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); });

test('TOKEN-03：token-estimates 语义只读——零模型调用、零消息/turn/轨迹写入；请求不可用时本条估计照给', async () => {
  const before = {
    messages: (host.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    turns: (host.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number }).n,
    attempts: (host.db.prepare('SELECT COUNT(*) n FROM attempts').get() as { n: number }).n,
    trajectories: (host.db.prepare('SELECT COUNT(*) n FROM window_trajectories').get() as { n: number }).n,
    requests: (host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number }).n,
  };
  // 未发过消息：无活动窗 → request 不可用（等待选集语义），message 照给
  const res = await fetch(`${base}/api/v1/token-estimates`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ conversation_id: 'primary', client_draft_revision: 7, content: '这封正文大约多长', attachments: [], include_request_estimate: true }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    client_draft_revision: number; model_snapshot_id: string; stale_after_state_change: boolean;
    chars_per_token: number;
    estimate: { message_text_tokens: number; request_input_tokens: number | null; request_unavailable_reason: string | null; quality: string; scope: string };
  };
  assert.equal(data.client_draft_revision, 7); // TOKEN-04：回包携带草稿版本（前端只应用匹配回包）
  assert.equal(data.stale_after_state_change, true);
  assert.ok(data.estimate.message_text_tokens > 0);
  assert.equal(data.estimate.request_input_tokens, null); // 不替用户零选，不只把正文相加冒充请求
  assert.ok(['pending_selection', 'no_sent_projection', 'unavailable'].includes(data.estimate.request_unavailable_reason!));
  assert.equal(data.estimate.scope, 'request_preview');
  const after = {
    messages: (host.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    turns: (host.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number }).n,
    attempts: (host.db.prepare('SELECT COUNT(*) n FROM attempts').get() as { n: number }).n,
    trajectories: (host.db.prepare('SELECT COUNT(*) n FROM window_trajectories').get() as { n: number }).n,
    requests: (host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number }).n,
  };
  assert.deepEqual(after, before); // 零副作用：不写 message/turn/attempt/轨迹/请求
});

test('TOKEN-03b：预估失败不禁发送；超 body 上限 413；坏请求 400', async () => {
  const tooBig = 'x'.repeat(600 * 1024); // > max_body_bytes 524288
  const res413 = await fetch(`${base}/api/v1/token-estimates`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ conversation_id: 'primary', client_draft_revision: 1, content: tooBig }),
  });
  assert.equal(res413.status, 413);
  const res400 = await fetch(`${base}/api/v1/token-estimates`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ conversation_id: 'primary', content: 123 }),
  });
  assert.equal(res400.status, 400);
  // 正常发送不受预估不可用影响（仍走既有容量/身份硬门）
  const send = await fetch(`${base}/api/v1/conversations/primary/messages`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: '预估坏了也要能发', client_message_id: 'cmid-t3b' }),
  });
  assert.ok(send.status === 200 || send.status === 201, `send status ${send.status}`);
});

test('TOKEN-05：发送前快照随 revision 保存；编辑=新快照；估计不改 content_hash；旧消息 null 不伪造', async () => {
  const send = await fetch(`${base}/api/v1/conversations/primary/messages`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: '第一条带快照的消息', client_message_id: 'cmid-t5' }),
  });
  assert.ok(send.status === 200 || send.status === 201, `send status ${send.status}`);
  const msg = ((await send.json()) as { message: { id: string; current_revision: number; revision: { content_hash: string; token_estimate: { model: string | null; message_text_tokens: number; estimator_revision: string; computed_at: string } | null } } }).message;
  assert.ok(msg.revision.token_estimate, '发送时应保存估计快照');
  assert.ok(msg.revision.token_estimate!.message_text_tokens > 0);
  assert.equal(msg.revision.token_estimate!.estimator_revision, 'rough-unicode-cpt-v1');
  assert.equal(msg.revision.content_hash, sha256Hex('第一条带快照的消息')); // 估计与正文 hash 分离
  // 编辑 → 新 revision + 新快照
  const edit = await fetch(`${base}/api/v1/conversations/primary/messages/${encodeURIComponent(msg.id)}`, {
    method: 'PUT', headers: auth({ 'Content-Type': 'application/json', 'If-Match': `"${msg.current_revision}"` }),
    body: JSON.stringify({ content: '编辑后的更长正文——新快照应当随之更新' }),
  });
  assert.equal(edit.status, 200);
  const edited = ((await edit.json()) as { message: { current_revision: number; revision: { token_estimate: { message_text_tokens: number } | null } } }).message;
  assert.equal(edited.current_revision, 2);
  assert.ok(edited.revision.token_estimate);
  assert.ok(edited.revision.token_estimate!.message_text_tokens > msg.revision.token_estimate!.message_text_tokens);
  // 旧修订旧快照保留（直查 DB；listMessages 只回当前修订）
  const old = host.db.prepare('SELECT token_estimate_json FROM message_revisions WHERE message_id = ? AND revision = 1').get(msg.id) as { token_estimate_json: string | null };
  assert.ok(old.token_estimate_json);
  assert.equal(JSON.parse(old.token_estimate_json!).message_text_tokens, msg.revision.token_estimate!.message_text_tokens);
});

test('系统红点端点：鉴权门 + 摘要/列表/已读链路（HTTP 面）', async () => {
  // 未认证 → 401（沿现有认证门）
  const noAuth = await fetch(`${base}/api/v1/system-alerts/summary`);
  assert.equal(noAuth.status, 401);
  // 注入一条真实告警（内部服务面）
  host.alerts!.observe({ code: 'CACHE_TTL_UNVERIFIED', scopeKind: 'system', dedupeKey: 'ttl:sdk-default', observationId: 'http-obs-1', safeSummary: { title: 'SDK 装配无 TTL 证据', reason: 'sdk_options_no_ttl' } });
  const sum = (await (await fetch(`${base}/api/v1/system-alerts/summary`, { headers: auth() })).json()) as { unread_anomaly_count: number; open_count: number; highest_open_severity: string };
  assert.equal(sum.unread_anomaly_count, 1);
  assert.equal(sum.highest_open_severity, 'warning');
  const list = (await (await fetch(`${base}/api/v1/system-alerts?lifecycle=open`, { headers: auth() })).json()) as { items: Array<{ alert_id: string; last_event_sequence: number; unread: boolean }>; open_count: number };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.unread, true);
  // 已读（POST + Origin 门走同源 host 头）
  const read = await fetch(`${base}/api/v1/system-alerts/read`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base }),
    body: JSON.stringify({ items: list.items.map((i) => ({ alert_id: i.alert_id, seen_event_sequence: i.last_event_sequence })) }),
  });
  assert.equal(read.status, 200);
  const sum2 = (await (await fetch(`${base}/api/v1/system-alerts/summary`, { headers: auth() })).json()) as { unread_anomaly_count: number; open_count: number };
  assert.equal(sum2.unread_anomaly_count, 0);
  assert.equal(sum2.open_count, 1); // 已读≠恢复
  // 浏览器不能创建告警或自填恢复（无该端点）
  const create = await fetch(`${base}/api/v1/system-alerts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base }), body: '{}' });
  assert.equal(create.status, 404);
});

test('ALERT-07：TTL 三态显示——desired 与 effective/核实状态分开，未核实不得显示"已生效 1h"', async () => {
  // mock 驱动：verification=unknown（不冒充）；字段结构即产品口径
  const snap = buildRecordSnapshot({ db: host.db, config: host.config, windows: host.windows, runnerSelection: host.runnerSelection }, 'primary', null);
  const tv = snap.cache.ttlVerification;
  assert.ok(tv && typeof tv === 'object');
  assert.ok(['1h', 'auto'].includes(tv.desired));
  assert.equal(tv.effective, null); // 无最终发包证据 → 不冒充已生效
  assert.ok(['requested', 'sdk_unverified', 'auto_observed', 'unknown'].includes(tv.verification));
  assert.equal(snap.cache.requestedTtl, tv.desired === 'auto' ? 'auto' : '1h'); // 旧字段与 desired 一致（兼容）
  // SDK 未核提醒（服务面）：观察一次 CACHE_TTL_UNVERIFIED（warning），聚合不刷次数
  const first = host.alerts!.observe({ code: 'CACHE_TTL_UNVERIFIED', scopeKind: 'system', dedupeKey: 'cache-ttl:sdk-no-evidence', observationId: 'cache-ttl-unverified:claude-agent-sdk', safeSummary: { title: 'SDK 驱动无 1h TTL 装配证据' } });
  assert.equal(first.counted, true);
  const again = host.alerts!.observe({ code: 'CACHE_TTL_UNVERIFIED', scopeKind: 'system', dedupeKey: 'cache-ttl:sdk-no-evidence', observationId: 'cache-ttl-unverified:claude-agent-sdk', safeSummary: { title: 'SDK 驱动无 1h TTL 装配证据' } });
  assert.equal(again.counted, false); // 同 observation 幂等，重启不刷次数
  const item = host.alerts!.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'CACHE_TTL_UNVERIFIED')!;
  assert.equal(item.severity, 'warning');
  assert.equal(item.occurrence_count, 1);
});
