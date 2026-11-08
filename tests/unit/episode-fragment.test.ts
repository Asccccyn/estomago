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
      return { ok: true, data: { episodes: [EP('装修新房')], has_more: false } };
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
  const episodes: EpisodeListPort = { list: async () => { calls++; return { ok: false }; } };
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
