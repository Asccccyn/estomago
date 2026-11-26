// G2-F07（裁定 2026-11-03）：计划写入的 operation_id 同时作信封级
// idempotency_key 过线——由 M 端通用传输幂等（claim/终态重放/崩溃恢复）
// 真实执行；同 key 同 payload 重试安全。不是"字段发了没人消费"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

type Captured = { cap: string; payload: Record<string, unknown>; envelope?: Record<string, unknown> };

function capturingTransport(out: Partial<Captured>[]): MariposaTransport {
  return async (cap, payload, _signal, envelope) => {
    out.push({ cap, payload, envelope });
    return { ok: true, result: { plan_id: 'pl_1', version: 1 } };
  };
}

test('G2-F07：planCreate/planUpdate 信封携带 idempotency_key（与 arguments.operation_id 同值）', async () => {
  const calls: Partial<Captured>[] = [];
  const client = new MariposaClient({ transport: capturingTransport(calls) });

  await client.planCreate({ title: '中秋去海边', operationId: 'es-pw-op-1' });
  await client.planUpdate({ planId: 'pl_1', expectedVersion: 1, title: '改期', operationId: 'es-pw-op-2' });

  assert.equal(calls[0]!.cap, 'plan.create');
  assert.equal(calls[0]!.payload.operation_id, 'es-pw-op-1', 'arguments 内操作身份保留（F06 schema 已接受）');
  assert.equal(calls[0]!.envelope?.idempotency_key, 'es-pw-op-1', '信封级幂等键=M HTTP 入口读取位置');

  assert.equal(calls[1]!.cap, 'plan.update');
  assert.equal(calls[1]!.envelope?.idempotency_key, 'es-pw-op-2', 'update 同样过线（F07）');
});

test('G2-F07：defaultTransport 把信封字段放进 HTTP body 顶层（与 arguments 平级）', async () => {
  // 直接驱动 defaultTransport 的 fetch：拦截全局 fetch 捕获请求体
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, data: { plan_id: 'pl_2' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const transport = new MariposaClient({ baseUrl: 'http://127.0.0.1:1', credentialEnv: null });
    // @ts-expect-error 访问私有 transport 仅为本测试驱动 wire 形状
    const t = (transport as unknown as { transport: MariposaTransport }).transport;
    await t('plan.create', { title: 'x', operation_id: 'op-x' }, undefined, { idempotency_key: 'op-x' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(bodies[0]!.arguments && (bodies[0]!.arguments as Record<string, unknown>).title, 'x');
  assert.equal(bodies[0]!.idempotency_key, 'op-x', '信封字段在 body 顶层（M app.py 读取位置）');
});
