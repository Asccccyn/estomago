import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

test('身份不通过 → 窗口 BLOCKED，conversation 指针不动，仍留 receipt 证据', () => {
  const { db, root } = makeDb();
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths); // 无 manifest → BLOCKED
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');

  const gate = identity.evaluateGate();
  const { window, blockedReason } = windows.createWindow({ conversationId: 'c1', gate });
  assert.equal(window.status, 'BLOCKED');
  assert.ok(blockedReason!.includes('manifest'));
  assert.equal(windows.activeWindow('c1'), null);
  const receipts = db.prepare('SELECT COUNT(*) AS n FROM bootstrap_receipts').get() as { n: number };
  assert.ok(receipts.n >= 1, '阻断也要留下 receipt 证据');
});

test('身份 READY → ACTIVE + 原子指针切换；轮转产生新窗、旧窗 CLOSED、交接文件落盘', () => {
  const { db, root } = makeDb();
  const paths = makePaths(root);
  writeApprovedIdentity(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.submitUserMessage({ conversationId: 'c1', content: 'hi', clientMessageId: 'w1' });

  const gate = identity.evaluateGate();
  assert.equal(gate.state, 'READY');
  const first = windows.createWindow({ conversationId: 'c1', gate });
  assert.equal(first.blockedReason, null);
  assert.equal(first.window.status, 'ACTIVE');
  assert.equal(windows.activeWindow('c1')!.id, first.window.id);

  const rotate = windows.rotate({ conversationId: 'c1', gate, maxSequence: 1 });
  assert.equal(rotate.ok, true);
  if (rotate.ok) {
    assert.notEqual(rotate.window.id, first.window.id);
    assert.equal(windows.get(first.window.id)!.status, 'CLOSED');
    const handoff = path.join(paths.handoffsDir, `${first.window.id}.json`);
    assert.ok(fs.existsSync(handoff));
    const h = JSON.parse(fs.readFileSync(handoff, 'utf8')) as { cutoff_sequence: number; includes_reasoning: boolean };
    assert.equal(h.cutoff_sequence, 1);
    assert.equal(h.includes_reasoning, false, '思考摘要绝不进默认交接');
  }
});

test('轮转时身份退回 BLOCKED → 拒绝轮转并保留旧窗 ACTIVE（降级路径）', () => {
  const { db, root } = makeDb();
  const paths = makePaths(root);
  writeApprovedIdentity(root);
  const config = buildConfig(readyRuntimePatch());
  const identityGood = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identityGood, paths.handoffsDir);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const gate = identityGood.evaluateGate();
  const first = windows.createWindow({ conversationId: 'c1', gate });

  // 身份失效（例如 I 被撤销）→ 新 gate BLOCKED
  const identityBad = new IdentityService(buildConfig({ runtime: { model: null } }), paths);
  const rotate = windows.rotate({ conversationId: 'c1', gate: identityBad.evaluateGate(), maxSequence: 0 });
  assert.equal(rotate.ok, false);
  assert.equal(windows.activeWindow('c1')!.id, first.window.id, '旧窗保留');
});
