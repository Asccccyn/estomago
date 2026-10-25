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
  const windows = new WindowManager(db, events, identity, config);
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

test('READY → ACTIVE；轮转 prepare→原子切换；旧窗 CLOSED；receipt 可解析', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root); // 已播种探针
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, config);
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
    // handoff.json 交接文件已退役（她 2026-10-24 裁定：零读者、契约从未接入）——
    // 换窗证据正本=bootstrap receipt + 轨迹/manifest，不再有落盘交接件
    const receipt = db.prepare('SELECT id FROM bootstrap_receipts WHERE id = ?').get(rotate.window.receipt_id);
    assert.ok(receipt);
  }
});

test('AUD-20 语义保留：prepare 阶段失败 → 轮转整体失败，旧窗保持 ACTIVE（绝不 active=null）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const events = new EventService(db);
  const windows = new WindowManager(db, events, identity, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const gate = identity.evaluateGate(db);
  const first = windows.createWindow({ conversationId: 'c1', gate });

  // 故障注入：prepare 阶段 receipt 构建抛错（原 handoff 注入点已随交接文件
  // 退役移除；失败传播=同一 prepare_failed catch 路径）
  (windows as unknown as { identity: IdentityService }).identity = {
    buildAndStoreReceipt() { throw new Error('injected prepare failure'); },
  } as unknown as IdentityService;
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
  const windows = new WindowManager(db, events, identityGood, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const gate = identityGood.evaluateGate(db);
  const first = windows.createWindow({ conversationId: 'c1', gate });
  const identityBad = new IdentityService(buildConfig({ runtime: { model: null } }), paths);
  const rotate = windows.rotate({ conversationId: 'c1', gate: identityBad.evaluateGate(db), maxSequence: 0 });
  assert.equal(rotate.ok, false);
  assert.equal(windows.activeWindow('c1')!.id, first.window.id);
});
