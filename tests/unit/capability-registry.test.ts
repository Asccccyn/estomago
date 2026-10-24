// P02.1：registry 不变量——显式注册、重复名拒绝、缺件拒绝、定义名一致、按 baselineOrder 枚举、
// 显式缺失拒绝（get→null，不静默造默认）。纯装配面单测（政策 §1 纯函数类）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, type CapabilityDescriptor } from '../../apps/host/src/capabilities/registry.ts';

function makeDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: 'probe_tool', owner: 'probe', baselineOrder: 28,
    definition: { type: 'function', function: { name: 'probe_tool', description: 'd', parameters: { type: 'object', properties: {} } } },
    memoryOnlyAllowed: false, silent: false,
    quote: () => ({ toolName: 'probe_tool', maxCostMicroUsd: 1, verifiedFree: false }),
    parse: (raw) => ({ ok: true, value: raw }),
    run: async () => ({ ok: true, value: {} }),
    toModel: (v) => (v as Record<string, unknown>),
    ...overrides,
  } as CapabilityDescriptor;
}

test('正常注册后可查、按 baselineOrder 枚举、未登记显式返回 null', () => {
  const r = new CapabilityRegistry();
  assert.equal(r.get('probe_tool'), null, '未登记=显式 null');
  r.register(makeDescriptor());
  r.register(makeDescriptor({ id: 'aaa_tool', baselineOrder: 2, definition: { type: 'function', function: { name: 'aaa_tool', description: 'd', parameters: {} } } }));
  assert.equal(r.size, 2);
  assert.deepEqual(r.listByBaselineOrder().map((d) => d.id), ['aaa_tool', 'probe_tool']);
  assert.equal(r.has('probe_tool'), true);
});

test('重复名/缺件/定义名不符/顺序非法一律拒绝', () => {
  const r = new CapabilityRegistry();
  r.register(makeDescriptor());
  assert.throws(() => r.register(makeDescriptor()), /CAPABILITY_ALREADY_REGISTERED/);
  assert.throws(() => r.register(makeDescriptor({ run: undefined as never })), /CAPABILITY_INCOMPLETE/);
  assert.throws(() => r.register(makeDescriptor({ definition: { type: 'function', function: { name: 'other', description: 'd', parameters: {} } } })), /CAPABILITY_DEFINITION_MISMATCH/);
  assert.throws(() => r.register(makeDescriptor({ baselineOrder: 0 })), /CAPABILITY_ORDER_INVALID/);
  assert.throws(() => r.register(makeDescriptor({ id: '' })), /CAPABILITY_ID_INVALID/);
  assert.equal(r.size, 1, '失败注册不产生半状态');
});
