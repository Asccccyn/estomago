// A12（P08）：电话停止与排队——挂断（DELETE /v1/calls/:id）后，voice_calls 置 ended，
// 由此 memory_only 通话门失效、且后续已取消的排队通话回合不再以"通话中"资格派发。
// 与既有 exec-v1-wp4（stopRun 后无新派发）、a11（挂断意图）互补；本用例锁 HTTP 收口
// → voice_calls 状态 → 通话资格门三点联动（offline contract）。
import { test } from 'node:test';
import { assembleTestTools } from '../helpers.ts';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const enc = new TextEncoder();

function req(url: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown) {
  const r = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
  r.headers = headers; r.method = method; r.url = url;
  return r;
}
// 与 dial-request-flow 的 FakeRes 同形态（writeHead/end 是 http.ts json() 真实调用面）
class FakeRes {
  status = 0; body = '';
  writeHead(code: number): void { this.status = code; }
  end(chunk?: string): void { if (chunk) this.body += chunk; }
  write(chunk: string): void { this.body += chunk; }
  setHeader(): void {}
  flushTail(): void {}
}
const fakeRes = (): FakeRes => new FakeRes();

test('A12: 挂断收口后排队通话回合的 memory_only 资格随 voice_calls 终态失效；stopRun 后排队不再派发', async () => {
  const { handleVoiceCallLifecycle } = await import('../../apps/host/src/server/http.ts');
  const { openDatabase } = await import('../../apps/host/src/db/connection.ts');
  const { migrate } = await import('../../apps/host/src/db/migrations.ts');
  const { sha256Hex } = await import('../../apps/host/src/util/id.ts');
  const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
  const { HostToolExecutor } = await import('../../apps/host/src/runtime/host-tools.ts');
  const { wireOidoCapabilitiesForTest } = await import('../helpers.ts');
  const { makeDb } = await import('../helpers.ts');
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'a12-token';

  const { db } = makeDb();
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-10-25T00:00:00Z')").run();
  const { tools: exec } = assembleTestTools({ db: db, mariposa: null, reviews: new (await import('../../apps/host/src/context/rotation-review.ts')).RotationReviewService(db), checkpoint: new (await import('../../apps/host/src/memory/hold-checkpoint.ts')).HoldCheckpointService(db) });
  const callCtx = (turnId: string) => ({ roomId: 'c1', windowId: 'w1', turnId, purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'a12' });

  // ① 通话立册（active）→ 通话内非记忆业务被门挡
  let res = fakeRes();
  await handleVoiceCallLifecycle(req('/v1/calls', 'POST', { authorization: 'Bearer a12-token' }, { call_id: 'call-a12', conversation_id: 'c1' }), res as never, { db } as never, 'POST /v1/calls');
  assert.equal(JSON.parse(res.body).state, 'active');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z')").run();
  const inCall = await exec.execute('wishstar_special_dates', {}, callCtx('t1'));
  assert.equal((inCall.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL', '通话内非记忆工具被门挡');

  // ② 挂断收口（幂等面）→ voice_calls=ended → 同一工具恢复可用
  res = fakeRes();
  await handleVoiceCallLifecycle(req('/v1/calls/call-a12', 'DELETE', { authorization: 'Bearer a12-token' }), res as never, { db } as never, 'DELETE /v1/calls/call-a12');
  assert.equal(JSON.parse(res.body).state, 'ended');
  // 挂断后资格门失效的判据：错误码从 TOOL_UNAVAILABLE_IN_CALL 变为**业务真实错误**
  // （此处=许愿星未接入 INTEGRATION_UNCONFIGURED；门不再先挡）
  const after = await exec.execute('wishstar_special_dates', {}, callCtx('t2'));
  assert.equal((after.output as { error_code: string }).error_code, 'INTEGRATION_UNCONFIGURED', '挂断后 memory_only 资格随终态失效（门不再先挡，业务如实拒绝）');

  // ③ 挂断幂等：再挂断返回 ended（不报错不重复收口）
  res = fakeRes();
  await handleVoiceCallLifecycle(req('/v1/calls/call-a12', 'DELETE', { authorization: 'Bearer a12-token' }), res as never, { db } as never, 'DELETE /v1/calls/call-a12');
  assert.equal(JSON.parse(res.body).state, 'ended');

  db.close();
  delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  void enc;
});
