// 包4（2026-11-18）：MCP 发现减重、source_bind 退出模型面、无 seq 投影与锚点定位链。
// 只用本地合成夹具；不触发真实模型/付费调用/生产写。
//  - D01/D02/D03/D05/D06/D07：常用预载+单一 hook；catalog 意图/精确名一次返回完整定义；
//    已退出能力不回门；意图区分（正文修改 vs 纠错 vs 存档）。
//  - source_bind 退出：注册表/目录无此名，invoke 拒；memory_correct 无 binding；
//    hold 文案不再推荐手工绑定。
//  - P03/P04/P01：conversation_read 新面孔（locate/anchor/latest/不透明游标）条目
//    与游标零 seq；正文真实数字/[123] 原样。
//  - P06/P08：words 引语锚点与 episode 范围锚点在同次写调用内解析（不先 read/bind）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleTestTools, makeDb, tempRoot } from '../helpers.ts';
import { renderToolContext, resolveToolGroups } from '../../apps/host/src/runtime/tool-initial-visible.ts';
import { searchToolCatalog } from '../../apps/host/src/runtime/tool-catalog-search.ts';
import { buildDeferredTools, definitionId, freezeWindowTools, modelToolsAfterBindingRetirement, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { memoryHoldDefinition, MEMORYCORRECT_DEFINITION } from '../../apps/host/src/modules/memory/module.ts';
import { ConversationToolsService } from '../../apps/host/src/modules/conversation/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import type { HostToolSpec, ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';

const CTX_BASE = { roomId: 'pkg4-room', windowId: 'w-pkg4', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 99, requestId: 'req-1' } as const;

function noSeqAnywhere(value: unknown): boolean {
  return !JSON.stringify(value).includes('"seq"');
}

test('D01：新窗按用户确认的十四项给简明常驻用法和唯一索引提示', () => {
  const { registry } = assembleTestTools({ db: {} as never, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const declared = registry.currentGroups();
  const noConfig = { prepare: () => ({ get: () => undefined }) } as never;
  const groups = resolveToolGroups(noConfig, catalog, declared);
  const cTools = catalog.filter((spec) => groups[spec.function.name] === 'C').map((spec) => spec.function.name);
  assert.equal(cTools.length, 14);
  assert.ok(cTools.includes('memory_hold') && !cTools.includes('conversation_read'));
  const text = renderToolContext(catalog, groups)!;
  for (const name of cTools) assert.ok(text.includes(`- ${name}\n`));
  assert.doesNotMatch(text, /definition_id: td_|parameters: \{/);
  // 唯一 hook；声明 D 组工具的完整定义不再渲染
  const hooks = text.split('\n').filter((l) => l.includes('用 tool_catalog 的 query'));
  assert.equal(hooks.length, 1, '只有一个共享能力 hook');
  const dNames = catalog.filter((s) => groups[s.function.name] === 'D').map((s) => s.function.name);
  assert.ok(dNames.includes('memory_correct'), '声明 D 仍在 D 组');
  for (const name of dNames) {
    const spec = catalog.find((s) => s.function.name === name)!;
    assert.ok(!text.includes(spec.function.description.slice(0, 15)), `${name}（D 组）完整定义不预载`);
  }
  assert.ok(!text.includes('[tools/deferred'), '旧 deferred 全量渲染段退役');
  assert.ok(hooks[0]!.includes('tool_catalog'), 'hook 指向 catalog 查询');
  // 显式 tools_initial_visible 优先生效（用户设定才是名单正本）
  const explicit = resolveToolGroups({ prepare: () => ({ get: () => ({ value: JSON.stringify(['memory_hold']) }) }) } as never, catalog, declared);
  assert.deepEqual(catalog.filter((s) => explicit[s.function.name] === 'C').map((s) => s.function.name), ['memory_hold'], '显式配置决定 C 名单');
});

test('D02/D03：catalog 查询——预载工具精确名可查；意图一次返回完整定义', () => {
  const { registry } = assembleTestTools({ db: {} as never, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  const exact = searchToolCatalog(catalog, 'memory_recall', groups);
  assert.equal(exact.state, 'match');
  if (exact.state === 'match') {
    assert.equal(exact.results[0]!.name, 'memory_recall', '预载工具也在索引内（D02）');
    assert.ok(exact.results[0]!.parameters && Object.keys(exact.results[0]!.parameters as object).length > 0, '返回完整参数定义（D03）');
    assert.ok(exact.results[0]!.definition_id);
  }
  const intent = searchToolCatalog(catalog, '把这句话保存成原话', groups);
  assert.equal(intent.state, 'match');
  if (intent.state === 'match') assert.equal(intent.results[0]!.name, 'memory_words_write');
});

test('D07：意图区分——正文错字→memory_update；当前对话存档→conversation_archive；不能落入 memory_correct', () => {
  const { registry } = assembleTestTools({ db: {} as never, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  const fix = searchToolCatalog(catalog, '把记忆正文的啤啤改成啾啾', groups);
  assert.equal(fix.state, 'match');
  if (fix.state === 'match') {
    assert.equal(fix.results[0]!.name, 'memory_update', '正文修改命中真实更新入口');
    assert.ok(!fix.results.some((r) => r.name === 'memory_correct'), '纠错工具不冒充正文修改');
  }
  const archive = searchToolCatalog(catalog, '把当前这段对话存档', groups);
  assert.equal(archive.state, 'match');
  if (archive.state === 'match') assert.equal(archive.results[0]!.name, 'conversation_archive');
  const episode = searchToolCatalog(catalog, '只跟踪这件事', groups);
  assert.equal(episode.state, 'match');
  if (episode.state === 'match') assert.ok(episode.results.some((r) => r.name === 'episode_apply'));
});

test('D05/D06：退出能力不回门；无可靠匹配与任务 scope 说明分开', () => {
  const { registry } = assembleTestTools({ db: {} as never, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  const exited = searchToolCatalog(catalog, 'memory_source_bind', groups);
  assert.equal(exited.state, 'no_match');
  if (exited.state === 'no_match') assert.ok(exited.hint.includes('已退出'), '已退出能力给真实退出说明');
  const none = searchToolCatalog(catalog, '给我订一杯咖啡豆颜色的大象', groups);
  assert.equal(none.state, 'no_match');
  if (none.state === 'no_match') assert.ok(none.hint.includes('不代表系统没有该能力'), 'no_match 不冒充系统无能力');
  const task = searchToolCatalog(catalog, 'background_complete', groups);
  assert.equal(task.state, 'match');
  if (task.state === 'match') assert.ok((task.results[0] as { scope_note?: string }).scope_note?.includes('任务'), '任务工具带 scope 说明');
  // tool_catalog wire 定义带 query 参数；tool_invoke 仍无 definition_seen 门
  const wire = buildDeferredTools();
  const catalogSpec = wire.find((t) => t.function.name === 'tool_catalog')!;
  assert.ok((catalogSpec.function.parameters.properties as Record<string, unknown>).query, 'catalog 支持 query');
});

test('source_bind 退出：注册表无此名、invoke 拒、correct 无 binding、hold 不再推荐绑定', async () => {
  const { db, root } = makeDb(tempRoot('pkg4-exit-'), { seed: false });
  const { tools, registry } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  assert.equal(registry.has('memory_source_bind'), false, '注册表退出');
  assert.ok(!registry.currentCatalog().some((s) => s.function.name === 'memory_source_bind'), '目录不出现');
  const out = await tools.execute('memory_source_bind', { memory_id: 'm', start_seq: 1, end_seq: 2 }, { ...CTX_BASE, seenMessages: [], windowId: 'w-no-tools' });
  assert.equal(out.ok, false);
  assert.equal((out.output as { error_code: string }).error_code, 'TOOL_NOT_IN_ALLOWLIST', '记住旧名称不能调用已退出能力');
  const enum_ = (MEMORYCORRECT_DEFINITION.function.parameters.properties as { action: { enum: string[] } }).action.enum;
  assert.ok(!enum_.includes('binding'), 'correct 的 binding action 退出');
  assert.ok(!JSON.stringify(MEMORYCORRECT_DEFINITION.function.parameters).includes('binding_id'), 'binding_id 字段退出');
  const fields = (MEMORYCORRECT_DEFINITION.function.parameters.properties as Record<string, { description?: string }>);
  assert.ok(!fields.word_id?.description?.includes('word_revise'), 'word_revise 残留文案清除');
  const holdDesc = memoryHoldDefinition().function.description;
  assert.ok(!holdDesc.includes('memory_source_bind'), 'hold 不再推荐手工绑定');
  assert.ok(holdDesc.includes('保存成功即完成'), 'hold 成功即完成的语义保留');
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('旧冻结窗仅发现仍能使用的工具与操作，已知有效版本仍可调用', async (t) => {
  const { db, root } = makeDb(tempRoot('pkg4-retire-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES (?, 'estomago', 'private', 'now')").run(CTX_BASE.roomId);
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(CTX_BASE.windowId, CTX_BASE.roomId);
  const calls: string[] = [];
  let savedHold: Record<string, unknown> | null = null;
  const mariposa = new MariposaClient({ transport: async (capability, args) => {
    calls.push(capability);
    if (capability === 'memory.hold') {
      savedHold = args;
      return { ok: true, result: { operation_id: args.operation_id, memory_id: 'mem-old', version: 1, binding_ids: [], committed_at: '2026-11-20T12:30:00Z' } };
    }
    return { ok: true, result: { items: [] } };
  } });
  const { tools, registry } = assembleTestTools({
    db, mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db),
  });
  const historic = JSON.parse(fs.readFileSync(new URL('../fixtures/window-tools-before-autonomy.json', import.meta.url), 'utf8')) as { catalog: HostToolSpec[] };
  const oldCorrect = historic.catalog.find(t => t.function.name === 'memory_correct')!;
  const oldHold = historic.catalog.find(t => t.function.name === 'memory_hold')!;
  const retired: HostToolSpec = { type: 'function', function: {
    name: 'memory_source_bind', description: '给一条已有记忆绑定聊天原文',
    parameters: { type: 'object', properties: {
      memory_id: { type: 'string' }, start_seq: { type: 'integer' }, end_seq: { type: 'integer' },
    }, required: ['memory_id', 'start_seq', 'end_seq'], additionalProperties: false },
  } };
  const catalog = [...registry.currentCatalog().filter(t => !['memory_correct', 'memory_hold'].includes(t.function.name)), oldCorrect, oldHold, retired];
  const wire = freezeWindowTools(db, CTX_BASE.windowId, catalog, 'deferred').map(t => t.function.name === 'tool_catalog'
    ? { ...t, function: { ...t.function, parameters: { type: 'object', properties: {}, additionalProperties: false } } }
    : t);
  db.prepare('UPDATE window_toolsets SET wire_tools_json=? WHERE window_id=?').run(JSON.stringify(wire), CTX_BASE.windowId);
  const context = { ...CTX_BASE, seenMessages: [] };

  const listing = await tools.execute('tool_catalog', {}, context);
  assert.equal(listing.ok, true);
  assert.ok(!(listing.output.tools as Array<{ name: string }>).some(t => t.name === retired.function.name));
  assert.equal((await tools.execute('tool_catalog', { query: 'memory_correct' }, context)).output.error_code, 'TOOL_ARG_UNKNOWN');
  assert.equal((await tools.execute('tool_define', { name: retired.function.name }, context)).output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  assert.equal((await tools.execute('tool_invoke', { name: retired.function.name, definition_id: definitionId(retired), arguments: { memory_id: 'm1', start_seq: 1, end_seq: 2 } }, context)).output.error_code, 'TOOL_NOT_IN_ALLOWLIST');

  const define = await tools.execute('tool_define', { name: 'memory_correct' }, context);
  assert.equal(define.ok, true);
  const props = (define.output.parameters as { properties: { action: { enum: string[] }; binding_id?: unknown } }).properties;
  assert.equal(props.binding_id, undefined);
  assert.ok(!props.action.enum.includes('binding') && props.action.enum.includes('word_add'));
  const denied = await tools.execute('tool_invoke', { name: 'memory_correct', definition_id: definitionId(oldCorrect),
    arguments: { action: 'binding', correction_action: 'remove_wrong_binding', binding_id: 'old-binding' },
  }, context);
  assert.equal(denied.ok, false);
  assert.deepEqual(calls, []);

  for (const definition_id of [definitionId(oldCorrect), define.output.definition_id]) {
    const allowed = await tools.execute('tool_invoke', { name: 'memory_correct', definition_id, arguments: { action: 'corrections' } }, context);
    assert.equal(allowed.ok, true);
  }
  assert.deepEqual(calls, ['relations.corrections.list', 'relations.corrections.list']);

  const hold = await tools.execute('tool_define', { name: 'memory_hold' }, context);
  assert.equal(hold.ok, true);
  assert.ok(!('source_ranges' in (hold.output.parameters as { properties: object }).properties));
  const replay = await tools.execute('tool_invoke', { name: 'memory_hold', definition_id: definitionId(oldHold), arguments: {
    original_title: '合成记录', text: '普通 hold', categories: ['daily'], creation_mode: 'contemporaneous',
    source_ranges: [{ start_seq: 1, end_seq: 2 }],
  } }, context);
  assert.equal(replay.output.memory_id, 'mem-old');
  assert.deepEqual(calls, ['relations.corrections.list', 'relations.corrections.list', 'memory.hold']);
  assert.ok(savedHold && !('source_ranges' in savedHold) && !('source_selections' in savedHold));

  const legacyWire = modelToolsAfterBindingRetirement([oldCorrect, oldHold, retired]);
  assert.deepEqual(legacyWire.map(t => t.function.name), ['memory_correct', 'memory_hold']);
  assert.deepEqual(legacyWire[1]!.function.parameters, hold.output.parameters);
  assert.deepEqual(storedToolset(db, CTX_BASE.windowId)!.catalog, catalog);
});

function conversationFixture(t: TestContext) {
  const { db, root } = makeDb(tempRoot('pkg4-conv-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const svc = new ConversationToolsService({ db, tz: 'Asia/Shanghai' });
  const ctx = { ...CTX_BASE, seenMessages: [] } as ToolExecContext;
  let serial = 0;
  const seed = (content: string, speaker: 'owner' | 'assistant', occurredAt: string): { id: string; sequence: number } => {
    const id = `cm-${serial++}`;
    const seq = serial;
    db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES (?,'estomago','private','2026-01-01T00:00:00Z')").run(ctx.roomId);
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,?,?,?,?,1,?,?)").run(id, ctx.roomId, seq, speaker, 'text', speaker === 'assistant' ? occurredAt : occurredAt, occurredAt);
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'seed')").run(id, content, sha256Hex(content), occurredAt, occurredAt);
    return { id, sequence: seq };
  };
  return { db, svc, ctx, seed };
}

test('P03/P04：locate 按关键词定位返回最小边界候选（不展开全文、零 seq）', (t) => {
  const f = conversationFixture(t);
  f.seed('今天去了海边玩，风很大。', 'owner', '2026-11-10T02:00:00Z');
  f.seed('下次一起去灯塔吧 [123]，26岁生日那次。', 'assistant', '2026-11-10T03:00:00Z');
  f.seed('完全无关的另一段。', 'owner', '2026-11-12T05:00:00Z');
  const out = f.svc.conversationRead({ locate: { text: '灯塔' } }, f.ctx);
  assert.equal(out.ok, true);
  const blob = JSON.stringify(out.output);
  assert.ok(blob.includes('灯塔'), '摘录含命中词');
  assert.ok(!blob.includes('完全无关'), '不展开未命中全文');
  assert.ok((out.output as { candidates: Array<{ excerpt: string }> }).candidates[0]!.excerpt.length <= 40, '摘录有界（少量边界文字，不是整段回读）');
  assert.ok(noSeqAnywhere(out.output), '定位候选零 seq');
  const candidates = (out.output as { candidates: Array<{ cursor: { c: string } }> }).candidates;
  assert.equal(candidates.length, 1);
  assert.ok(typeof candidates[0]!.cursor.c === 'string' && candidates[0]!.cursor.c.length > 0, '游标为不透明 token');
  // 用候选 cursor 续读：能读到那条消息上下文，同样零 seq
  const page = f.svc.conversationRead({ cursor: candidates[0]!.cursor }, f.ctx);
  assert.equal(page.ok, true, JSON.stringify(page.output).slice(0, 200));
  const entries = (page.output as { entries: Array<{ text: string }> }).entries;
  assert.ok(entries.some((e) => e.text.includes('灯塔')), 'cursor 到达命中消息');
  assert.ok(noSeqAnywhere(page.output), '续读条目零 seq');
});

test('P04：同字多处 → 最小边界候选（锚点与 locate 都不静默选第一条）', (t) => {
  const f = conversationFixture(t);
  f.seed('你说晚安，我说好。', 'owner', '2026-11-01T01:00:00Z');
  f.seed('中间别的对话。', 'assistant', '2026-11-02T01:00:00Z');
  f.seed('后来又说了一次晚安。', 'owner', '2026-11-05T01:00:00Z');
  const anchor = f.svc.conversationRead({ anchor: { speaker: '宿主用户', quote: '晚安' } }, f.ctx);
  assert.equal(anchor.ok, true);
  const blob = JSON.stringify(anchor.output);
  assert.ok(blob.includes('candidates') && blob.includes('未唯一定位'), '多处同字给候选');
  const locate = f.svc.conversationRead({ locate: { date: '2026-11-01', text: '晚安' } }, f.ctx);
  assert.equal(locate.ok, true);
  assert.equal((locate.output as { candidates: unknown[] }).candidates.length, 1, '日期+关键词组合收窄');
});

function conversationInvokeFixture(t: TestContext) {
  const { db, root } = makeDb(tempRoot('pkg4-read-scope-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  messages.ensureConversation(CTX_BASE.roomId);
  const { registry, tools } = assembleTestTools({ db, messages });
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')")
    .run(CTX_BASE.windowId, CTX_BASE.roomId);
  freezeWindowTools(db, CTX_BASE.windowId, registry.currentCatalog(), 'deferred', registry.currentGroups());
  let serial = 0;
  const send = (content: string, occurredAt: string) => messages.submitUserMessageWithTurn({
    conversationId: CTX_BASE.roomId, content, occurredAt, clientMessageId: `synthetic-${++serial}`,
  });
  const read = (args: Record<string, unknown>, turnId: string) => tools.execute(
    'tool_invoke', { name: 'conversation_read', arguments: args }, { ...CTX_BASE, turnId, seenMessages: [] },
  );
  return { send, read, messages, db, root };
}

test('P03：指定日期和逐字原话都能定位被四千多条近期消息覆盖的旧原文', async t => {
  const f = conversationInvokeFixture(t);
  f.send('夹在前一天的合成路标。', '2026-10-17T15:59:59Z');
  const original = f.send('凌晨说起一座合成路标。', '2026-10-17T16:00:00Z');
  f.send('带跨日偏移的合成口令。', '2026-10-18T15:59:00+23:59');
  const next = f.send('次日路过了别处。', '2026-10-18T16:00:00Z');
  for (let i = 0; i < 4001; i++) f.send('较新的合成消息。', '2026-11-19T08:00:00Z');

  const byDate = await f.read({ locate: { date: '2026-10-18', text: '合成路标' } }, next.turnId);
  assert.equal(byDate.ok, true);
  const hits = byDate.output.candidates as Array<{ excerpt: string; cursor: unknown }>;
  assert.deepEqual(hits.map(hit => hit.excerpt), ['凌晨说起一座合成路标。']);
  assert.equal(byDate.seenAdditions?.length ?? 0, 0);
  const page = await f.read({ cursor: hits[0]!.cursor }, next.turnId);
  assert.equal((page.output.entries as Array<{ text: string }>)[0]!.text, original.message.revision.content);
  assert.equal(page.seenAdditions?.[0]?.id, original.message.id);

  const byOffsetDate = await f.read({ locate: { date: '2026-10-18', text: '合成口令' } }, next.turnId);
  assert.equal(byOffsetDate.ok, true);
  assert.deepEqual((byOffsetDate.output.candidates as Array<{ excerpt: string }>).map(row => row.excerpt),
    ['带跨日偏移的合成口令。']);

  const byQuote = await f.read({ anchor: { speaker: '宿主用户', quote: '凌晨说起一座合成路标' }, limit: 1 }, next.turnId);
  assert.equal((byQuote.output.entries as Array<{ text: string }>)[0]!.text, original.message.revision.content);
  assert.ok(noSeqAnywhere(byDate.output) && noSeqAnywhere(page.output) && noSeqAnywhere(byQuote.output));
  f.messages.editUserMessage(original.message.id, '编辑后补记一个合成地标。');
  const locatedAfterEdit = await f.read({ locate: { date: '2026-10-18', text: '合成地标' } }, next.turnId);
  assert.deepEqual((locatedAfterEdit.output.candidates as Array<{ excerpt: string }>).map(row => row.excerpt),
    ['编辑后补记一个合成地标。']);
});

test('P04：多候选同一句原话的摘录和续读引用锁住实际命中的旧修订', async t => {
  const f = conversationInvokeFixture(t);
  f.send('甲：提到合成灯塔。', '2026-10-19T01:00:00Z');
  const original = f.send('乙：提到合成灯塔。', '2026-10-20T02:00:00Z');
  f.messages.editUserMessage(original.message.id, '乙：后来换成青山。');
  const hit = await f.read({
    anchor: { speaker: '宿主用户', quote: '合成灯塔', revision: 1 },
  }, original.turnId);
  assert.equal(hit.ok, true);
  const hits = hit.output.candidates as Array<{ excerpt: string; at: string; cursor: unknown }>;
  assert.deepEqual(hits.map(row => row.excerpt), ['乙：提到合成灯塔。', '甲：提到合成灯塔。']);
  assert.match(hits[0]!.at, /10.?20/);
  assert.equal(hit.seenAdditions?.length ?? 0, 0);

  const read = await f.read({ cursor: hits[0]!.cursor, limit: 1 }, original.turnId);
  assert.equal(read.ok, true);
  const [entry] = read.output.entries as Array<{ rev: number; text: string }>;
  assert.equal(entry?.rev, 1);
  assert.equal(entry?.text, '乙：提到合成灯塔。');
  assert.equal(read.seenAdditions?.[0]?.id, original.message.id);
  assert.equal(read.seenAdditions?.[0]?.revision, 1);
  assert.ok(noSeqAnywhere(read.output));
});

test('P04：长候选用条目内的分片游标续读，读完仍可接着看后续消息', async t => {
  const f = conversationInvokeFixture(t);
  const text = '合成候选开头：' + '长'.repeat(6500);
  const long = f.send(text, '2026-10-19T01:00:00Z');
  const next = f.send('合成候选之后的消息。', '2026-10-19T02:00:00Z');
  const hit = await f.read({ locate: { text: '合成候选开头' } }, next.turnId);
  const [candidate] = hit.output.candidates as Array<{ cursor: unknown }>;
  let cursor = candidate?.cursor;
  let readText = '';
  for (let i = 0; i < 3; i++) {
    const page = await f.read({ cursor, limit: 1 }, next.turnId);
    assert.equal(page.ok, true);
    const [entry] = page.output.entries as Array<{ text: string; fragment: { continue_cursor?: unknown } }>;
    assert.equal(page.seenAdditions?.[0]?.id, long.message.id);
    readText += entry!.text;
    cursor = entry!.fragment.continue_cursor ?? page.output.next_cursor;
  }
  assert.equal(readText, text);
  const after = await f.read({ cursor, limit: 1 }, next.turnId);
  assert.equal((after.output.entries as Array<{ text: string }>)[0]?.text, next.message.revision.content);
});

test('P03：命中可信语音转写时续读同一修订的转写，实际读到的部分才记为已读', async t => {
  const f = conversationInvokeFixture(t);
  const media = new MediaService(f.db, path.join(f.root, 'media'), buildConfig({}));
  const asset = await media.saveBuffer({
    bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]),
    purpose: 'chat_voice', operationId: 'synthetic-locate-voice', createdBy: 'qiaosheng', origin: 'upload',
  });
  const hash = (f.db.prepare('SELECT content_sha256 FROM media_assets WHERE id = ?').get(asset.id) as { content_sha256: string }).content_sha256;
  const transcript = '这是一条用于定位的合成语音转写。';
  f.db.prepare(`INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,created_at,updated_at)
    VALUES (?,?,?,?,'ready',?,'now','now')`).run(asset.id, CTX_BASE.roomId, 'synthetic-transcription', hash, transcript);
  const submitted = f.messages.submitUserMessageWithTurn({
    conversationId: CTX_BASE.roomId, content: '', attachments: [{ asset_id: asset.id, presentation: 'voice' }],
    clientMessageId: 'synthetic-locate-voice-message',
  });

  const hit = await f.read({ locate: { text: '用于定位的合成语音' } }, submitted.turnId);
  assert.equal(hit.ok, true);
  const [candidate] = hit.output.candidates as Array<{ cursor: unknown; excerpt: string; voice_transcript: boolean }>;
  assert.equal(candidate?.voice_transcript, true);
  assert.equal(candidate?.excerpt, transcript);
  assert.equal(hit.seenAdditions?.length ?? 0, 0);
  assert.equal(hit.coverageAdditions?.length ?? 0, 0);

  const read = await f.read({ cursor: candidate?.cursor, limit: 1 }, submitted.turnId);
  assert.equal(read.ok, true);
  const [entry] = read.output.entries as Array<{ text: string; voice_transcript: boolean }>;
  assert.equal(entry?.text, transcript);
  assert.equal(entry?.voice_transcript, true);
  assert.equal(read.coverageAdditions?.[0]?.end_char, Array.from(transcript).length);
  assert.equal(read.seenAdditions?.[0]?.id, submitted.message.id);
});

test('P01/P02：anchor/latest 页零 seq；正文真实数字与 [123] 原样', (t) => {
  const f = conversationFixture(t);
  f.seed('报价 3058 号订单，共 12.5 元。', 'owner', '2026-11-10T02:00:00Z');
  f.seed('好的，7点50 提醒你 [123]。', 'assistant', '2026-11-10T03:00:00Z');
  f.seed('2026-11-15 的机票已订。', 'owner', '2026-11-10T04:00:00Z');
  const byAnchor = f.svc.conversationRead({ anchor: { speaker: '宿主用户', quote: '3058 号订单' } }, f.ctx);
  assert.equal(byAnchor.ok, true);
  assert.ok(noSeqAnywhere(byAnchor.output), 'anchor 页零 seq');
  const blobA = JSON.stringify(byAnchor.output);
  assert.ok(blobA.includes('3058') && blobA.includes('12.5'), '真实订单号/价格保留');
  const latest = f.svc.conversationRead({ latest: true }, f.ctx);
  assert.equal(latest.ok, true);
  assert.ok(noSeqAnywhere(latest.output), 'latest 页零 seq');
  const texts = (latest.output as { entries: Array<{ text: string }> }).entries.map((e) => e.text);
  assert.ok(texts.some((x) => x.includes('[123]')), '正文自带的 [123] 原样保留');
  assert.ok(texts.some((x) => x.includes('2026-11-15')), '正文日期原样保留');
});

function wordsEpisodeFixture(t: TestContext) {
  const { db, root } = makeDb(tempRoot('pkg4-words-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
  const transport: MariposaTransport = async (capability, payload) => {
    calls.push({ capability, payload: payload as Record<string, unknown> });
    if (capability === 'memory.get') return { ok: true, result: { version: 3 } } as never;
    if (capability === 'memory.update') return { ok: true, result: { version: 4 } } as never;
    if (capability === 'episode.apply') return { ok: true, result: { episode_id: 'ep-1', revision: 1 } } as never;
    return { ok: false, code: 'X', httpStatus: 404 } as never;
  };
  const mariposa = new MariposaClient({ transport });
  const anchors = new ArchiveService({ db, contentClient: null, contentOps: null, logger: null });
  const svc = new MemoryToolsService({
    db, tz: 'Asia/Shanghai', mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db),
    anchorRange: (roomId, seen, s, e) => anchors.resolveAnchorRange(roomId, seen, s, e),
  });
  const ctx: ToolExecContext = { ...CTX_BASE, seenMessages: [] } as never;
  let serial = 0;
  const seed = (content: string, speaker: 'owner' | 'assistant'): { id: string; sequence: number } => {
    const id = `wm-${serial++}`;
    const seq = serial;
    const occurredAt = `2026-11-1${serial % 9}T0${serial % 9}:00:00Z`;
    db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES (?,'estomago','private','2026-01-01T00:00:00Z')").run(ctx.roomId);
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,?,?,?,?,1,?,?)").run(id, ctx.roomId, seq, speaker, 'text', occurredAt, occurredAt);
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'seed')").run(id, content, sha256Hex(content), occurredAt, occurredAt);
    // 正式来源同步收据（与生产同一 source_sync_receipts 口径）
    db.prepare("INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`rc-${id}`, `op-${id}`, id, 1, 'm-conv-1', `src-${id}`, sha256Hex(content), occurredAt, occurredAt);
    return { id, sequence: seq };
  };
  return { db, svc, ctx, seed, calls, mariposa };
}

test('P06：words 引语锚点在同次写调用内定位——不先 read、逐字核验、M 收到原话与来源', async (t) => {
  const f = wordsEpisodeFixture(t);
  const m1 = f.seed('今天在海边散步，海风特别舒服。', 'owner');
  f.seed('明天记得带伞。', 'assistant');
  (f.ctx as { seenMessages: unknown[] }).seenMessages = [{ id: m1.id, revision: 1 }, { id: 'wm-1', revision: 1 }];
  const out = await f.svc.memoryCorrect({ action: 'word_add', memory_id: 'mem-1', refs: [{ quote: '海风特别舒服', speaker: '宿主用户' }] }, f.ctx);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  const update = f.calls.find((c) => c.capability === 'memory.update')!;
  const words = (update.payload.our_words_add as Array<{ text: string; source_ref: string }>)[0]!;
  assert.equal(words.text, '海风特别舒服', '逐字录入引语本身');
  assert.equal(words.source_ref, 'source_msg:src-wm-0', '来源身份来自同步收据');
  // 转述/未见过 → 拒
  const paraphrase = await f.svc.memoryCorrect({ action: 'word_add', memory_id: 'mem-1', refs: [{ quote: '海边风很舒服' }] }, f.ctx);
  assert.equal(paraphrase.ok, false);
  assert.equal((paraphrase.output as { error_code: string }).error_code, 'QUOTE_ANCHOR_NOT_FOUND', '转述不是原文，不放行');
});

test('P06：同字多处引语 → 边界候选而非静默第一条；重复引用被拒', async (t) => {
  const f = wordsEpisodeFixture(t);
  const m1 = f.seed('我们都说了谢谢。', 'owner');
  const m2 = f.seed('又一次说了谢谢。', 'owner');
  (f.ctx as { seenMessages: unknown[] }).seenMessages = [{ id: m1.id, revision: 1 }, { id: m2.id, revision: 1 }];
  const amb = await f.svc.memoryCorrect({ action: 'word_add', memory_id: 'mem-1', refs: [{ quote: '谢谢' }] }, f.ctx);
  assert.equal(amb.ok, false);
  const out = amb.output as { error_code: string; candidates: unknown[] };
  assert.equal(out.error_code, 'QUOTE_ANCHOR_AMBIGUOUS');
  assert.equal(out.candidates.length, 2, '给足以区分的边界候选');
});

test('P08：episode start 用锚点范围直接取得来源——不先 hold/bind/read，段数如实', async (t) => {
  const f = wordsEpisodeFixture(t);
  const m1 = f.seed('开始整理我们的旅行计划。', 'owner');
  f.seed('第一站去京都。', 'assistant');
  const m3 = f.seed('那就这么定了。', 'owner');
  (f.ctx as { seenMessages: unknown[] }).seenMessages = [
    { id: m1.id, revision: 1 }, { id: 'wm-1', revision: 1 }, { id: m3.id, revision: 1 },
  ];
  const out = await f.svc.episodeApply({
    action: 'start', reason_code: 'tracking_requested', label: '旅行计划',
    anchor_start: { speaker: '宿主用户', quote: '开始整理我们的旅行计划' },
    anchor_end: { speaker: '宿主用户', quote: '那就这么定了' },
  }, f.ctx);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  const call = f.calls.find((c) => c.capability === 'episode.apply')!;
  const selections = call.payload.source_selections as Array<{ conversation_id: string; members: Array<{ source_message_id: string }> }>;
  assert.equal(selections.length, 1);
  assert.equal(selections[0]!.conversation_id, 'm-conv-1');
  assert.deepEqual(selections[0]!.members.map((m) => m.source_message_id), ['src-wm-0', 'src-wm-1', 'src-wm-2'], '起止之间完整成员按序进入');
  assert.equal((out.output as { anchor_range_summary?: { segments: number } }).anchor_range_summary?.segments, 1);
  // 半锚点拒绝
  const half = await f.svc.episodeApply({ action: 'start', reason_code: 'tracking_requested', label: 'x', anchor_start: { speaker: '宿主用户', quote: '开始整理' } }, f.ctx);
  assert.equal((half.output as { error_code: string }).error_code, 'EPISODE_ANCHOR_PAIR_REQUIRED');
  // 锚点与既有 ref 表达互斥
  const conflict = await f.svc.episodeApply({
    action: 'start', reason_code: 'tracking_requested', label: 'x',
    anchor_start: { speaker: '宿主用户', quote: '开始整理我们的旅行计划' }, anchor_end: { speaker: '宿主用户', quote: '那就这么定了' },
    source_selections: [{ conversation_id: 'c', members: [] }],
  }, f.ctx);
  assert.equal((conflict.output as { error_code: string }).error_code, 'EPISODE_ANCHOR_CONFLICT');
});

test('P08：关闭与纠正至结束的单点锚点按 M 来源引用合同传递', async (t) => {
  const f = wordsEpisodeFixture(t);
  const content = '✈️旅行计划完成了，机票都订好了。';
  const m1 = f.seed(content, 'owner');
  (f.ctx as { seenMessages: unknown[] }).seenMessages = [{ id: m1.id, revision: 1 }];
  const source = { source_message_id: 'src-wm-0', content_hash: sha256Hex(content) };
  const actions = [
    { action: 'close', reason_code: 'goal_resolved' },
    { action: 'correct', reason_code: 'boundary_error', corrected_state: 'CLOSED', note: '修正已确认的结束依据' },
  ];
  for (const action of actions) {
    const out = await f.svc.episodeApply({
      ...action, episode_id: 'ep-1', expected_revision: 2,
      terminal_anchor: { speaker: '宿主用户', quote: '机票都订好了' },
      decision_anchors: [{ speaker: '宿主用户', quote: '旅行计划完成了' }],
    }, f.ctx);
    assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
    const call = f.calls.at(-1)!;
    assert.equal(call.capability, 'episode.apply');
    assert.deepEqual(call.payload.terminal_source_ref, { ...source, char_offset: Array.from(content).length - 1 });
    assert.deepEqual(call.payload.decision_source_refs, [{ ...source, char_offset: 2 }]);
  }
});

test('新窗替换原话只接收一条引语，合法调用送出单条修订', async (t) => {
  const f = wordsEpisodeFixture(t);
  const msg = f.seed('第一句和第二句。', 'owner');
  const { tools, registry } = assembleTestTools({
    db: f.db, mariposa: f.mariposa, reviews: new RotationReviewService(f.db), checkpoint: new HoldCheckpointService(f.db),
  });
  f.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(f.ctx.windowId, f.ctx.roomId);
  freezeWindowTools(f.db, f.ctx.windowId, registry.currentCatalog(), 'deferred', registry.currentGroups());
  const context = { ...f.ctx, seenMessages: [{ id: msg.id, revision: 1 }] };
  const params = { action: 'revise', memory_id: 'mem-1', word_id: 'word-1' };
  const name = 'memory_words_write';
  const rejected = await tools.execute('tool_invoke', { name, arguments: {
    ...params, refs: [{ quote: '第一句' }, { quote: '第二句' }],
  } }, context);
  assert.equal(rejected.output.error_code, 'TOOL_ARG_LENGTH');
  assert.deepEqual(f.calls, []);

  const accepted = await tools.execute('tool_invoke', { name, arguments: {
    ...params, refs: [{ quote: '第二句' }],
  } }, context);
  assert.equal(accepted.ok, true);
  assert.deepEqual(f.calls.find(c => c.capability === 'memory.update')?.payload.our_words_revise,
    [{ word_id: 'word-1', text: '第二句', source_ref: 'source_msg:src-wm-0' }]);
});
