// 2026-11-03 她裁四映射缺口接线验收：memory_correct 新增 plan_link/
// i_relation/trace 三动作、memory_i_read 新增 what=emotion——载荷形状
// 与 M 严格 schema 逐字段对齐（错一个字段名 M 端就是 SCHEMA_VIOLATION）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

type Call = { cap: string; payload: Record<string, unknown>; envelope?: Record<string, unknown> };

function compose(transport: MariposaTransport) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-gaps-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new MemoryToolsService({
    db, mariposa: new MariposaClient({ transport }),
    reviews: new RotationReviewService(db),
    checkpoint: new HoldCheckpointService(db),
  });
  return { db, svc };
}

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', requestId: 'r1', signal: undefined, purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], toolCallId: 'tc1', backgroundRunId: null };

test('plan_link：载荷=link_id+correction_action+operation_id（信封幂等键），M schema 逐字段对齐', async () => {
  const calls: Call[] = [];
  const { db, svc } = compose(async (cap, payload, _s, envelope) => {
    calls.push({ cap, payload, envelope });
    return { ok: true, result: { corrected: true } };
  });
  try {
    const out = await svc.memoryCorrect({ action: 'plan_link', correction_action: 'remove_wrong_binding', link_id: 'plk-1', note: '挂错记忆' }, CTX as never);
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(calls[0]!.cap, 'plan.memory.correct');
    const p = calls[0]!.payload;
    assert.equal(p.link_id, 'plk-1');
    assert.equal(p.correction_action, 'remove_wrong_binding');
    assert.ok(typeof p.operation_id === 'string' && p.operation_id.length > 0);
    assert.equal(p.note, '挂错记忆');
    assert.equal(Object.keys(p).filter(k => !['link_id','correction_action','operation_id','replacement','note'].includes(k)).length, 0, '无 schema 外字段（M additionalProperties=false）');
    assert.equal(calls[0]!.envelope?.idempotency_key, p.operation_id, '写操作过信封幂等键');
    // 缺 link_id → 门口拒绝零外发
    const bad = await svc.memoryCorrect({ action: 'plan_link', correction_action: 'remove_wrong_binding' }, CTX as never);
    assert.ok(!bad.ok && calls.length === 1, '必填缺失门口拒绝');
  } finally { db.close(); }
});

test('i_relation：载荷=relation_id+correction_action+operation_id', async () => {
  const calls: Call[] = [];
  const { db, svc } = compose(async (cap, payload) => {
    calls.push({ cap, payload });
    return { ok: true, result: { corrected: true } };
  });
  try {
    const out = await svc.memoryCorrect({ action: 'i_relation', correction_action: 'replace_wrong_binding', relation_id: 'ir-9', replacement: { item_id: 'ii-2' } }, CTX as never);
    assert.ok(out.ok);
    assert.equal(calls[0]!.cap, 'i.item.relations.correct');
    assert.equal(calls[0]!.payload.relation_id, 'ir-9');
    assert.deepEqual(calls[0]!.payload.replacement, { item_id: 'ii-2' });
  } finally { db.close(); }
});

test('trace：载荷=memory_id（+可选 max_depth），走 memory.relations.trace', async () => {
  const calls: Call[] = [];
  const { db, svc } = compose(async (cap, payload) => {
    calls.push({ cap, payload });
    return { ok: true, result: { chain: [] } };
  });
  try {
    const out = await svc.memoryCorrect({ action: 'trace', memory_id: '00455', max_depth: 3 }, CTX as never);
    assert.ok(out.ok);
    assert.equal(calls[0]!.cap, 'memory.relations.trace');
    assert.equal(calls[0]!.payload.memory_id, '00455');
    assert.equal(calls[0]!.payload.max_depth, 3);
    const out2 = await svc.memoryCorrect({ action: 'trace', memory_id: '00455' }, CTX as never);
    assert.ok(out2.ok);
    assert.equal('max_depth' in calls[1]!.payload, false, '缺省不带 max_depth');
  } finally { db.close(); }
});

test('emotion：memory_i_read what=emotion → emotion.context.get，只读数据面', async () => {
  const calls: Call[] = [];
  const { db, svc } = compose(async (cap, payload) => {
    calls.push({ cap, payload });
    return { ok: true, result: { vocabulary: ['sweet'], mood_tag_counts: { sweet: 3 } } };
  });
  try {
    const out = await svc.memoryIRead({ what: 'emotion' }, CTX as never);
    assert.ok(out.ok);
    assert.equal(calls[0]!.cap, 'emotion.context.get');
    assert.deepEqual(calls[0]!.payload, {});
    assert.equal((out.output as Record<string, unknown>).what, 'emotion');
  } finally { db.close(); }
});
