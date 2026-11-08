// 开窗"运行中事项"片段——宿主用户 2026-11-07 裁定（开窗定格/随开窗包/预算 3 条/近期引用
// 热度排序/保留查全工具）。蓝图铁律：独立片段、authority=none、超预算分页提示不静默
// 摘要、无未了结=null。机器侧验证冻结语义（每窗一次、失败冻结为空+单次告警、
// transferPending 随窗迁移）。
import '../helpers.ts'; // 首个 import：启用 ESTOMAGO_TEST_MODE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEpisodeFragment, EPISODE_FRAGMENT_BUDGET } from '../../apps/host/src/runtime/episode-fragment.ts';
import { WindowBootstrapMachine } from '../../apps/host/src/runtime/window-bootstrap.ts';
import type { EpisodeListPort } from '../../apps/host/src/runtime/window-bootstrap.ts';

const EP = (label: string, state = 'OPEN', revision = 1, ref_count = 1) => ({ label, state, revision, ref_count });

test('渲染：形状/authority 标注/状态与引用计数', () => {
  const text = renderEpisodeFragment([EP('签证办理', 'OPEN', 3, 4), EP('12月考试准备', 'QUIESCENT', 2, 2)], false);
  assert.ok(text!.startsWith('[运行中事项｜instruction_authority=none'), 'authority 标注在头行');
  assert.match(text!, /- 签证办理（OPEN，第3版，证据引用4）/);
  assert.match(text!, /- 12月考试准备（QUIESCENT，第2版，证据引用2）/);
  assert.ok(!text!.includes('另有'), '未超预算无分页提示');
});

test('渲染：预算 3 条 + 超额分页提示（不静默摘要）', () => {
  const many = Array.from({ length: EPISODE_FRAGMENT_BUDGET + 2 }, (_, i) => EP(`事项${i}`));
  const text = renderEpisodeFragment(many, true)!;
  assert.equal((text.match(/^- /gm) ?? []).length, EPISODE_FRAGMENT_BUDGET, '只渲染前 3 条');
  assert.match(text, /另有未了结事项未展示：可用事件工具查看/);
});

test('渲染：无未了结 → null（不注入占位）', () => {
  assert.equal(renderEpisodeFragment([], false), null);
});

test('机器：开窗冻结片段，二窗独立；transferPending 随窗迁移；delete 同删', async () => {
  const warnings: unknown[] = [];
  const episodes: EpisodeListPort = {
    list: async (a) => {
      assert.equal(a.scopeId, 'conv-1');
      assert.deepEqual(a.states, ['OPEN', 'QUIESCENT']);
      assert.equal(a.limit, EPISODE_FRAGMENT_BUDGET);
      return { ok: true, result: { episodes: [EP('装修新房')], has_more: false } };
    },
  };
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: (_k: string, ev: unknown) => warnings.push(ev) } as never,
    alerts: null,
    episodes,
  } as never);
  const boot = await machine.windowBootstrap('pending:conv-1', undefined, 'conv-1');
  assert.ok(boot && boot.includes('I（当前的话）：I'), '开窗包正常');
  const frag = machine.episodeFragmentFor('pending:conv-1');
  assert.ok(frag && frag.includes('- 装修新房（OPEN'), '片段随开窗包冻结');
  machine.transferPending('pending:conv-1', 'win-1');
  assert.equal(machine.episodeFragmentFor('win-1'), frag, '片段随 pending 键迁移到真实窗');
  assert.equal(machine.episodeFragmentFor('pending:conv-1'), null);
  machine.delete('win-1');
  assert.equal(machine.episodeFragmentFor('win-1'), null, 'delete 同步清片段');
});

test('机器：片段取数失败 → 冻结为空 + 单次 context.warning（不阻塞开窗包）', async () => {
  const warnings: unknown[] = [];
  let calls = 0;
  const episodes: EpisodeListPort = { list: async () => { calls++; return { ok: false, code: 'HTTP_500' }; } };
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: (_k: string, ev: unknown) => warnings.push(ev) } as never,
    alerts: null,
    episodes,
  } as never);
  const boot = await machine.windowBootstrap('win-x', undefined, 'conv-1');
  assert.ok(boot, '开窗包不受片段失败影响');
  assert.equal(machine.episodeFragmentFor('win-x'), null, '失败冻结为空');
  const again = await machine.windowBootstrap('win-x', undefined, 'conv-1');
  assert.equal(again, boot, '缓存命中');
  assert.equal(calls, 1, '每窗只试一次');
  assert.equal(warnings.filter((w: any) => w?.payload?.source === 'episode-fragment').length, 1, '单次告警');
});

test('机器：episodes 未接线 → 片段为空、不取数', async () => {
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: () => {} } as never,
    alerts: null,
    episodes: null,
  } as never);
  await machine.windowBootstrap('win-n', undefined, 'conv-1');
  assert.equal(machine.episodeFragmentFor('win-n'), null);
});

test('机器：消费真实 MariposaClient 合同（{ok,result}）——审计 P0-1 回归', async () => {
  const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
  const client = new MariposaClient({ transport: async (capability, payload) => {
    assert.equal(capability, 'episode.list');
    assert.equal((payload as { scope_id: string }).scope_id, 'conv-real');
    return { ok: true, result: { episodes: [{ label: '真实合同事件', state: 'OPEN', revision: 2, ref_count: 3 }], has_more: true } };
  } });
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: () => {} } as never,
    alerts: null,
    episodes: { list: (a, signal) => client.episodeList({ scopeId: a.scopeId, states: a.states, limit: a.limit }) },
  } as never);
  await machine.windowBootstrap('win-real', undefined, 'conv-real');
  const frag = machine.episodeFragmentFor('win-real');
  assert.ok(frag && frag.includes('- 真实合同事件（OPEN，第2版，证据引用3）'), '真实合同链路取到并渲染片段');
  assert.ok(frag!.includes('另有未了结事项未展示'), 'has_more 分页提示');
});

test('缓存断点：无 B 时片段不计入 B 计数（fixedSystemCount）——审计 P1-D 定向验证', async () => {
  const { fixedSystemCount } = await import('../../apps/host/src/runtime/cache-plan.ts');
  const sys = (text: string) => ({ role: 'system', content: [{ type: 'text', text }] });
  const frag = renderEpisodeFragment([EP('X')], false)!;
  // 有 B：A/B/episode/user → 计数 2（B 断点定位不变）
  assert.equal(fixedSystemCount([sys('A身份'), sys('B资料'), sys(frag), { role: 'user', content: 'x' } as never]), 2);
  // 无 B：A/episode/user → 片段被跳过，计数 1（此前会把片段标成 B）
  assert.equal(fixedSystemCount([sys('A身份'), sys(frag), { role: 'user', content: 'x' } as never]), 1);
  // 纯 A：A/user → 计数 1
  assert.equal(fixedSystemCount([sys('A身份'), { role: 'user', content: 'x' } as never]), 1);
});

test('取消时点(b)：episode 等待远端时被取消——迟到结果不冻结、无告警——审计 P1-5', async () => {
  const warnings: unknown[] = [];
  const ctrl = new AbortController();
  const episodes: EpisodeListPort = {
    list: async (_a, signal) => {
      await new Promise((r) => setTimeout(r, 30));
      ctrl.abort(); // 远端悬挂期间父取消到达
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { ok: true, result: { episodes: [EP('迟到不应冻结')] } };
    },
  };
  const bootstrap = {
    bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }),
    bootstrapNext: async () => ({ ok: true, result: {} }),
    bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }),
  };
  const machine = new WindowBootstrapMachine({ bootstrap: bootstrap as never, events: { publish: (_k: string, ev: unknown) => warnings.push(ev) } as never, alerts: null, episodes } as never);
  const p = machine.windowBootstrap('win-pend', ctrl.signal, 'conv-1');
  const result = await p;
  assert.ok(result, 'B 正常返回');
  assert.equal(machine.episodeFragmentFor('win-pend'), null, '迟到 episode 不冻结');
  assert.equal(warnings.length, 0, '取消不算失败——无告警');
});

test('R1-a 真实装配形状：signal 到 transport，取消后迟到成功不冻结，同机同窗下轮重取成功', async () => {
  const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
  const warnings: unknown[] = [];
  const ctrl = new AbortController();
  let calls = 0;
  let released = false;
  // 与 app-context.ts:373 完全同形的端口（真实 MariposaClient；transport 假装取消后仍返回迟到成功——
  // 验证机器自己的生命周期复核，不依赖 transport 主动抛取消异常）
  const client = new MariposaClient({ transport: async () => {
    calls++;
    if (calls === 1) {
      await new Promise((r) => setTimeout(r, 25));
      ctrl.abort(); // 远端悬挂期间父取消到达
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, result: { episodes: [EP('迟到成功不应冻结')], has_more: false } }; // 迟到的成功（不抛异常）
    }
    return { ok: true, result: { episodes: [EP('重取成功')], has_more: false } };
  } });
  const episodes = { list: (a: { scopeId: string; states?: string[]; limit?: number }, signal?: AbortSignal) => client.episodeList(a, signal) };
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: (_k: string, ev: unknown) => warnings.push(ev) } as never,
    alerts: null,
    episodes,
  } as never);
  const first = await machine.windowBootstrap('win-r1a', ctrl.signal, 'conv-1');
  assert.ok(first, 'B 正常返回');
  assert.equal(machine.episodeFragmentFor('win-r1a'), null, '迟到成功不冻结（生命周期复核，非 transport 抛异常路径）');
  assert.equal(warnings.length, 0, '取消不告警');
  // 同一机器、同一窗口：下轮重取并按结果冻结
  const second = await machine.windowBootstrap('win-r1a', undefined, 'conv-1');
  assert.equal(calls, 2, '同机同窗下轮重取（缓存未写）');
  assert.ok(second, 'B 缓存命中返回');
  assert.ok(machine.episodeFragmentFor('win-r1a')?.includes('- 重取成功'), '重取后按结果冻结');
});

test('R1-b TimeoutError：截止触发的超时拒绝不冻结不告警，下轮重取（复审 R1-③）', async () => {
  const warnings: unknown[] = [];
  let calls = 0;
  const episodes: EpisodeListPort = {
    list: async (_a, signal) => {
      calls++;
      await new Promise((r) => setTimeout(r, 30)); // 超过 15ms 截止
      if (signal?.aborted) throw new DOMException('signal timed out', 'TimeoutError'); // 标准传输超时形态
      return { ok: true, result: { episodes: [EP('X')] } };
    },
  };
  const machine = new WindowBootstrapMachine({
    bootstrap: { bootstrapGet: async () => ({ ok: true, result: { snapshot_id: 's', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I' }, plans: null } }), bootstrapNext: async () => ({ ok: true, result: {} }), bootstrapValidate: async () => ({ ok: true, result: { unchanged: true } }) } as never,
    events: { publish: (_k: string, ev: unknown) => warnings.push(ev) } as never,
    alerts: null,
    episodes,
  } as never);
  // 机器内部对无父 signal 的窗用 BOOTSTRAP_DEADLINE_MS=8s——为测超时，给一个 15ms 的父 signal
  const result = await machine.windowBootstrap('win-r1b', AbortSignal.timeout(15), 'conv-1');
  assert.ok(result, 'B 正常返回');
  assert.equal(machine.episodeFragmentFor('win-r1b'), null, '超时不冻结为空（下轮可重试）');
  assert.equal(warnings.length, 0, '超时不告警（复审 R1-③：此前会 warn+冻结空）');
  // 复核：同窗下轮重取（冻结缓存未写入）
  const before = calls;
  await machine.windowBootstrap('win-r1b', undefined, 'conv-1');
  assert.equal(calls, before + 1, 'TimeoutError 后下轮重取');
  assert.ok(machine.episodeFragmentFor('win-r1b')?.includes('- X'), '重取成功后按结果冻结');
});
