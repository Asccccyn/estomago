import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, type TestContext } from 'node:test';
import type { HostToolSpec, ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import { assembleTestTools, makeDb } from '../helpers.ts';

const unicodeEscape = String.fromCharCode(92) + 'u4e2d';
const holdArgs = { original_title: '合成', categories: ['daily'], text: '中："引号"\n第二行', creation_mode: 'contemporaneous' };
const planArgs = { action: 'create', title: '中文计划', content: '合成计划内容' };

function fixture(t: TestContext, protocol: 'deferred' | 'legacy' = 'deferred') {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const { turnId, message } = messages.submitUserMessageWithTurn({
    conversationId: 'c1', content: '合成输入', clientMessageId: 'han-input',
  });
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('w1','c1','ACTIVE','now','now')").run();
  const frozen = JSON.parse(fs.readFileSync(new URL('../fixtures/window-tools-before-autonomy.json', import.meta.url), 'utf8')) as {
    catalog: HostToolSpec[];
  };
  freezeWindowTools(db, 'w1', frozen.catalog, protocol);

  const calls: { capability: string; payload: Record<string, unknown> }[] = [];
  const mariposa = new MariposaClient({ transport: async (capability, payload) => {
    calls.push({ capability, payload });
    if (capability === 'memory.hold') {
      return { ok: true, result: {
        operation_id: payload.operation_id, memory_id: 'm1', version: 1, binding_ids: [], committed_at: '2026-11-19T00:00:00Z',
      } };
    }
    assert.equal(capability, 'plan.create');
    return { ok: true, result: { plan_id: 'p1', version: 1, state: 'planned' } };
  } });
  const { tools } = assembleTestTools({ db, mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const ctx: ToolExecContext = {
    roomId: 'c1', windowId: 'w1', turnId, purpose: 'chat', activeReviewId: null,
    seenSequence: message.sequence, seenMessages: [], requestId: 'req-han',
  };
  let callNumber = 0;
  const invoke = (name: string, source: string, exposeSource = true) => tools.execute(name, JSON.parse(source), {
    ...ctx, toolCallId: 'han-' + ++callNumber, ...(exposeSource ? { argumentSource: source } : {}),
  });
  const effects = () => (db.prepare('SELECT count(*) AS n FROM tool_side_effects').get() as { n: number }).n;
  const snapshot = () => db.prepare('SELECT wire_tools_json,catalog_json FROM window_toolsets WHERE window_id=?').get('w1');
  return { calls, invoke, effects, snapshot };
}

function wrapped(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, arguments: args });
}

test('冻结 MCP 记忆入口按原始拼写区分中文和转义，拒绝时没有写入', async t => {
  const f = fixture(t);
  const snapshot = f.snapshot();
  const source = wrapped('memory_hold', holdArgs);
  const rejected = await f.invoke('tool_invoke', source.replace('中', unicodeEscape));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.output.error_code, 'TOOL_ARG_LITERAL_HAN_REQUIRED');
  assert.equal(rejected.output.field, 'text');
  assert.equal(rejected.output.retryable, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.effects(), 0);

  const saved = await f.invoke('tool_invoke', source);
  assert.equal(saved.ok, true, JSON.stringify(saved.output));
  assert.equal(saved.output.version, 1);
  assert.equal(f.calls[0]?.capability, 'memory.hold');
  assert.equal(f.calls[0]?.payload.text, holdArgs.text);
  assert.equal(f.effects(), 1);
  assert.deepEqual(f.snapshot(), snapshot);
});

test('冻结计划工具同样校验转义，旧直调保留原始中文和已有写入路由', async t => {
  const f = fixture(t, 'legacy');
  const source = JSON.stringify(planArgs);
  const rejected = await f.invoke('plans_write', source.replace('中', unicodeEscape));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.output.error_code, 'TOOL_ARG_LITERAL_HAN_REQUIRED');
  assert.equal(rejected.output.field, 'title');
  assert.equal(rejected.output.retryable, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.effects(), 0);

  const saved = await f.invoke('plans_write', source);
  assert.equal(saved.ok, true, JSON.stringify(saved.output));
  assert.equal(f.calls[0]?.capability, 'plan.create');
  assert.equal(f.calls[0]?.payload.title, planArgs.title);
  assert.equal(f.calls[0]?.payload.content, planArgs.content);
});

test('没有原始输入时不猜测，正文中的字面反斜杠原样保存', async t => {
  const f = fixture(t);
  const source = wrapped('memory_hold', holdArgs).replace('中', unicodeEscape);
  const unavailable = await f.invoke('tool_invoke', source, false);
  assert.equal(unavailable.ok, true, JSON.stringify(unavailable.output));
  assert.equal(f.calls[0]?.payload.text, holdArgs.text);

  const literal = { ...holdArgs, text: '字面反斜杠 ' + unicodeEscape };
  const saved = await f.invoke('tool_invoke', wrapped('memory_hold', literal));
  assert.equal(saved.ok, true, JSON.stringify(saved.output));
  assert.equal(f.calls[1]?.payload.text, literal.text);
});

test('旧调用把整个参数序列化成字符串时仍区分正文文字和内层转义', async t => {
  const f = fixture(t);
  const inner = JSON.stringify(holdArgs);
  const call = (argumentsText: string) => f.invoke('tool_invoke', JSON.stringify({ name: 'memory_hold', arguments: argumentsText }));
  const rejected = await call(inner.replace('中', unicodeEscape));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.output.error_code, 'TOOL_ARG_LITERAL_HAN_REQUIRED');
  assert.equal(rejected.output.field, 'text');
  assert.equal(f.calls.length, 0);
  assert.equal(f.effects(), 0);

  const literal = { ...holdArgs, text: '保留字面 ' + unicodeEscape };
  const saved = await call(JSON.stringify(literal));
  assert.equal(saved.ok, true, JSON.stringify(saved.output));
  assert.equal(f.calls[0]?.payload.text, literal.text);
});
