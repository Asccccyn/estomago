import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

test('身份不通过 → 窗口 BLOCKED、指针不动，receipt 仍留证据且 receipt_id 可解析（AUD-22）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root, { seedProbes: false });
  const { db } = makeDb(root, { seed: false }); // 无探针 → gate BLOCKED
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');

  const gate = identity.evaluateGate(db);
  const { window, blockedReason } = windows.createWindow({ conversationId: 'c1', gate });
  assert.equal(window.status, 'BLOCKED');
  assert.ok(blockedReason!.includes('probe_missing'));
  assert.equal(windows.activeWindow('c1'), null);
  const receipt = db.prepare('SELECT id FROM bootstrap_receipts WHERE id = ?').get(window.receipt_id);
  assert.ok(receipt, 'receipt_id 必须解析到真实记录（AUD-22）');
});

test('READY → ACTIVE；轮转 prepare→原子切换；旧窗 CLOSED；交接落盘且不含 reasoning', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root); // 已播种探针
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'hi', clientMessageId: 'w1' });

  const gate = identity.evaluateGate(db);
  assert.equal(gate.state, 'READY');
  const first = windows.createWindow({ conversationId: 'c1', gate });
  assert.equal(first.blockedReason, null);
  assert.equal(first.window.status, 'ACTIVE');

  const rotate = windows.rotate({ conversationId: 'c1', gate, maxSequence: 1 });
  assert.equal(rotate.ok, true);
  if (rotate.ok) {
    assert.notEqual(rotate.window.id, first.window.id);
    assert.equal(windows.get(first.window.id)!.status, 'CLOSED');
    const handoff = JSON.parse(fs.readFileSync(path.join(paths.handoffsDir, rotate.window.id, 'handoff.json'), 'utf8')) as { includes_reasoning: boolean; cutoff_sequence: number };
    assert.equal(handoff.cutoff_sequence, 1);
    assert.equal(handoff.includes_reasoning, false);
    const receipt = db.prepare('SELECT id FROM bootstrap_receipts WHERE id = ?').get(rotate.window.receipt_id);
    assert.ok(receipt);
  }
});

test('AUD-20：handoff 写失败 → 轮转整体失败，旧窗保持 ACTIVE（绝不 active=null）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const gate = identity.evaluateGate(db);
  const first = windows.createWindow({ conversationId: 'c1', gate });

  // 故障注入：把 handoffs 根路径占成文件 → mkdir 失败
  fs.rmSync(paths.handoffsDir, { recursive: true, force: true });
  fs.writeFileSync(paths.handoffsDir, 'block handoff writes');
  const rotate = windows.rotate({ conversationId: 'c1', gate, maxSequence: 0 });
  assert.equal(rotate.ok, false);
  const active = windows.activeWindow('c1');
  assert.ok(active, '旧窗必须保持 ACTIVE');
  assert.equal(active!.id, first.window.id);
  const candidates = db.prepare("SELECT COUNT(*) n FROM windows WHERE conversation_id='c1' AND status IN ('PREPARING')").get() as { n: number };
  assert.equal(candidates.n, 0, '失败的 candidate 不得悬挂 PREPARING');
});

test('身份退回 BLOCKED → 拒绝轮转，旧窗 ACTIVE（降级路径）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identityGood = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identityGood, paths.handoffsDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const gate = identityGood.evaluateGate(db);
  const first = windows.createWindow({ conversationId: 'c1', gate });
  const identityBad = new IdentityService(buildConfig({ runtime: { model: null } }), paths);
  const rotate = windows.rotate({ conversationId: 'c1', gate: identityBad.evaluateGate(db), maxSequence: 0 });
  assert.equal(rotate.ok, false);
  assert.equal(windows.activeWindow('c1')!.id, first.window.id);
});
