// BIND 生命周期联验：两个不同 PID 的真实 E 宿主（main.ts）+ 真实 M（uvicorn 隔离库）
// + 合成判断服务；M 代理按场景注入 503/扣回执。每场景 停机前/P1 退出后/P2 收口后 三点取证。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const REPO = '/Users/owner/Projects/estomago';
const MREPO = '/Users/owner/Projects/mariposa';
const MPY = join(MREPO, '.venv/bin/python');
const work = mkdtempSync(join(tmpdir(), 'bind-probe-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function deadline(p, ms, label) { let id; try { return await Promise.race([p, new Promise((_, rej) => { id = setTimeout(() => rej(new Error(label + ' timed out')), ms); })]); } finally { clearTimeout(id); } }
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 判断/M 代理合一 server ──
const judge = { mode: 'normal', calls: [], held: null }; // mode: normal|hold_first|402
const proxyLog = [];
let mOrigin = '';
const srv = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/chat/completions') {
    judge.calls.push(body.toString());
    const text = body.toString();
    if (judge.mode === 'hold_first' && judge.calls.length === 1) { judge.held = { req: text, res }; return; } // 收到请求暂缓响应
    if (judge.mode === '402') { send(402, { error: { message: 'Insufficient Balance' } }); return; }
    const pick = (mid) => ({ match: true, ranges: [
      { start: `msg_${mid}_1`, end: `msg_${mid}_1`, basis: '段A' },
      { start: `msg_${mid}_3`, end: `msg_${mid}_4`, basis: '段B' },
    ], confidence: 'high' });
    const mid = ['probe_a', 'probe_b', 'probe_c', 'probe_d', 'probe_e', 'probe_f'].find((m) => text.includes(`probe body ${m}`)) ?? 'probe_none';
    send(200, { choices: [{ message: { content: JSON.stringify(pick(mid)) } }] });
    return;
  }
  if (req.url.startsWith('/api/capability/')) {
    const cap = req.url.split('/').pop();
    const key = req.headers['idempotency-key'] ?? JSON.parse(body.toString() || '{}').idempotency_key ?? null;
    proxyLog.push({ cap, key, seq: proxyLog.length });
    const rule = proxyRules(proxyLog.length - 1, { cap, key }, body.toString());
    if (rule === 'drop503') { send(503, { error: { code: 'unavailable' } }); return; } // 不转发：明确未提交
    if (rule === 'forward_lost') { // 转发 M（真实提交）→ 扣掉回执返回 503
      try { await fetch(mOrigin + req.url, { method: 'POST', headers: { ...req.headers, host: new URL(mOrigin).host }, body }); } catch { /* M down */ }
      send(503, { error: { code: 'unavailable' } }); return;
    }
    try {
      const up = await fetch(mOrigin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(mOrigin).host }, ...(req.method !== 'GET' ? { body } : {}) });
      const txt = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      res.end(txt);
    } catch { send(502, { error: { code: 'bad_gateway' } }); }
    return;
  }
  send(404, {});
});
// 场景可编程：每场景 reset 代理规则
let proxyRuleFn = () => 'forward';
function proxyRules(i, info, body) { return proxyRuleFn(i, info, body); }

function estRoot() { const r = mkdtempSync(join(work, 'est-')); mkdirSync(join(r, 'config'), { recursive: true }); return r; }
function seedE(root, mid) { execFileSync(process.execPath, ['--experimental-strip-types', '/tmp/bind-probe/seed.mjs', root, mid], { cwd: REPO, stdio: 'pipe' }); }
function launchE(root, origin) {
  const cfg = join(root, 'config', 'estomago.yaml');
  writeFileSync(cfg, `runtime:\n  provider: mock\nintegrations:\n  mariposa:\n    base_url: "${origin}"\n    credential_ref: PROBE_M_TOKEN\nsource_binding:\n  enabled: true\n  api_key_env: PROBE_JUDGE_KEY\n  base_url: "${origin}"\n  model: synthetic\n`);
  const child = spawn(process.execPath, ['--import', '/tmp/bind-probe/clock.mjs', join(REPO, 'apps/host/src/main.ts'), '--port', '0', '--config', cfg], {
    cwd: REPO, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', ESTOMAGO_HOME: root, ESTOMAGO_TEST_MODE: '1', PROBE_M_TOKEN: process.env.PROBE_M_TOKEN, PROBE_JUDGE_KEY: 'synthetic' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let msg = ''; for (const st of [child.stdout, child.stderr]) st.on('data', (b) => { msg = (msg + b).slice(-6000); });
  const done = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, done, messages: () => msg };
}
const eJob = (root, mid) => { const db = new DatabaseSync(join(root, 'data', 'chat.sqlite3'), { readOnly: true }); try { return db.prepare('SELECT status, attempts, binding_ids_json, pending_segments_json, detail FROM source_bind_jobs WHERE memory_id=?').get(mid) ?? null; } finally { db.close(); } };
const mBindings = (mid) => { const db = new DatabaseSync(join(process.env.PROBE_M_ROOT, 'runtime', 'formal', 'mariposa.sqlite3'), { readOnly: true }); try { return db.prepare('SELECT binding_id, memory_id, start_message_id, end_message_id FROM memory_source_bindings WHERE memory_id=? ORDER BY created_at').all(mid); } finally { db.close(); } };
const results = [];
const scenarioChildren = new Set();
const _launchE = launchE;
launchE = (root, origin) => { const e = _launchE(root, origin); scenarioChildren.add(e.child); e.done.then(() => scenarioChildren.delete(e.child)); return e; };
async function scenario(name, mid, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message} | proxy=${JSON.stringify(proxyLog.slice(-6))}`); }
  finally { for (const c of scenarioChildren) { try { c.kill('SIGKILL'); } catch {} } scenarioChildren.clear(); await new Promise((r) => setTimeout(r, 300)); }
}

// ══ 主流程 ══
const mPort = await freePort();
const judgePort = await freePort();
await new Promise((r, j) => { srv.once('error', j); srv.listen(judgePort, '127.0.0.1', r); });
const origin = `http://127.0.0.1:${judgePort}`;
const m = spawn(MPY, ['-m', 'uvicorn', 'backend.mariposa.app:app', '--host', '127.0.0.1', '--port', String(mPort), '--log-level', 'warning'], { cwd: MREPO, env: { ...process.env, MARIPOSA_ROOT: process.env.PROBE_M_ROOT, MARIPOSA_GATE_RATE_WRITE_PER_MIN: '6000', MARIPOSA_GATE_RATE_READ_PER_MIN: '6000' }, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(m);
m.stderr.on('data', (b) => { process.stderr.write('[M] ' + b); });
mOrigin = `http://127.0.0.1:${mPort}`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(mOrigin + '/health'); if (r.ok) break; } catch {} await sleep(100); if (i === 99) throw new Error('M health 未就绪'); }
const mCall = async (cap, args, key) => fetch(`${mOrigin}/api/capability/${cap}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.PROBE_M_TOKEN}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ arguments: args, ...(key ? { idempotency_key: key } : {}) }) }).then((r) => r.json());

// ── 场景 a：正常链对照（两段+间隔消息） ──
await scenario('a 正常链', 'probe_a', async () => { const MID = 'probe_a';
  judge.mode = 'normal'; proxyRuleFn = () => 'forward'; proxyLog.length = 0;
  const root = estRoot(); seedE(root, MID);
  const e = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_a'); if (j?.status === 'bound') return; await sleep(100); } throw new Error('未 bound: ' + e.messages().slice(-1500)); })(), 25000, 'a bound');
  const j = eJob(root, 'probe_a');
  const ids = JSON.parse(j.binding_ids_json ?? '[]');
  const rows = mBindings('probe_a');
  assert.equal(rows.length, 2, 'M 两段各一绑定');
  assert.equal(ids.length, 2, 'E 两段已确认才 bound');
  for (const b of rows) assert.ok(ids.includes(b.binding_id), `E 对上 M ${b.binding_id}`);
  const b2 = rows.find((r) => r.start_message_id === 'sm_msg_probe_a_3');
  assert.equal(b2.end_message_id, 'sm_msg_probe_a_4', '段 B=3..4（段间消息 2 未入任何段）');
  // 停启后再 tick 不增
  e.child.kill('SIGTERM'); const ex = await deadline(e.done, 10000, 'a stop'); assert.equal(ex.code, 0);
  const before = mBindings('probe_a').length; const jc = judge.calls.length;
  const e2 = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 60; i++) { await sleep(100); } })(), 8000, 'a wait2');
  assert.equal(mBindings('probe_a').length, before, '停启后绑定不增');
  assert.equal(judge.calls.length, jc, '判断不重发');
  e2.child.kill('SIGTERM'); await deadline(e2.done, 10000, 'a stop2');
});

// ── 场景 b：判断已发、响应未到时停机（P2 恢复不丢计数） ──
await scenario('b 判断在途停机', 'probe_b', async () => { const MID = 'probe_b';
  judge.mode = 'hold_first'; judge.calls.length = 0; proxyRuleFn = () => 'forward';
  const root = estRoot(); seedE(root, MID);
  const e = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { if (judge.calls.length >= 1) return; await sleep(50); } throw new Error('首请求未到'); })(), 15000, 'b first');
  const j0 = eJob(root, 'probe_b');
  assert.ok(j0 && (j0.status === 'judging' || j0.status === 'failed'), `停机前在途落账（修前 pending/attempts=0）: ${JSON.stringify(j0)}`);
  assert.ok(j0.attempts >= 1, '发出已计数');
  if (judge.held) {
    const pick = (mid) => ({ match: true, ranges: [
      { start: `msg_${mid}_1`, end: `msg_${mid}_1`, basis: '段A' },
      { start: `msg_${mid}_3`, end: `msg_${mid}_4`, basis: '段B' },
    ], confidence: 'high' });
    judge.held.res.writeHead(200, { 'content-type': 'application/json' });
    judge.held.res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(pick('probe_b')) } }] }));
    judge.held = null;
    await sleep(400);
  }
  e.child.kill('SIGTERM'); const ex = await deadline(e.done, 35000, 'b stop'); assert.equal(ex.code, 0, '正常退出（BIND 有界等待）: ' + e.messages().slice(-300));
  // 等待内返回路径：E1 在停机等待中收到响应并完成（指令场景 b 前半）
  const jw = eJob(root, 'probe_b');
  assert.ok(jw && jw.status === 'bound', `等待内返回→P1 完成收口（attempts=${jw?.attempts}）: ${JSON.stringify(jw).slice(0, 160)}`);
  assert.equal(jw.attempts, 1, '恰一次发出');
  assert.equal(mBindings('probe_b').length, 2);
  e.child.kill('SIGTERM'); await deadline(e.done, 35000, 'b stop');
  // b2：直到 P1 退出响应仍未到→P2 重发（两次接收=E 两次计数）
  judge.mode = 'hold_first'; judge.calls.length = 0; judge.held = null;
  const root2 = estRoot(); seedE(root2, 'probe_f');
  const e3 = launchE(root2, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { if (judge.calls.length >= 1) return; await sleep(50); } throw new Error('b2 首请求未到'); })(), 15000, 'b2 first');
  e3.child.kill('SIGTERM'); const ex3 = await deadline(e3.done, 35000, 'b2 stop'); assert.ok(ex3.code !== null && ex3.signal !== 'SIGTERM', `已退出（在途等待下非零码可接受：${JSON.stringify(ex3)}）`);
  const j3 = eJob(root2, 'probe_f');
  assert.ok(j3.attempts >= 1 && j3.status !== 'bound', 'P1 带未知退出（在途事实留存）');
  judge.mode = 'normal';
  const e2 = launchE(root2, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root2, 'probe_f'); if (j?.status === 'bound') return; await sleep(100); } throw new Error('未恢复: ' + e2.messages().slice(-400)); })(), 30000, 'b recover');
  const j = eJob(root2, 'probe_f');
  assert.ok(j.attempts >= 2, `两次发出两次计数（服务端接收=E 记录可对账）: ${j.attempts}`);
  e2.child.kill('SIGTERM'); await deadline(e2.done, 35000, 'b stop2');
});

// ── 场景 c：A 成功、B 明确未提交（503 不转发）→ P2 只补 B ──
await scenario('c A成功B未提交', 'probe_c', async () => { const MID = 'probe_c';
  judge.mode = 'normal'; judge.calls.length = 0;
  proxyRuleFn = (i, info) => (info.cap === 'source.binding.bind' && String(info.key ?? '').endsWith(':1') ? 'drop503' : 'forward');
  const root = estRoot(); seedE(root, MID);
  const e = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_c'); if (j && j.status === 'failed' && j.pending_segments_json) return; await sleep(100); } throw new Error('未到部分成功: ' + e.messages().slice(-800)); })(), 30000, 'c partial');
  const j1 = eJob(root, 'probe_c');
  assert.equal(JSON.parse(j1.binding_ids_json ?? '[]').length, 1, `A 已入账: ${JSON.stringify(j1)}`);
  assert.equal(mBindings('probe_c').length, 1, 'M 只有 A');
  e.child.kill('SIGTERM'); await deadline(e.done, 35000, 'c stop');
  proxyRuleFn = () => 'forward';
  const e2 = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_c'); if (j?.status === 'bound') return; await sleep(100); } throw new Error('未补 B: ' + e2.messages().slice(-800)); })(), 30000, 'c recover');
  const rows = mBindings('probe_c');
  assert.equal(rows.length, 2, 'M 恰 A+B');
  assert.equal(judge.calls.length, 1, '判断只发生一次（补段不重判）');
  assert.equal(JSON.parse(eJob(root, 'probe_c').binding_ids_json ?? '[]').length, 2);
  e2.child.kill('SIGTERM'); await deadline(e2.done, 35000, 'c stop2');
});

// ── 场景 d：B 已提交、回执丢失（转发 M 后扣回执）→ P2 按原键重放找回 ──
await scenario('d B已提交丢回执', 'probe_d', async () => { const MID = 'probe_d';
  judge.mode = 'normal'; judge.calls.length = 0;
  let lostDone = false;
  proxyRuleFn = (i, info) => (info.cap === 'source.binding.bind' && String(info.key ?? '').endsWith(':1') && !lostDone ? 'forward_lost' : 'forward');
  const root = estRoot(); seedE(root, MID);
  const e = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_d'); if (j && j.pending_segments_json) { lostDone = true; return; } await sleep(100); } throw new Error('未到丢回执态'); })(), 30000, 'd lost');
  lostDone = true;
  assert.equal(mBindings('probe_d').length, 2, 'M 实际已有 A+B（B 已提交）');
  assert.equal(JSON.parse(eJob(root, 'probe_d').binding_ids_json ?? '[]').length, 1, 'E 只认 A（B 回执丢失）');
  e.child.kill('SIGTERM'); await deadline(e.done, 35000, 'd stop');
  proxyRuleFn = () => 'forward';
  const e2 = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_d'); if (j?.status === 'bound') return; await sleep(100); } throw new Error('未找回: ' + e2.messages().slice(-800)); })(), 30000, 'd recover');
  const rows = mBindings('probe_d');
  assert.equal(rows.length, 2, '无第二条 B（幂等重放找回原 ID）');
  const ids = JSON.parse(eJob(root, 'probe_d').binding_ids_json ?? '[]');
  assert.equal(ids.length, 2);
  for (const b of rows) assert.ok(ids.includes(b.binding_id), 'E 最终持有 M 的 B 原 ID');
  e2.child.kill('SIGTERM'); await deadline(e2.done, 35000, 'd stop2');
});

// ── 场景 e：B 未提交、人工绑定中间一条 → P2 不认领人工 ID ──
await scenario('e 人工来源不认领', 'probe_e', async () => { const MID = 'probe_e';
  judge.mode = 'normal'; judge.calls.length = 0;
  proxyRuleFn = (i, info) => (info.cap === 'source.binding.bind' && String(info.key ?? '').endsWith(':1') ? 'drop503' : 'forward');
  const root = estRoot(); seedE(root, MID);
  const e = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_e'); if (j && j.pending_segments_json) return; await sleep(100); } throw new Error('未到部分成功'); })(), 30000, 'e partial');
  e.child.kill('SIGTERM'); await deadline(e.done, 35000, 'e stop');
  const manual = await mCall('source.binding.bind', { memory_id: 'probe_e', conversation_id: 'sc_probe', start_message_id: 'sm_msg_probe_e_4', end_message_id: 'sm_msg_probe_e_4' }, 'manual-probe-1');
  assert.ok(manual.ok, '人工绑定建立: ' + JSON.stringify(manual).slice(200));
  proxyRuleFn = () => 'forward';
  const e2 = launchE(root, origin);
  await deadline((async () => { for (let i = 0; i < 200; i++) { const j = eJob(root, 'probe_e'); if (j && ['skipped_existing', 'bound', 'version_conflict'].includes(j.status)) return; await sleep(100); } throw new Error('未到终态'); })(), 30000, 'e terminal');
  const j = eJob(root, 'probe_e');
  assert.ok(['skipped_existing', 'version_conflict'].includes(j.status), `人工来源不被认领/不被覆盖（终态停止自动追加）: ${j.status}`);
  const rows = mBindings('probe_e');
  assert.equal(rows.length, 2, 'M=A+人工（B 未被自动补写）');
  const ids = JSON.parse(j.binding_ids_json ?? '[]');
  assert.ok(ids.includes(rows.find((r) => r.start_message_id === 'sm_msg_probe_e_1')?.binding_id ?? ''), 'E 保留 A 原回执');
  e2.child.kill('SIGTERM'); await deadline(e2.done, 35000, 'e stop2');
});

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
process.exit(fails > 0 ? 1 : 0);
