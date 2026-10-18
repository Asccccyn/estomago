// cost-20261018（第二阶段）：上下文指纹——每次派发的可缓存结构 hash 留证。
// 语义基线 = 同目录 ../docs/audits/estomago-cost-20261018/evidence-fingerprint.json
// 对 112 笔历史请求的回算口径（sha256 截 12 hex、按 (model,session,tools_hash) 分组比对）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { contextFingerprintOf, contextFingerprintJson } from '../../apps/host/src/runtime/context-fingerprint.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate, SUPPORTED_SCHEMA_VERSION } from '../../apps/host/src/db/migrations.ts';

const mkInput = () => ({
  round: 0,
  tools: [{ type: 'function', function: { name: 'memory_hold', parameters: { type: 'object' } } }] as never,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'IDENTITY-SENTINEL-爱' }] },
    { role: 'system', content: [{ type: 'text', text: 'BOOT-SENTINEL-纪念日' }] },
    { role: 'user', content: [{ type: 'text', text: '早' }] },
  ] as never,
  boundaries: [
    { messageIndex: 0, contentIndex: 0 },
    { messageIndex: 1, contentIndex: 0 },
  ],
});

test('确定性：同输入同指纹；round_no/boundaries 如实记录', () => {
  const a = contextFingerprintOf(mkInput());
  const b = contextFingerprintOf(mkInput());
  assert.deepEqual(a, b);
  assert.equal(a.round_no, 0);
  assert.equal(a.tools_n, 1);
  assert.equal(a.sys_count, 2);
  assert.equal(a.msgs_n, 3);
  assert.deepEqual(a.boundaries, [{ m: 0, c: 0 }, { m: 1, c: 0 }]);
  assert.match(a.tools_hash, /^[0-9a-f]{12}$/);
  assert.match(a.msgs_hash, /^[0-9a-f]{12}$/);
});

test('分段敏感：tools 变化只动 tools_hash；messages 追加只动 msgs 段', () => {
  const base = contextFingerprintOf(mkInput());
  const toolsChanged = contextFingerprintOf({ ...mkInput(), tools: [{ type: 'function', function: { name: 'memory_hold', parameters: { type: 'object', additional: true } } }] as never });
  assert.notEqual(toolsChanged.tools_hash, base.tools_hash);
  assert.equal(toolsChanged.system_a_hash, base.system_a_hash);
  assert.equal(toolsChanged.boot_hash, base.boot_hash);
  assert.equal(toolsChanged.msgs_hash, base.msgs_hash);

  const appended = contextFingerprintOf({
    ...mkInput(),
    round: 2,
    messages: [...mkInput().messages, { role: 'assistant', content: [{ type: 'text', text: '好' }] }] as never,
  });
  assert.notEqual(appended.msgs_hash, base.msgs_hash);
  assert.equal(appended.msgs_n, base.msgs_n + 1);
  assert.equal(appended.tools_hash, base.tools_hash);
  assert.equal(appended.system_a_hash, base.system_a_hash);
  assert.equal(appended.boot_hash, base.boot_hash);
  assert.equal(appended.round_no, 2);
});

test('B 段缺失：boot_hash=null（不冒充零或空串）；非 system 开头 system_a_hash=null', () => {
  const noBoot = contextFingerprintOf({ ...mkInput(), messages: [mkInput().messages[0]!, mkInput().messages[2]!] as never });
  assert.equal(noBoot.boot_hash, null);
  assert.equal(noBoot.sys_count, 1);
  const noSystem = contextFingerprintOf({ ...mkInput(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] as never });
  assert.equal(noSystem.system_a_hash, null);
  assert.equal(noSystem.boot_hash, null);
});

test('脱敏：指纹 JSON 不含正文标记词（AGENTS §4——只落 hash/位置/计数）', () => {
  const json = contextFingerprintJson(mkInput());
  assert.ok(!json.includes('IDENTITY-SENTINEL'), '身份正文不得出现在指纹 JSON');
  assert.ok(!json.includes('BOOT-SENTINEL'), '开窗资料正文不得出现在指纹 JSON');
  assert.ok(!json.includes('早'), '聊天正文不得出现在指纹 JSON');
  assert.ok(!json.includes('memory_hold'), '工具名不走明文（tools 只有 hash 与计数）');
});

test('迁移 v28：provider_requests.context_fingerprint_json 列存在（fresh 库）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'estomago-fp-'));
  try {
    const db = openDatabase(path.join(home, 'chat.sqlite3'));
    const applied = migrate(db, (sql) => String(sql.length));
    assert.equal(applied.applied.at(-1), 28);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 28);
    const cols = (db.prepare('PRAGMA table_info(provider_requests)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('context_fingerprint_json'), `列缺失：${cols.join(',')}`);
    db.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
