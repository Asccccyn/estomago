// AUD-22 回归：window.receipt_id 解析到真实记录；READY 时 assembled.options_hash 真实。
// AUD-28 回归：日志不落秘密（稳定错误码）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { stableErrorCode } from '../../apps/host/src/observability/errors.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';

test('AUD-22：READY 开窗 → receipt_id 可解析且 assembled 含真实 options_hash', () => {
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
  const { window } = windows.createWindow({ conversationId: 'c1', gate, assembledOptions: { probe: true } });
  const receipt = db.prepare('SELECT id, assembled FROM bootstrap_receipts WHERE id = ?').get(window.receipt_id) as { id: string; assembled: string } | undefined;
  assert.ok(receipt, 'receipt_id 必须解析到真实 bootstrap_receipts 记录');
  const assembled = JSON.parse(receipt!.assembled) as { options_hash: string | null };
  assert.match(String(assembled.options_hash), /^[0-9a-f]{64}$/, 'READY 时 options_hash 必须来自真实装配');
  db.close();
});

test('AUD-28：错误码映射稳定；原始消息不进日志字段', () => {
  assert.equal(stableErrorCode(new SyntaxError("Expected ',' or '}' after property value in JSON at position 44")), 'INVALID_JSON');
  assert.equal(stableErrorCode(new Error('SQLITE_CONSTRAINT: UNIQUE failed')), 'DB_ERROR');
  assert.equal(stableErrorCode(new Error('route_signal: model_switch_requested SECRET')), 'SDK_ROUTE_SIGNAL');
  const logger = new Logger(null);
  const SECRET = 'AUDIT_SECRET_DO_NOT_LOG_xyz';
  // 模拟 route_error 路径：只记 code
  const captured: string[] = [];
  const origLog = console.error;
  console.error = (...a: unknown[]) => { captured.push(a.join(' ')); };
  try {
    logger.error('route_error', { route: 'POST /x', code: stableErrorCode(new SyntaxError(SECRET)) });
  } finally {
    console.error = origLog;
  }
  assert.equal(captured.join('').includes(SECRET), false, '日志不得包含原始异常文本');
});
