// P2 模型出口层一阶段（她 2026-10-20 批 4-A）：recall 卡最小投影——
// 五个零消费字段内部化、matched_by+matched_fields 合并、保留面不丢。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCandidatesForModel } from '../../apps/host/src/runtime/host-tools.ts';

const FULL = {
  resource_ref: 'memory:00051@3', channel: 'event', content_version: '3',
  memory_id: '00051', word_id: 'w1', ordinal: 2, speaker: 'jiaming',
  source_ref: 'sib_x', source_binding_version: '5', memory_date: '2026-07-09',
  matched_by: 'lexical', matched_fields: ['event_text', 'title'],
  excerpt: '原文摘录', truncated: false,
  evidence: [{ kind: 'authored_event' }], version_receipt: 'vr_1',
  evidence_requirement_met: true, judge: 'on',
};

test('投影：五个内部字段出站剔除，保留面原样', () => {
  const [c] = projectCandidatesForModel([FULL]) as Array<Record<string, unknown>>;
  for (const k of ['content_version', 'source_ref', 'source_binding_version', 'version_receipt', 'evidence_requirement_met']) {
    assert.equal(k in c, false, `${k} 应内部化`);
  }
  for (const k of ['resource_ref', 'channel', 'memory_id', 'word_id', 'ordinal', 'speaker', 'memory_date', 'excerpt', 'truncated', 'evidence', 'judge']) {
    assert.deepEqual(c[k], (FULL as Record<string, unknown>)[k], `${k} 保留原样`);
  }
});

test('投影：matched_by+matched_fields 合并为 matched', () => {
  const [c] = projectCandidatesForModel([FULL]) as Array<Record<string, unknown>>;
  assert.equal(c.matched, 'lexical:event_text+title');
  assert.equal('matched_by' in c, false);
  assert.equal('matched_fields' in c, false);
  // 单边存在也如实合并
  const [d] = projectCandidatesForModel([{ matched_by: 'semantic' }]) as Array<Record<string, unknown>>;
  assert.equal(d.matched, 'semantic');
  const [e] = projectCandidatesForModel([{}]) as Array<Record<string, unknown>>;
  assert.equal('matched' in e, false, '无匹配信息不造空字段');
});

test('投影：非对象条目原样透传（防御，不吞异形）', () => {
  assert.deepEqual(projectCandidatesForModel(['x', null, 3]), ['x', null, 3]);
});
