// A11 est 侧（2026-10-24）：call_control(end)——模型提出挂断当前通话（柔性，立即回执）。
import { test } from 'node:test';
import { assembleTestTools } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { ModelToolBridge, type ToolExecContext } from '../../apps/host/src/capabilities/model-bridge.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

test('A11 call_control(end)：active 通话→Siren 柔性挂断端点立即回执；无通话如实拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11-est-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const hangupCalls: string[] = [];
  const transport: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/hangup-request')) { hangupCalls.push(u); return Response.json({ call_id: 'call-x', accepted: true }); }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const sirenCall = new SirenAdapter('http://127.0.0.1:1', 't', transport);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), sirenCall: sirenCall });
  const ctx = (): ToolExecContext => ({ roomId: 'c1', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'a11' });
  try {
    // 无 active 通话：如实拒绝
    const none = await tools.execute('call_control', { action: 'end' }, ctx());
    assert.equal(none.ok, false);
    assert.equal((none.output as Record<string, unknown>)['error_code'], 'NO_ACTIVE_CALL');
    // 有 active 通话：转 Siren 柔性挂断（立即回执；不伪造已结束）
    db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES ('call-x','c1','active',?)").run(new Date().toISOString());
    const out = await tools.execute('call_control', { action: 'end' }, ctx());
    assert.equal(out.ok, true, JSON.stringify(out.output));
    assert.equal((out.output as Record<string, unknown>)['accepted'], true);
    assert.ok(hangupCalls.length === 1 && hangupCalls[0]!.includes('/v1/calls/call-x/hangup-request'));
    assert.equal(db.prepare("SELECT state FROM voice_calls WHERE call_id='call-x'").get().state, 'active', 'est 不伪造结束——终态由挂断收口链落');
    console.log(JSON.stringify({ case: 'a11_call_control_end' }));
  } finally {
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
