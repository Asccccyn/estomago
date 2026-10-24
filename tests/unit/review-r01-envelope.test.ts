// 复审 R01（2026-10-07，LINSHIJIAN_REVIEW）回归：召回信封必须穿过真实
// defaultTransport 验证，不再用扁平假 transport 绕开信封边界。
//  - found 包：真实 mariposa registry（冻结 6fee2da，合成数据）产出，
//    以修复后单层信封 {ok, data:packet} 回放——候选正文/session/状态
//    必须真的到达主模型工具输出（验收原文）。
//  - 同 ref 重放：真实包 + 顶层 idempotent_replay 标记 → 透传到输出。
//  - legacy 双层信封 {ok, data:{data:packet}}（冻结版原样，即复审反例
//    的原始形状）：修复前 estómago 把它默认成"空候选+成功"（FOUND 被
//    吞）；修复后必须大声失败 RECALL_ENVELOPE_INVALID。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const foundBody = readFileSync(path.join(here, '../fixtures/mariposa/recall-start-found.body.json'), 'utf8');
const legacyDoubleWrapBody = readFileSync(path.join(here, '../fixtures/mariposa/recall-start-legacy-doublewrap.body.json'), 'utf8');

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' } as const;

function toolsWithHttpBody(bodyFor: (cap: string) => string | null): HostToolExecutor {
  const root = tempRoot('r01env-');
  writeApprovedIdentity(root);
  buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const cap = url.slice(url.lastIndexOf('/') + 1);
    const body = bodyFor(cap);
    if (body === null) return new Response(JSON.stringify({ ok: false, error: { code: 'CAPABILITY_NOT_FOUND' } }), { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new MariposaClient({ baseUrl: 'http://127.0.0.1:19990', credentialEnv: null });
  const tools = new HostToolExecutor({ db, mariposa: client, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {});;
  return new Proxy(tools, {
    get(target, prop, receiver) {
      if (prop === 'close') { globalThis.fetch = originalFetch; db.close(); return () => {}; }
      return Reflect.get(target, prop, receiver);
    },
  }) as HostToolExecutor;
}

test('R01：真实 registry 包（单层信封）→ 候选/session/状态到达主模型输出', async () => {
  const packet = JSON.parse(foundBody).data as Record<string, unknown>;
  const tools = toolsWithHttpBody((cap) => (cap === 'memory.recall.start' ? foundBody : null));
  const out = await tools.execute('memory_recall', { __tool_call_id: 'call-e1', query: '上次聊中秋看月亮' }, CTX);
  tools.close();
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  assert.ok(Array.isArray(out.output.candidates) && out.output.candidates.length === (packet.candidates as unknown[]).length,
    'FOUND 的候选正文必须真的到达主模型');
  assert.equal(out.output.recall_session_id, packet.recall_session_id);
  // R1′（2026-10-23）：模型输出合同（bd677ed）下 FOUND=正常命中静默（无异常即成功），
  // 仅非 FOUND 状态可见（recall() 的 status 分支）；信封硬门（缺必需字段=RECALL_ENVELOPE_INVALID）
  // 在投影前的工具层保留（见下方双层信封反例）。
  assert.equal(out.output.status, undefined, 'FOUND 静默=新合同语义（非 FOUND 才输出 status）');
  assert.equal((out.output as Record<string, unknown>).idempotent_replay, undefined, '重放标记由宿主管理，不进普通投影');
});

test('R01：同 ref 重放（顶层 idempotent_replay）→ 可见结果与首发一致（重放不变形）', async () => {
  const packet = JSON.parse(foundBody).data as Record<string, unknown>;
  const replayBody = JSON.stringify({ ok: true, data: { ...packet, idempotent_replay: true } });
  const tools = toolsWithHttpBody((cap) => (cap === 'memory.recall.start' ? replayBody : null));
  const out = await tools.execute('memory_recall', { __tool_call_id: 'call-e2', query: '上次聊中秋看月亮' }, CTX);
  tools.close();
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  // R1′（2026-10-23）：重放=同请求同结果，宿主管理幂等（R01 业务反例保留为：
  // 重放结果与首发完全一致、无二次副作用征兆、session 不变——不是把重放标记送模）
  assert.ok(Array.isArray(out.output.candidates) && out.output.candidates.length === (packet.candidates as unknown[]).length, '重放候选与首发一致');
  assert.equal(out.output.recall_session_id, packet.recall_session_id);
  assert.equal((out.output as Record<string, unknown>).idempotent_replay, undefined, '重放标记由宿主管理，不进普通投影');
});

test('R01：冻结版双层信封（反例原始形状）→ 结构化报错，不再空候选装成功', async () => {
  const tools = toolsWithHttpBody((cap) => (cap === 'memory.recall.start' ? legacyDoubleWrapBody : null));
  const out = await tools.execute('memory_recall', { __tool_call_id: 'call-e3', query: '上次聊中秋看月亮' }, CTX);
  tools.close();
  assert.equal(out.ok, false, '双层信封=形状错误，必须失败');
  assert.equal(out.output.error_code, 'RECALL_ENVELOPE_INVALID');
  const missing = (out.output.missing_fields as string[]).sort();
  // WP-04（C10）：judge_mode 恒必需（M 现行契约）——负例同样披露
  assert.deepEqual(missing, ['candidates', 'judge_mode', 'recall_session_id', 'search_status'],
    '缺失的必需字段如实披露');
});
