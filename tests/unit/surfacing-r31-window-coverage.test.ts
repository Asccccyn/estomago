import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { unreadSurfaceItem, windowCoverage } from '../../apps/host/src/memory-surfacing/window-coverage.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';

const at = '2026-11-17T00:00:00Z';
const text = '甲🦋丁';
const seen = { resource_ref: 'memory:m1', content_version: '2', start_char: 0, end_char: 2 };
const candidate = {
  resource_ref: 'memory:m1', memory_ref: 'sf_detail', content_version: '2', excerpt: text,
  coverage_ranges: [{ ...seen, end_char: 3 }],
};

test('固定召回页只认已确认投递的同资源、同版本范围，保留游标并支持本次重读', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, sha256Hex);
  try {
    db.prepare("INSERT INTO conversations(id, created_at) VALUES('c1', ?)").run(at);
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE',?,?)").run(at, at);
    const sourceTool = { role: 'tool', tool_call_id: 'read_1', content: JSON.stringify({ candidates: [{ excerpt: '甲🦋' }] }) };
    const trajectory = new WindowTrajectoryService(db);
    trajectory.init('w1', [sourceTool], []);
    const insert = db.prepare(`INSERT INTO provider_requests(id,window_id,purpose,payload_json,seen_manifest_json,created_at,sent_at)
      VALUES(?,'w1','chat',?,?,?,?)`);
    insert.run('create_1', JSON.stringify({ messages: [] }),
      JSON.stringify([{ tool_coverage: [{ tool_call_id: 'read_1', ranges: [seen] }] }]), at, at);
    insert.run('deliver_1', JSON.stringify({ messages: [sourceTool] }), '[]', at, null);

    const mariposa = new MariposaClient({ transport: async () => ({ ok: true, result: {
      candidates: [candidate, { ...candidate, content_version: '3', coverage_ranges: [{ ...seen, content_version: '3', end_char: 3 }] }],
      pagination: { result_set_id: 'rs1', candidate_total: 4, has_more: true, next_cursor: 'page_3' },
      recall_session_id: 's1', judge_mode: 'off',
    } }) });
    const memory = new MemoryToolsService({ db, mariposa, reviews: undefined as never, checkpoint: undefined as never });
    const args = { result_set_id: 'rs1', cursor: 'page_2' };
    const ctx = { roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat' as const, activeReviewId: null,
      seenSequence: 0, seenMessages: [], requestId: 'deliver_1' };
    assert.deepEqual(windowCoverage(db, 'w1'), [], 'persisted pending tool result is not read');

    db.prepare("UPDATE provider_requests SET sent_at=? WHERE id='deliver_1'").run(at);
    const page = await memory.memoryRecallNext(args, ctx);
    const [partial, revised] = page.output.candidates as Record<string, unknown>[];
    assert.deepEqual(partial!.unread_parts, [{ start_char: 2, end_char: 3, text: '丁' }]);
    assert.equal(partial!.excerpt, undefined);
    assert.equal(partial!.memory_ref, 'sf_detail');
    assert.equal(revised!.excerpt, text, 'a different version is new even with identical text');
    assert.equal((page.output.pagination as Record<string, unknown>).next_cursor, 'page_3');

    const reread = await memory.memoryRecallNext({ ...args, reread: true }, ctx);
    assert.equal((reread.output.candidates as Record<string, unknown>[])[0]!.excerpt, text);
    const sameRequest = page.coverageProjection?.([{ ...seen, start_char: 2, end_char: 3 }]);
    assert.equal((sameRequest?.output.candidates as Record<string, unknown>[])[0]!.included_in_this_request, true);
    assert.equal((sameRequest?.output.candidates as Record<string, unknown>[])[0]!.already_in_window, undefined);
  } finally { db.close(); }
});

test('取消在会话否定与原文二轮之间生效，二轮不发起', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, sha256Hex);
  try {
    const controller = new AbortController();
    const calls: string[] = [];
    const mariposa = new MariposaClient({ transport: async (capability, _args, signal) => {
      calls.push(capability);
      assert.equal(signal, controller.signal);
      controller.abort();
      return { ok: true, result: {} };
    } });
    const memory = new MemoryToolsService({ db, mariposa, reviews: undefined as never, checkpoint: undefined as never });
    const result = await memory.memoryRecall({ query: '合成请求', refine_session_id: 's1',
      reject_candidate_ref: 'memory:m1', deep_search: true }, {
      roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat', activeReviewId: null,
      seenSequence: 0, seenMessages: [], requestId: 'req1', signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['memory.recall.reject']);
  } finally { db.close(); }
});


test('部分已读的引语命中仍交付完整正文和全部原话，全部覆盖后不再浮现', () => {
  const body = { resource_ref:'memory:m1', content_version:'3', start_char:0, end_char:4 };
  const word = { resource_ref:'our_word:w1', content_version:'3:0', start_char:0, end_char:2 };
  const item = { kind:'words' as const, memory_id:'m1', memory_version:'3', event_id:'ev_1',
    event_text:'原句', quote_text:'原句', memory_date:null, date_confidence:null, body_hash:'hash', detail_ref:'sdr_1',
    matched_memory:{text:'完整正文',our_words:[{speaker:'qiaosheng',text:'原句'}]}, coverage_ranges:[body,word] };
  const partial = unreadSurfaceItem(item, [word]);
  assert.deepEqual(partial?.matched_memory, item.matched_memory);
  assert.deepEqual(partial?.coverage_ranges, [body]);
  assert.equal(unreadSurfaceItem(item, [word,body]), null);
});
