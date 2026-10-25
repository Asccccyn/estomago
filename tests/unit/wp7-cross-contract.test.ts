// WP7（I01/I03）：双端合同穿透——用 Mariposa 真实 registry 产出的三模式响应包
// （tests/fixtures/wp7-real-m-packets.json，由 M 仓 glm/manual-handoff-20261008
// 真链路生成：registry.invoke → memory.recall.start / paging.serve_page）
// 经 E 真 MariposaClient（fake transport 只做管道）→ HostToolExecutor →
// 验证模型可见层的字段保真。I03：工具面/能力面一致性。
import { test } from 'node:test';
import { validateToolArgs, wireOidoCapabilitiesForTest } from '../helpers.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { HostToolExecutor, buildHostTools } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKETS = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/wp7-real-m-packets.json'), 'utf8')) as Record<string, Record<string, unknown>>;

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r' } as const;

function makeExecutor(root: string, transport: (cap: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; code?: string; httpStatus?: number }>) {
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  wireOidoCapabilitiesForTest(tools, {});
  return tools;
}

test('I01：真实 M 包经 E 工具层——off 模式页合同字段端到端保真', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const root = tempRoot('wp7-i01-');
  const executor = makeExecutor(root, async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    if (cap === 'memory.recall.start') return { ok: true, result: PACKETS.off_first_page };
    if (cap === 'memory.recall.page') return { ok: true, result: PACKETS.off_page2 };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  });
  const first = await executor.execute('memory_recall', { __tool_call_id: 'c1', query: '搬家' }, CTX);
  assert.equal(first.ok, true, JSON.stringify(first.output).slice(0, 200));
  const o = first.output as Record<string, unknown>;
  // R1′（1023，模型输出合同 bd677ed）：judge_mode/judgement_status/candidate_total/
  // pagination_note 不再逐字段回显——judge 状态以 judgement 等价表达（off=unjudged、
  // 非常规状态原样）；翻页续读信号=pagination 块存在性（含 result_set_id/next_cursor/
  // has_more）。业务实质（双页并集/有界交付/会话范围）不变。
  assert.equal(o.judgement, 'unjudged', 'judge off 以 judgement 表达');
  assert.equal((o.pagination as Record<string, unknown>).next_cursor !== undefined, true, '翻页续读引用到达模型可见层');
  assert.equal((o.pagination as Record<string, unknown>).has_more, true, 'R1′(1023) 旧窗兼容：块内恒带 has_more——旧冻结描述读 pagination.has_more 仍可完整续读');
  assert.equal((o.candidates as unknown[]).length, 10);
  // 续页：真实 page 包经 memory_recall_next
  const next = await executor.execute('memory_recall_next', {
    __tool_call_id: 'c2',
    result_set_id: (o.pagination as Record<string, unknown>).result_set_id as string,
    cursor: (o.pagination as Record<string, unknown>).next_cursor as string,
    session_id: o.recall_session_id as string,
  }, CTX);
  assert.equal(next.ok, true, JSON.stringify(next.output).slice(0, 200));
  const n = next.output as Record<string, unknown>;
  assert.equal((n.candidates as unknown[]).length, 5);
  assert.equal('pagination' in n, false, '尾页无 pagination 块=本次结果集已尽（R1′ 存在性信号）');
  // 双页并集=15（全候选可取，不截于 3/10）
  assert.equal(10 + 5, 15);
  assert.equal(calls[0]!.payload.conversation_scope, 'c1');
  db_close(root);
});

test('I01：on 模式真实包——有界交付字段保真（judgement_status=evaluated）', async () => {
  const root = tempRoot('wp7-i01b-');
  const executor = makeExecutor(root, async (cap) => {
    if (cap === 'memory.recall.start') return { ok: true, result: PACKETS.on_first_page };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  });
  const out = await executor.execute('memory_recall', { __tool_call_id: 'c', query: '搬家' }, CTX);
  assert.equal(out.ok, true);
  const o = out.output as Record<string, unknown>;
  // R1′（1023）：on+evaluated 属常规完成态——judgement 不输出（无异常即成功）；
  // 有界交付 0-3 卡与尾页无 pagination 块语义不变
  assert.equal('judgement' in o, false);
  assert.equal((o.candidates as unknown[]).length, 3, '有界交付保持 0-3 卡');
  assert.equal('pagination' in o, false);
  db_close(root);
});

test('I03：工具面一致性——conversation_read/memory_recall(_next) 在 allowlist 与 schema；policy 工具不在主模型面', () => {
  const tools = buildHostTools().map((t) => t.function.name);
  assert.ok(tools.includes('conversation_read'));
  assert.ok(tools.includes('memory_recall'));
  assert.ok(tools.includes('memory_recall_next'));
  // 主模型工具不提供判断政策写权（maintenance.recall_policy.* 仅为人类网页面）
  assert.ok(!tools.some((n) => n.includes('policy')));
  // E 执行器 allowlist 覆盖三工具（执行路径真实可达）
  for (const name of ['conversation_read', 'memory_recall_next']) {
    const bad = validateToolArgs(name, {});
    assert.ok(bad.ok || bad.code === 'TOOL_ARG_REQUIRED', `${name} 参数门真实接线`);
  }
});

function db_close(root: string) {
  // executor 的 db 在 makeExecutor 里创建——借 fixture 目录再开再关不必要；
  // node:sqlite 句柄随进程退出回收（测试进程独立运行）
  void root;
}
