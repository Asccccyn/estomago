#!/usr/bin/env node
// 只读 doctor（02 §2）：不做任何变更、不杀端口占用者、不打印 secret。
// 输出 reports/mac-doctor-<timestamp>.json；这是环境证据，不是产品验收 PASS。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(REPO, 'reports', `mac-doctor-${ts}.json`);
const report = { generated_at: new Date().toISOString(), note: '只读检查；非产品验收证据', checks: {} };

const add = (k, v) => (report.checks[k] = v);

// —— 运行时 ——
add('node', { version: process.version, execPath: process.execPath, arch: process.arch });
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('SELECT 1');
  db.close();
  add('node_sqlite', { ok: true, note: '内置（Node 22 为实验性；升级 Node 24+ 可去掉实验告警）' });
} catch (err) {
  add('node_sqlite', { ok: false, error: String(err) });
}
try {
  const tmp = path.join(os.tmpdir(), `estomago-strip-probe-${process.pid}.ts`);
  fs.writeFileSync(tmp, 'const x: number = 1; if (x !== 1) throw new Error("bad");\n');
  execFileSync(process.execPath, [tmp], { stdio: 'pipe' });
  fs.rmSync(tmp, { force: true });
  add('ts_type_stripping', { ok: true });
} catch (err) {
  add('ts_type_stripping', { ok: false, error: String(err) });
}

// —— 路径 ——
const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const logRoot = path.join(os.homedir(), 'Library', 'Logs', 'estomago');
add('paths', {
  source_root: { path: REPO, exists: true },
  state_root: { path: stateRoot, exists: fs.existsSync(stateRoot) },
  state_config: { path: path.join(stateRoot, 'config', 'estomago.yaml'), exists: fs.existsSync(path.join(stateRoot, 'config', 'estomago.yaml')) },
  log_root: { path: logRoot, exists: fs.existsSync(logRoot) },
  launchagent_plist: { path: path.join(os.homedir(), 'Library', 'LaunchAgents', 'online.charstarearth.estomago.plist'), exists: fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'online.charstarearth.estomago.plist')) },
});

// —— 端口（只探测，不占用不杀）——
const port = Number(process.env.ESTOMAGO_PORT || 18787);
add('port', { host: '127.0.0.1', port, ...(await probePort('127.0.0.1', port)) });

// —— SDK 包（存在性，不验证可用性）——
let sdk = { installed: false, resolution: 'not found in repo' };
try {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  sdk = { installed: true, resolution: 'repo dependency', exports: Object.keys(mod).slice(0, 8) };
} catch {
  /* 未安装是当前已知状态 */
}
add('claude_agent_sdk', sdk);

// —— 磁盘 / 时区 ——
try {
  const st = fs.statfsSync(path.dirname(stateRoot));
  add('disk_free_bytes', { value: st.bsize * st.bavail, human: `${Math.round((st.bsize * st.bavail) / 1e9)} GB` });
} catch (err) {
  add('disk_free_bytes', { error: String(err) });
}
add('timezone', { system: Intl.DateTimeFormat().resolvedOptions().timeZone, business_default: 'Asia/Shanghai' });
add('platform', { release: os.release(), type: os.type(), machine: os.machine() });

fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
// —— WP-04（JFA-E01/E02）：库体积报告 + 监听进程 env 键名核验 ——
try {
  const { DatabaseSync } = await import('node:sqlite');
  const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
  const dbFile = path.join(stateRoot, 'data', 'chat.sqlite3');
  if (fs.existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const tables = ['provider_requests', 'runtime_stream_events', 'reasoning_blocks', 'usage_observations', 'outbox', 'messages'];
    const sizes = {};
    for (const t of tables) {
      try { sizes[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { sizes[t] = null; }
    }
    const payloadHeavy = db.prepare("SELECT COUNT(*) AS n FROM provider_requests WHERE payload_json IS NOT NULL").get().n;
    const stat = fs.statSync(dbFile);
    report.db_growth = { db_bytes: stat.size, db_mb: Math.round(stat.size / 1048576 * 10) / 10, table_rows: sizes, provider_requests_with_payload: payloadHeavy };
    db.close();
  }
} catch (err) {
  report.db_growth = { error: String(err && err.message ? err.message : err).slice(0, 120) };
}
// env 键名核验（INCIDENT 教训：只比对键名集合，绝不输出值）
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('/bin/sh', ['-c', "ps eww $(lsof -ti tcp:18787 -sTCP:LISTEN 2>/dev/null | head -1) 2>/dev/null | tail -1"], { encoding: 'utf8', timeout: 5000 }).trim();
  if (out) {
    const keys = new Set();
    for (const m of out.matchAll(/([A-Z_][A-Z0-9_]+)=/g)) keys.add(m[1]);
    const required = ['ESTOMAGO_HOME', 'PATH'];
    report.listener_env = {
      keys_present: [...required].filter((k) => keys.has(k)),
      keys_missing: [...required].filter((k) => !keys.has(k)),
      credential_keys_present: ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'MARIPOSA_CREDENTIAL'].filter((k) => keys.has(k)),
      note: '只报键名集合，不输出任何值',
    };
  } else {
    report.listener_env = { note: '无监听进程（18787）' };
  }
} catch {
  report.listener_env = { note: 'env 探测不可用' };
}

console.log(`\n[doctor] 报告已写入 ${reportPath}（只读检查；全部产品验收仍为 NOT_EXECUTED）`);

function probePort(host, port_) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: port_ });
    s.on('connect', () => {
      s.destroy();
      resolve({ listening: true, note: '端口已被占用：需换端口或先查明占用者（doctor 不杀进程）' });
    });
    s.on('error', () => resolve({ listening: false }));
    s.setTimeout(800, () => {
      s.destroy();
      resolve({ listening: false });
    });
  });
}

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.checks, null, 2));

