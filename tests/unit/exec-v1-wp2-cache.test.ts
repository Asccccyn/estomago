// ESTOMAGO_CHAT_EXEC_V1 · WP2 纯函数与 runner 面（04 §5/§12、02 §4.1-4.2；CACHE-01/02/03/06/07/08）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { buildOrPayload, assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';
import { lastCacheEvidence, keepwarmTargetAtMs, estimatedCacheExpiryAtMs, observeCacheUsage } from '../../apps/host/src/runtime/cache-observation.ts';
import { buildRecordSnapshot } from '../../apps/host/src/server/records.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { SdkNormalizedEvent } from '../../../packages/contracts/src/sdk-events.ts';

const enc = new TextEncoder();

function seedDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-wp2-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  return db;
}

function seedWindowTurnRequest(db: ReturnType<typeof openDatabase>, opts: { win?: string; request?: string; dispatchAt?: string; usage?: { read: number | null; write: number | null; input?: number | null } | null; model?: string }) {
  const win = opts.win ?? 'win-w2';
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO conversations(id, created_at) VALUES (?,?)").run('conv-w2', now);
  db.prepare("INSERT OR IGNORE INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?,'ACTIVE',?,?)").run(win, 'conv-w2', now, now);
  const turn = `turn-${Math.random().toString(36).slice(2, 8)}`;
  const attempt = `att-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES (?,?,'chat','completed',?)").run(turn, 'conv-w2', now);
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'completed')").run(attempt, turn);
  const req = opts.request ?? `prq-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, outcome, created_at, dispatch_started_at, sent_at) VALUES (?,?,?,?,?,\'{}\',\'completed\',?,?,?)')
    .run(req, win, attempt, turn, 'chat', now, opts.dispatchAt ?? now, opts.dispatchAt ?? now);
  if (opts.usage !== null) {
    db.prepare('INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, source, completeness, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`use-${Math.random().toString(36).slice(2, 8)}`, req, attempt, turn, 'request', opts.model ?? 'anthropic/claude-test-1', opts.usage?.input ?? 2000, opts.usage?.read ?? null, opts.usage?.write ?? null, 'or_stream', 'complete', now);
  }
  return req;
}

test('CACHE-01：OR 最终发包合同——1h cache_control、禁压缩插件、断点≤3、append-only 门、不加载 SDK', () => {
  const payload = buildOrPayload({
    model: 'anthropic/claude-test-1', sessionId: 'es-test',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '身份' }] },
      { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
    ],
    tools: [], boundaries: [
      { messageIndex: 0, contentIndex: 0 }, { messageIndex: 1, contentIndex: 0 }, { messageIndex: 1, contentIndex: 1 },
    ],
    maxTokens: 512, reasoning: null,
    providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true,
  }) as Record<string, unknown>;
  // 顶层 1h（Anthropic 族）
  assert.deepEqual(payload.cache_control, { type: 'ephemeral', ttl: '1h' });
  // 禁压缩插件显式关闭
  assert.deepEqual(payload.plugins, [{ id: 'context-compression', enabled: false }]);
  // 显式断点 ≤3（A/B/G）
  const blocks = (payload.messages as Array<Record<string, unknown>>).filter((m) => Array.isArray(m.content));
  let breakpointCount = 0;
  for (const m of payload.messages as Array<Record<string, unknown>>) {
    if (Array.isArray(m.content)) for (const b of m.content as Array<Record<string, unknown>>) if (b.cache_control) breakpointCount++;
  }
  void blocks;
  assert.ok(breakpointCount <= 3, `显式断点 ${breakpointCount} ≤ 3`);
  // append-only 门：改写旧历史被拒（transport 前断言——runner 内发送侧执行）
  const prev = buildOrPayload({ model: 'anthropic/claude-test-1', sessionId: 'es-test', messages: [{ role: 'user', content: '第一句' }], tools: [], boundaries: [], maxTokens: 512, reasoning: null, providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true });
  const mutated = buildOrPayload({ model: 'anthropic/claude-test-1', sessionId: 'es-test', messages: [{ role: 'user', content: '被改写的第一句' }, { role: 'user', content: '追加' }], tools: [], boundaries: [], maxTokens: 512, reasoning: null, providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true });
  assert.throws(() => assertAppendOnly(prev, mutated));
  // OR 驱动不加载 Claude Agent SDK（结构性：源文件零 SDK import）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../apps/host/src/runtime/runner-openrouter.ts'), 'utf8');
  assert.ok(!src.includes('@anthropic-ai'), 'OR 驱动不得 import SDK');
});

test('02 §4.2：每次 transport 前（含重试）准入——网络失败×2 后成功=3 次准入 3 次派发；拒绝则不发出', async () => {
  const admissions: number[] = [];
  let transportCalls = 0;
  const okBody = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'ok' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
  let calls = 0;
  const transport: OrTransport = async () => {
    transportCalls++;
    calls++;
    if (calls <= 2) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody)]) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 2 }, transport);
  const events: SdkNormalizedEvent[] = [];
  const result = await runner.run({
    driver: 'openrouter', purpose: 'chat',
    envelope: { model: 'anthropic/claude-test-1', sessionId: 'es-t', messages: [{ role: 'user', content: 'hi' }], tools: [], boundaries: [], maxTokens: 64, reasoning: null },
    previousPayload: null,
    abortController: new AbortController(),
    onEvent: (ev) => events.push(ev),
    onBeforeDispatch: async (info) => { admissions.push(info.attemptIndex); },
  } as Parameters<OpenRouterRunner['run']>[0]);
  assert.equal(result.outcome, 'completed');
  assert.equal(transportCalls, 3);
  assert.deepEqual(admissions, [0, 1, 2], '每次尝试（含失败重试）都过准入——旧 onDispatch 漏掉前两次');
  // 准入拒绝：不 transport
  const rejectRunner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 2 }, async () => { throw new Error('不应发出'); });
  let rejected = false;
  const r2 = await rejectRunner.run({
    driver: 'openrouter', purpose: 'chat',
    envelope: { model: 'anthropic/claude-test-1', sessionId: 'es-t', messages: [{ role: 'user', content: 'hi' }], tools: [], boundaries: [], maxTokens: 64, reasoning: null },
    previousPayload: null, abortController: new AbortController(), onEvent: () => {},
    onBeforeDispatch: async () => { rejected = true; throw new Error('DISPATCH_ADMISSION_REJECTED: 预算门'); },
  } as Parameters<OpenRouterRunner['run']>[0]);
  assert.ok(rejected);
  assert.equal(r2.outcome, 'error');
  assert.equal(r2.errorCode, 'DISPATCH_ADMISSION_REJECTED');
});

test('CACHE-02/03：计时基准=有读写证据请求的 dispatch_started_at；200 无证据/字段缺失/read=0/失败不刷新', () => {
  const db = seedDb();
  // 无效"证据"：200 但 usage 缺缓存字段 / read=0 且 write=0 / 根本没有 usage（失败请求）
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:00:00.000Z', usage: { read: null, write: null } });
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:05:00.000Z', usage: { read: 0, write: 0 } });
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:10:00.000Z', usage: null });
  assert.equal(lastCacheEvidence(db, 'win-w2'), null, '以上都不是计时基准');
  // 10:00（上海）有效证据：read>0
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:00:00.000Z', usage: { read: 1500, write: 500 } });
  let ev = lastCacheEvidence(db, 'win-w2')!;
  assert.equal(ev.startedAt, '2026-10-11T02:00:00.000Z'); // dispatch_started_at，不是 usage 到达时间
  assert.equal(keepwarmTargetAtMs(ev), Date.parse('2026-10-11T02:00:00.000Z') + 3_000_000); // 10:00 上海 → 10:50
  assert.equal(estimatedCacheExpiryAtMs(ev), Date.parse('2026-10-11T02:00:00.000Z') + 3_600_000); // TTL 仍 1h
  // 10:35 新证据 → 目标滚动到 11:25，10:50 旧目标作废（派生口径天然作废）
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:35:00.000Z', usage: { read: 1800, write: 200 } });
  ev = lastCacheEvidence(db, 'win-w2')!;
  assert.equal(ev.startedAt, '2026-10-11T02:35:00.000Z');
  assert.equal(keepwarmTargetAtMs(ev), Date.parse('2026-10-11T02:35:00.000Z') + 3_000_000);
  // 旧数据（无 dispatch_started_at）→ legacy 标记，不虚构时间
  const legacyReq = seedWindowTurnRequest(db, { win: 'win-legacy', dispatchAt: '2026-10-11T03:00:00.000Z', usage: { read: 100, write: 0 } });
  db.prepare('UPDATE provider_requests SET dispatch_started_at = NULL WHERE id = ?').run(legacyReq);
  const legacy = lastCacheEvidence(db, 'win-legacy')!;
  assert.equal(legacy.legacy, true);
  db.close();
});

test('CACHE-03/06：字段缺失不评不刷；温态全齐 read=0 才告警；无证据=目标 null（不为保温补冷写）', () => {
  const db = seedDb();
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  // 先放 10:00 证据
  seedWindowTurnRequest(db, { dispatchAt: '2026-10-11T02:00:00.000Z', usage: { read: 1500, write: 500 } });
  // (a) 字段缺失（read=null）→ 不评估（不是 0，不是命中，也不告警）
  observeCacheUsage(alerts, { db, windowId: 'win-w2', requestId: 'prq-miss-a', model: 'anthropic/claude-test-1', readTokens: null, writeTokens: null, inputTotal: 2000, dispatchStartedAt: '2026-10-11T02:20:00.000Z' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.filter((i) => i.code === 'CACHE_UNEXPECTED_MISS').length, 0);
  // (b) 冷态首请求（无先前证据）read=0 → 不告警（正常冷）
  observeCacheUsage(alerts, { db, windowId: 'win-cold', requestId: 'prq-cold-1', model: 'm', readTokens: 0, writeTokens: 0, inputTotal: 2000, dispatchStartedAt: '2026-10-11T02:10:00.000Z' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.filter((i) => i.code === 'CACHE_UNEXPECTED_MISS').length, 0);
  // (c) 温态全齐 read=0 → CACHE_UNEXPECTED_MISS（warning，幂等）
  observeCacheUsage(alerts, { db, windowId: 'win-w2', requestId: 'prq-miss-b', model: 'anthropic/claude-test-1', readTokens: 0, writeTokens: 0, inputTotal: 2000, dispatchStartedAt: '2026-10-11T02:20:00.000Z' });
  const item = alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'CACHE_UNEXPECTED_MISS')!;
  assert.ok(item);
  assert.equal(item.severity, 'warning');
  observeCacheUsage(alerts, { db, windowId: 'win-w2', requestId: 'prq-miss-b', model: 'anthropic/claude-test-1', readTokens: 0, writeTokens: 0, inputTotal: 2000, dispatchStartedAt: '2026-10-11T02:20:00.000Z' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'CACHE_UNEXPECTED_MISS')!.occurrence_count, 1);
  // (d) 无证据窗口：保温目标=null（不补冷写——调度面 WP4，计算面已就位）
  assert.equal(keepwarmTargetAtMs(lastCacheEvidence(db, 'win-none')), null);
  // (e) 换型号后的 read=0：same_model=false → 不告警
  observeCacheUsage(alerts, { db, windowId: 'win-w2', requestId: 'prq-miss-c', model: 'anthropic/claude-other-9', readTokens: 0, writeTokens: 0, inputTotal: 2000, dispatchStartedAt: '2026-10-11T02:20:00.000Z' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.filter((i) => i.code === 'CACHE_UNEXPECTED_MISS').length, 1);
  db.close();
});

test('CACHE-07/08：compact 专项识别；上游冲突别名归一 critical；驱动后台能力状态如实', () => {
  // normalizer：compact system 事件显式识别为 compact_boundary（不再是泛化 unknown）
  const norm = new SdkEventNormalizer();
  const raw1 = { type: 'system', subtype: 'context_low_memory_compact', content: 'Context compaction threshold reached', session_id: 's1', request_id: 'r1' };
  const ev1 = norm.normalize(raw1 as never) as SdkNormalizedEvent[];
  assert.ok(ev1.some((e) => e.kind === 'system_notice' && e.subtype === 'compact_boundary'));
  const norm2 = new SdkEventNormalizer();
  const ev2 = norm2.normalize({ type: 'system', subtype: 'status', content: 'ready', session_id: 's2' } as never) as SdkNormalizedEvent[];
  assert.ok(!ev2.some((e) => e.kind === 'system_notice' && e.subtype === 'compact_boundary'));
  // 上游强制压缩冲突别名：→ CONTEXT_COMPACTION_UNEXPECTED（critical；本地 enabled:false 不冒充必然覆盖）
  const db = seedDb();
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  alerts.observe({ code: 'UPSTREAM_COMPACTION_POLICY_CONFLICT', scopeKind: 'integration', scopeId: 'openrouter', dedupeKey: 'upstream-compact:acct-1', observationId: 'obs-uc-1', safeSummary: { reason: 'policy_conflict', title: '上游强制压缩与本地禁压缩冲突' } });
  const item = alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'CONTEXT_COMPACTION_UNEXPECTED')!;
  assert.ok(item);
  assert.equal(item.severity, 'critical');
  // 记录面：驱动后台能力状态（SDK=未验证阻断；DS=自动缓存不借 1h；OR=合格）
  const fakeWin = { activeWindow: () => null } as never;
  const mkSnap = (kind: string) => buildRecordSnapshot({ db, config: buildConfig({}), windows: fakeWin, runnerSelection: { status: 'ok', runner: { kind } } as never }, 'conv-w2', null);
  assert.deepEqual(mkSnap('claude-agent-sdk').backgroundPolicy, { driver: 'claude-agent-sdk', backgroundEligible: false, reason: 'SDK_BACKGROUND_POLICY_UNVERIFIED' });
  assert.deepEqual(mkSnap('deepseek').backgroundPolicy, { driver: 'deepseek', backgroundEligible: false, reason: 'AUTO_CACHE_NO_FIXED_TTL' });
  assert.deepEqual(mkSnap('openrouter').backgroundPolicy, { driver: 'openrouter', backgroundEligible: true, reason: 'eligible_or_anthropic_path' });
  assert.equal(mkSnap('claude-agent-sdk').cache.ttlVerification.verification, 'sdk_unverified'); // 不显示已生效 1h
  assert.equal(mkSnap('openrouter').cache.ttlVerification.verification, 'requested'); // 已请求待证据，不是已核实
  db.close();
});
