// C07/C08/C09：自醒包装时间、实际耗尽心跳协议保留、无文字拒抽后的维护机会。
// 技术=包内 background-lifecycle 探针同法：真实 Host/调度器/DS 序列化，仅伪造 DS 传输与时钟。
// 外部未验证项（真实 SDK 序列、上游缓存计量命中）由 04 验收矩阵单列，不在本文件冒充。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

const originalFetch = globalThis.fetch;
const RealDate = Date;
let auditNow = RealDate.now();
// 审计时钟边界：不手改任何 task/run/activity 行，只推进时钟。
globalThis.Date = class extends RealDate {
  constructor(...args: any[]) { if (args.length === 0) super(auditNow); else super(...args as [any]); }
  static now() { return auditNow; }
} as DateConstructor;

type J = Record<string, any>;
const bodies: J[] = [];
let serial = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const content = (p: J): string => (p.messages ?? []).map((m: J) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

type Script = { mode: 'wake' | 'draw' | 'decline'; cardNumber?: number; keepRound?: number; scheduleWake?: boolean };
const invoke = (name: string, args: J) => ({ name: 'tool_invoke', arguments: JSON.stringify({ name, arguments: args }) });

function installFakeDs(script: Script): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.deepseek.com/chat/completions') {
      const p = JSON.parse(String(init?.body));
      const hostTail = [...p.messages].reverse().find((m: J) => m.role === 'user');
      const isWake = String(hostTail?.content).includes('Host self-wake');
      const hostText = JSON.stringify(hostTail?.content);
      const isKeepalive = hostText.includes('[心跳唤醒]');
      let calls: J[] = [];
      let text = '合成回复：青禾';
      if (isKeepalive && hostText.includes('请回复 1 保温')) {
        text = '1';
      } else if (isKeepalive && script.mode === 'draw') {
        const round = script.keepRound ?? 0;
        script.keepRound = round + 1;
        calls = [round === 0 ? invoke('heartbeat_draw', { card_number: script.cardNumber }) : invoke('background_complete', { outcome: 'done' })];
      } else if (isKeepalive && script.mode === 'decline') {
        calls = [invoke('background_complete', { outcome: 'noop' })];
      } else if (isWake) {
        text = '内部结束';
      } else if (script.scheduleWake) {
        script.scheduleWake = false;
        calls = [invoke('wake_manage', { operation: 'schedule', operation_id: 'wake-first', note: '合成：半小时后问候', delay_seconds: 1800 })];
      }
      const requestId = `fake-ds-${++serial}`;
      bodies.push({ kind: isWake ? 'wake' : isKeepalive ? 'keepalive' : 'chat', payload: p });
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          const delta = calls.length ? { tool_calls: calls.map((f, index) => ({ index, id: `tool-${serial}-${index}`, type: 'function', function: f })) } : { content: text };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: requestId, model: 'deepseek-flash', choices: [{ delta }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5000, completion_tokens: 32, prompt_cache_hit_tokens: 4096, prompt_cache_miss_tokens: 904, total_tokens: 5032 } })}\n\ndata: [DONE]\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

async function boot(script: Script) {
  installFakeDs(script);
  const restoreSources = script.mode === 'wake' ? () => {} : installHeartbeatFixtureSources();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c789-'));
  process.env.ESTOMAGO_HOME = stateRoot;
  writeApprovedIdentity(stateRoot);
  const patch = readyRuntimePatch();
  const config = buildConfig({
    ...patch,
    runtime: { ...patch.runtime as object, provider: 'deepseek', tool_schema_mode: 'deferred' },
    deepseek: { model: 'deepseek-flash', api_key_env: 'AUDIT_SYNTHETIC_DS_TOKEN', max_output_tokens: 2048, retry_max_attempts_after_initial: 0 },
    openrouter: { model: null },
    deployment: { port: 0 },
    background: { autonomous: { max_model_requests_per_run: 5, max_tool_calls_per_run: 12, daily_cost_cap_usd: 10, max_run_ms: 120000 }, keepwarm: { sleep_window: { enabled: false } } },
  });
  process.env.AUDIT_SYNTHETIC_DS_TOKEN = 'synthetic-ds-no-network';
  const host = await Host.create({ stateRoot, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('or_model_price',?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ input_micro_per_token: 1, output_micro_per_token: 2, cache_write_micro_per_token: 1 }));
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(stateRoot, 'config/auth.token'), 'utf8').trim();
  const request = async (urlPath: string, method = 'GET', body?: unknown, key = 'fixture') => {
    const response = await originalFetch(base + '/api/v1' + urlPath, { method, headers: { Authorization: `Bearer ${token}`, Origin: base, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(method === 'PUT' ? { 'If-Match': '"0"' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as J;
    if (!response.ok) throw Error(JSON.stringify({ urlPath, status: response.status, data }));
    return data;
  };
  const seed = async (id: string) => { await request('/conversations/primary/messages', 'POST', { content: '合成正式聊天', client_message_id: id }, 'seed-' + id); await host.supervisor.waitIdle(); };
  const shutdown = async () => { restoreSources(); await host.stop(); fs.rmSync(stateRoot, { recursive: true, force: true }); };
  return { host, request, seed, shutdown };
}

test.afterEach(() => { globalThis.fetch = originalFetch; auditNow = RealDate.now(); });

test('RB05：自由活动正式 HTTP 入口可达——真实建窗/幂等/同键异参 409/真实调度执行一次', async () => {
  const f = await boot({ mode: 'wake' });
  try {
    await f.seed('rb05-seed');
    // 自由活动预算门（backgroundControl('free_activity')→autonomous）
    await f.request('/background/settings', 'PUT', { free_activity: { enabled: true, daily_cost_cap_usd: 2 } }, 'rb05-enable');
    // 复审反例：正式 HTTP POST /api/v1/background/free-activity 曾 404（handler 未进分派）
    const created = await f.request('/background/free-activity', 'POST', { note: '合成自由活动窗口' }, 'rb05-open');
    assert.equal(created.origin, 'free_activity');
    assert.ok(created.task_id, '返回任务 id');
    // 同键同参=幂等重放；同键异参=409（不经 throwing helper）
    const dup = await f.request('/background/free-activity', 'POST', { note: '合成自由活动窗口' }, 'rb05-open');
    assert.equal(dup.duplicate, true);
    assert.equal(dup.task_id, created.task_id);
    const conflict = await originalFetch(`http://127.0.0.1:${f.host.port}/api/v1/background/free-activity`, { method: 'POST', headers: { Authorization: `Bearer ${fs.readFileSync(path.join(process.env.ESTOMAGO_HOME!, 'config/auth.token'), 'utf8').trim()}`, Origin: `http://127.0.0.1:${f.host.port}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'rb05-open' }, body: JSON.stringify({ note: '不同的活动' }) });
    assert.equal(conflict.status, 409, '同幂等键异参冲突');
    // 真实调度：立即到期的 once 任务被领取执行并收口
    await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
    const runs = f.host.db.prepare('SELECT id,state,kind FROM background_runs WHERE task_id=?').all(created.task_id) as Array<{ id: string; state: string; kind: string }>;
    assert.equal(runs.length, 1, '恰一次运行');
    assert.equal(runs[0]!.state, 'completed', '自由活动窗口真实执行完成');
    const task = f.host.db.prepare('SELECT enabled,next_due_at FROM background_tasks WHERE id=?').get(created.task_id) as { enabled: number; next_due_at: string | null };
    assert.equal(task.enabled, 0, 'once 活动窗口执行后停用');
  } finally { await f.shutdown(); }
});

test('C08：十张真实交付后，兜底1发布一次并沿下一普通输入接续，L 不推进', async () => {
  // Exercise ten ordinary maintenance cycles and the exhausted reply outside the morning opportunity.
  auditNow = Date.parse('2026-11-20T12:00:00+08:00');
  const script: Script = { mode: 'draw' };
  const f = await boot(script);
  try {
    const settings = await f.request('/background/settings');
    await f.request('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 10 }, autonomous: { enabled: true, daily_cost_cap_usd: 10 } }, 'enable');
    void settings;
    await f.seed('s1');
    for (let number = 1; number <= 10; number++) {
      // v2.1：每连续 3 次未出现自动心跳暂停一次，需要真实用户出现清零后继续新一串。
      if (number > 1 && (number - 1) % 3 === 0) await f.seed(`s-${number}`);
      script.cardNumber = number;
      script.keepRound = 0;
      auditNow += 3_000_001;
      await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
      const run = f.host.db.prepare("SELECT state,result_code,occurrence_key FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as J;
      assert.equal(run.state, 'completed');
      assert.equal(run.result_code, 'complete:done');
      assert.match(run.occurrence_key, /^keepwarm:/);
    }
    const status = await f.request('/background/heartbeat');
    assert.deepEqual(status.delivered_numbers, Array.from({ length: 10 }, (_, index) => index + 1));
    assert.equal(status.mode, 'exhausted_keepwarm');
    const revBefore = (f.host.db.prepare("SELECT activity_revision FROM conversation_activity WHERE conversation_id='primary'").get() as { activity_revision: number }).activity_revision;
    auditNow += 3_000_001; // 50min+1s：首个心跳机会
    await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
    const revAfterKeepalive = (f.host.db.prepare("SELECT activity_revision FROM conversation_activity WHERE conversation_id='primary'").get() as { activity_revision: number }).activity_revision;
    assert.equal(revAfterKeepalive, revBefore, '纯1心跳不推进真实消息时钟 L');
    const prev = bodies.at(-1)!.payload;
    assert.equal(bodies.at(-1)!.kind, 'keepalive', '纯1心跳请求已发出（前置）');
    const fallback = f.host.db.prepare("SELECT turn_id,result_code,retention FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as J;
    assert.equal(fallback.result_code, 'ack_only');
    assert.equal(fallback.retention, 'retained');
    const published = f.host.db.prepare(`SELECT r.content FROM messages m JOIN message_revisions r
      ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.turn_id=? AND m.speaker='assistant'`).all(fallback.turn_id);
    assert.deepEqual(published.map(message => message.content), ['1']);
    const requestIndex = bodies.length;
    await f.request('/conversations/primary/messages', 'POST', { content: '维护后新聊天', client_message_id: 'post-ack' }, 'post-ack');
    await f.host.supervisor.waitIdle();
    const next = bodies[requestIndex]!.payload;
    const firstDiff = prev.messages.findIndex((v: J, i: number) => JSON.stringify(v) !== JSON.stringify(next.messages[i]));
    assert.equal(firstDiff, -1, `纯1协议保留：下一请求以心跳已发前缀为前缀（旧实现首差@4，实际首差=${firstDiff}）`);
    assert.equal(JSON.stringify(prev.tools), JSON.stringify(next.tools), '工具目录不变');
    assert.equal(next.messages.filter((m: J) => m.role === 'assistant' && m.content === '1').length, 1);
  } finally { await f.shutdown(); }
});

test('C09：无文字拒抽保留维护回执，下一自然机会仍可调度', async () => {
  auditNow = Date.parse('2026-11-20T12:00:00+08:00');
  const f = await boot({ mode: 'decline' });
  try {
    await f.request('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 10 } }, 'enable-kw');
    await f.seed('s1');
    auditNow += 3_000_001;
    await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
    const first = f.host.db.prepare("SELECT * FROM background_runs WHERE kind='keepwarm' ORDER BY created_at DESC LIMIT 1").get() as J;
    assert.equal(first.state, 'noop');
    assert.equal(first.result_code, 'complete:noop');
    assert.equal(first.model_requests_started, 1);
    assert.equal(f.host.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE turn_id=? AND speaker='assistant'").get(first.turn_id)?.n, 0);
    const runsAfterFirst = (f.host.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as { n: number }).n;
    const maintenance = (f.host.db.prepare("SELECT maintenance_request_id FROM conversation_activity WHERE conversation_id='primary'").get() as { maintenance_request_id: string | null }).maintenance_request_id;
    assert.ok(maintenance, 'substantive 心跳记维护回执（旧实现恒 null）');
    auditNow += 3_000_001; // 再推 50min：后继维护机会应可领取（occurrence key 已随回执变化）
    await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
    const runsAfterSecond = (f.host.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as { n: number }).n;
    assert.equal(runsAfterSecond - runsAfterFirst, 1, '工具心跳后继恢复调度（旧实现增量=0 永久停摆）');
  } finally { await f.shutdown(); }
});

test('C07：自醒包装携带设置时间/原due/实际递交；重放不重算', async () => {
  const script: Script = { mode: 'wake', scheduleWake: true };
  const f = await boot(script);
  try {
    await f.request('/background/settings', 'PUT', { autonomous: { enabled: true, daily_cost_cap_usd: 10 } }, 'enable-auto');
    await f.seed('s1');
    const original = f.host.db.prepare("SELECT * FROM background_tasks WHERE origin='self_schedule'").get() as J;
    assert.ok(original, '真正模型调用 wake_manage 时才创建自主预约');
    assert.equal(original.created_by_actor_id, 'jiaming');
    const listed = await f.request('/background/tasks/' + original.id);
    assert.equal(listed.task.created_by, 'jiaming');
    await assert.rejects(f.request('/background/tasks', 'POST', { note: '合成代设', delay_seconds: 1800 }, 'delegate'), /self_wake_owner_only/);
    const countBefore = bodies.length;
    auditNow += 1_800_001;
    script.scheduleWake = true;
    await f.seed('s2');
    const replay = f.host.db.prepare("SELECT * FROM background_tasks WHERE origin='self_schedule'").all() as J[];
    assert.equal(replay.length, 1, '模型重放不重复建任务');
    assert.equal(replay[0]!.scheduled_at, original.scheduled_at, '相对时间重放不重算（原due冻结）');
    await f.host.scheduler!.tick(); await f.host.supervisor.waitIdle();
    const wake = bodies.slice(countBefore).find((r: J) => r.kind === 'wake');
    assert.ok(wake, '自醒请求已发出');
    const tail = [...wake.payload.messages].reverse().find((m: J) => m.role === 'user');
    const text = String(tail.content);
    assert.ok(text.includes('Set at:'), '包装含设置时间');
    assert.ok(text.includes(`Scheduled for: ${original.scheduled_at}`), '包装含原due（冻结值）');
    assert.ok(text.includes('Actual delivery:'), '包装含实际递交时间');
    assert.ok(text.includes('Your note: 合成：半小时后问候'), 'note 原文保留');
    assert.equal((text.match(/结束前，把要告诉乔乔的话发到聊天；有后续就自行安排。/g) ?? []).length, 1);
    assert.doesNotMatch(text, /想给宿主用户发一句|idempotency_key/);
    assert.equal(f.host.db.prepare('SELECT COUNT(*) n FROM background_runs WHERE task_id=?').get(original.id)?.n, 1);
  } finally { await f.shutdown(); }
});
