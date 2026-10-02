// F11 二轮回归：完整包重放身份。同一传输包（相同 uuid/内容）重投必须幂等；
// 不同 uuid 的相同文字必须分别发布；同 uuid 不同载荷判冲突且不发布正文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import type { AgentRunner } from '../../apps/host/src/runtime/runner.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const rawPacket = (uuid: string, texts: string[]) => ({
  type: 'assistant' as const,
  uuid,
  message: { id: 'msg_1', content: texts.map((t, i) => ({ type: 'text' as const, text: t, block_index_hint: i })) },
  session_id: 's1',
});

test('normalizer：同 uuid 同载荷重投（1 次与 10 次）只产出一次 complete_message', () => {
  const n = new SdkEventNormalizer();
  const packet = rawPacket('uuid-A', ['正文一']);
  const first = n.normalize(packet);
  assert.equal(first.filter((e) => e.kind === 'complete_message').length, 1);
  for (let i = 0; i < 10; i++) {
    const replay = n.normalize(JSON.parse(JSON.stringify(packet)));
    assert.equal(replay.filter((e) => e.kind === 'complete_message').length, 0, `第 ${i + 1} 次重投不得再产出 complete_message`);
    assert.equal(replay.filter((e) => e.kind === 'packet_conflict').length, 0);
  }
});

test('normalizer：同 uuid 不同载荷 → packet_conflict，不产出 complete_message', () => {
  const n = new SdkEventNormalizer();
  n.normalize(rawPacket('uuid-B', ['原始正文']));
  const conflict = n.normalize(rawPacket('uuid-B', ['被篡改的正文']));
  assert.equal(conflict.filter((e) => e.kind === 'complete_message').length, 0);
  assert.equal(conflict.filter((e) => e.kind === 'packet_conflict').length, 1);
});

test('normalizer：不同 uuid 相同文字 → 各自产出（不按内容误判重复）', () => {
  const n = new SdkEventNormalizer();
  const a = n.normalize(rawPacket('uuid-C', ['一模一样的文字']));
  const b = n.normalize(rawPacket('uuid-D', ['一模一样的文字']));
  assert.equal(a.filter((e) => e.kind === 'complete_message').length, 1);
  assert.equal(b.filter((e) => e.kind === 'complete_message').length, 1);
});

test('normalizer：无 uuid 时相同内容重投视为重放；内容不同则新包', () => {
  const n = new SdkEventNormalizer();
  const p = { type: 'assistant' as const, message: { id: 'msg_2', content: [{ type: 'text' as const, text: '无标识包' }] }, session_id: 's1' };
  assert.equal(n.normalize(p).filter((e) => e.kind === 'complete_message').length, 1);
  assert.equal(n.normalize(JSON.parse(JSON.stringify(p))).filter((e) => e.kind === 'complete_message').length, 0, '无 uuid 同内容重投=重放');
  const p2 = { type: 'assistant' as const, message: { id: 'msg_2', content: [{ type: 'text' as const, text: '无标识包·新内容' }] }, session_id: 's1' };
  assert.equal(n.normalize(p2).filter((e) => e.kind === 'complete_message').length, 1);
});

// —— 宿主持久化链：MockRunner 重投，正式消息只落一条 ——
function compose(root: string, runner: AgentRunner) {
  writeApprovedIdentity(root);
  const config = buildConfig(readyRuntimePatch());
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing: new RoutingService(db, events, messages), windows, logger });
  messages.ensureConversation('c1');
  return { db, messages, supervisor };
}

test('supervisor 链路：同 uuid 完整包重投 3 次 → 正式消息恰好 1 条；delta+完整块+重投也只 1 条', async () => {
  const replayRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      const send = () => req.onEvent({ kind: 'complete_message', sdk_message_id: 'msg_1', session_id: 's1', channel: 'main',
        matched: [], unmatched: [{ seq: -1, block_type: 'text', text: '唯一正文。', reason: 'no_open_block' }], packet_uuid: 'uuid-R1' });
      send(); send(); send();
      return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's1', requestId: null };
    },
  };
  const root = tempRoot('replay-uuid-');
  const ctx = compose(root, replayRunner);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '重投', clientMessageId: 'rp1' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const rows = ctx.db.prepare("SELECT m.id FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.conversation_id='c1' AND m.speaker='assistant'").all() as Array<{ id: string }>;
  assert.equal(rows.length, 1, '同 uuid 重投 3 次必须只落 1 条正式消息');
  ctx.db.close();
});

test('supervisor 链路：delta+完整块+同 uuid 重投 → 只 1 条；不同 uuid 同文字 → 2 条', async () => {
  const mixedRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      req.onEvent({ kind: 'message_start', sdk_message_id: 'msg_2', model: 'm', session_id: 's1', channel: 'main' });
      req.onEvent({ kind: 'content_block_start', sdk_message_id: 'msg_2', block_index: 0, block_type: 'text', channel: 'main' });
      req.onEvent({ kind: 'text_delta', sdk_message_id: 'msg_2', block_index: 0, text: '流式正文。', channel: 'main' });
      const send = () => req.onEvent({ kind: 'complete_message', sdk_message_id: 'msg_2', session_id: 's1', channel: 'main',
        matched: [{ block_index: 0, block_type: 'text', text: '流式正文。', tool_id: null, tool_name: null }], unmatched: [], packet_uuid: 'uuid-M1' });
      send(); send();
      // 不同 uuid 的同文字包：必须分别发布
      req.onEvent({ kind: 'complete_message', sdk_message_id: 'msg_3', session_id: 's1', channel: 'main',
        matched: [], unmatched: [{ seq: -1, block_type: 'text', text: '流式正文。', reason: 'no_open_block' }], packet_uuid: 'uuid-M2' });
      return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's1', requestId: null };
    },
  };
  const root = tempRoot('replay-mixed-');
  const ctx = compose(root, mixedRunner);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '混合', clientMessageId: 'rp2' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const bodies = ctx.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.conversation_id='c1' AND m.speaker='assistant'").all() as Array<{ content: string }>;
  const occurrences = bodies.map((b) => b.content).join('\u0000').split('流式正文。').length - 1;
  assert.equal(occurrences, 2, `同包重投只 1 次 + 不同 uuid 1 次 = 恰好 2 处（实际 ${occurrences}）`);
  ctx.db.close();
});
