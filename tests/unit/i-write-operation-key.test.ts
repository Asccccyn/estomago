// P4（四仓合并审计 20261106，T01/T03）：I 写链稳定操作身份——E 客户端把
// operation_id 同时放 body 与信封 idempotency_key（G2-F07 同款双通道），
// M 端领域事务同提交回执；行为级验证见 M 仓 test_i_write_idempotency.py。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

type Captured = { cap: string; payload: Record<string, unknown>; envelope?: Record<string, unknown> };

test('i.item.create/revise/restore 带 operationId：body 与信封双通道同键', async () => {
  const calls: Captured[] = [];
  const client = new MariposaClient({ baseUrl: 'http://127.0.0.1:1', credentialEnv: 'X' } as never);
  const stub = client as unknown as {
    transport: (cap: string, payload: Record<string, unknown>, signal?: unknown, envelope?: Record<string, unknown>) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  };
  stub.transport = async (cap, payload, _signal, envelope) => {
    calls.push({ cap, payload, envelope });
    return { ok: true, result: { item_id: 'i_x', revision: 1 } };
  };
  await client.iItemCreate({ content: '一句话', operationId: 'i-create:t1:r1:c1' });
  await client.iItemRevise({ itemId: 'i_x', content: '改', expectedRevision: 1, operationId: 'i-revise:t1:r1:c2' });
  await client.iItemRestore({ itemId: 'i_x', restoreRevision: 1, expectedRevision: 2, operationId: 'i-restore:t1:r1:c3' });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.ok(typeof c.payload['operation_id'] === 'string', `${c.cap} body 带 operation_id`);
    assert.equal(c.envelope?.['idempotency_key'], c.payload['operation_id'], `${c.cap} 信封键与 body 同源`);
  }
  // 无 operationId：不添键（旧行为）
  await client.iItemCreate({ content: '旧路径' });
  const last = calls.at(-1)!;
  assert.equal(last.payload['operation_id'], undefined);
  assert.equal(last.envelope, undefined);
});
