// Source-regex contract comparisons were replaced by generated-contract checks
// and tests/cross-project/memory-tools.test.ts. Keep the independent wire-byte test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverNormalizedBytes } from '../../apps/host/src/integrations/mariposa/client.ts';
import { execFileSync } from 'node:child_process';

function pythonDumpsBytes(payload: unknown): number {
  // 服务端口径：json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')
  const json = JSON.stringify(payload);
  const out = execFileSync('python3', ['-c', `
import json, sys
payload = json.loads(sys.argv[1])
print(len(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')))
`, json], { encoding: 'utf8' });
  return Number(out.trim());
}

const goldenMessage = (i: number, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  origin_message_id: `msg-${i}`, revision: 1, previous_revision: null, conversation_sequence: i,
  predecessor: null, sender: i % 2 === 0 ? 'user' : 'assistant', published_kind: 'chat_message',
  occurred_at: '2026-10-06T21:00:00+08:00', received_at: '2026-10-06T21:00:01+08:00',
  published_at: '2026-10-06T21:00:02+08:00',
  text: `第${i}条：中文正文带引号"引号"、换行\\n、emoji 😀与制表\\t——月亮很圆`,
  assets: [], content_hash: 'a'.repeat(64), ...over,
});

test('F-J-12 黄金夹具：JS serverNormalizedBytes 与 Python 服务端口径逐样本相等', () => {
  const samples: Array<{ name: string; payload: unknown }> = [
    { name: '单条中文+emoji+引号+换行', payload: { operation_id: 'op-1', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: [goldenMessage(1)] } },
    { name: '50 条边界', payload: { operation_id: 'op-50', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: Array.from({ length: 50 }, (_, i) => goldenMessage(i + 1)) } },
    { name: '键序乱序（对象键插入序≠字典序）', payload: { zeta: 1, alpha: '中文', middle: null, beta: [3, 1, 2] } },
    { name: '空对象/空数组/空串/null', payload: { a: {}, b: [], c: '', d: null } },
    { name: '嵌套 predecessor', payload: { operation_id: 'op-p', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: [goldenMessage(2, { predecessor: { origin_message_id: 'msg-1', revision: 1 } })] } },
  ];
  for (const s of samples) {
    const js = serverNormalizedBytes(s.payload);
    const py = pythonDumpsBytes(s.payload);
    assert.equal(js, py, `${s.name}：JS=${js} Python=${py}（口径漂移）`);
  }
});
