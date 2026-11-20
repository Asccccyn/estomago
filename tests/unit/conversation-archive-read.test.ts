import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ContentServer } from '../../apps/content/src/service.ts';
import { CapabilityRegistry } from '../../apps/host/src/capabilities/registry.ts';
import { ModelToolBridge } from '../../apps/host/src/capabilities/model-bridge.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { registerArchivesCapabilities } from '../../apps/host/src/modules/archives/module.ts';
import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';
import { registerConversationCapabilities } from '../../apps/host/src/modules/conversation/module.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { makeDb, tempRoot } from '../helpers.ts';

test('按 archive_id 读实发固定版本：搜索、分页、缺失与可见覆盖经过真实桥', async t => {
  const { root, db } = makeDb(tempRoot('archive-tool-read-'), { seed: false });
  const token = 'synthetic-content-token';
  const baseUrl = 'http://fixture.content';
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0, token });
  t.after(async () => {
    await content.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const contentHandler = (content as unknown as { handle(req: IncomingMessage, res: ServerResponse): Promise<void> });
  const actors: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, baseUrl);
    const headers = Object.fromEntries(new Headers(init.headers));
    if (init.method === 'GET' && /^\/api\/v1\/content\/archives\/[^/]+$/.test(url.pathname)) actors.push(headers['x-actor']!);
    // Keep the real HTTP handler and internal authentication. Only socket transport
    // is substituted, so this test also runs where loopback listen is unavailable.
    const request = Object.assign(Readable.from(init.body ? [Buffer.from(String(init.body))] : []), {
      url: url.pathname + url.search, method: init.method ?? 'GET', headers,
    }) as unknown as IncomingMessage;
    let status: number | undefined;
    let body: string | undefined;
    const response = {
      writeHead(code: number) { status = code; },
      end(text: string) { body = text; },
    } as unknown as ServerResponse;
    await contentHandler.handle(request, response);
    return new Response(body, { status });
  });

  const messages = new MessageService(db);
  messages.ensureConversation('home');
  messages.ensureConversation('other');
  const publish = (conversationId: string, text: string, key: string) =>
    messages.submitUserMessageWithTurn({ conversationId, content: text, clientMessageId: key });
  const start = publish('home', '这是存档保存时的正文。', 'first');
  publish('home', '没有选入存档的普通消息。', 'not-archived');
  const missing = publish('home', '随后失去固定版的正文。', 'missing');
  const removed = publish('home', '本地已无此消息。', 'removed');
  const end = publish('home', '这是同一个存档的最后一句。', 'end');
  const other = publish('other', '来自其他会话的新消息。', 'other');
  const versionTime = new Date().toISOString();
  const archived = [
    [start.message.id, 'sm_archive_start', '这是存档保存时的正文。'],
    [missing.message.id, 'sm_archive_missing', '随后失去固定版的正文。'],
    [removed.message.id, 'sm_archive_removed', '本地已无此消息。'],
    [end.message.id, 'sm_archive_end', '这是同一个存档的最后一句。'],
  ] as const;
  for (const [id, source, text] of archived) {
    db.prepare(`INSERT INTO source_sync_receipts
      (id,operation_id,origin_message_id,revision,source_conversation_id,source_message_id,content_hash,committed_at,created_at)
      VALUES (?,?,?,1,?,?,?,?,?)`)
      .run('rc-' + source, 'op-' + source, id, 'm-home', source, sha256Hex(text), versionTime, versionTime);
  }

  const contentClient = { baseUrl, token };
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const logger = new Logger(null);
  const archives = new ArchiveService({
    db, contentClient, logger, contentOps: new ContentOperationCoordinator({ db, client: contentClient, media, logger }),
  });
  const written = await archives.createArchive({
    conversationId: 'home', kind: 'sweet', rawRefs: archived.map(([message_id]) => ({ message_id })),
    actor: 'qiaosheng', idempotencyKey: 'synthetic-archive-save',
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  messages.editUserMessage(start.message.id, '现在聊天中的新版正文。');
  messages.editUserMessage(missing.message.id, '已无固定版本的新正文。');
  db.prepare('DELETE FROM message_revisions WHERE message_id=? AND revision=1').run(missing.message.id);
  db.prepare('DELETE FROM message_revisions WHERE message_id=?').run(removed.message.id);
  db.prepare('DELETE FROM messages WHERE id=?').run(removed.message.id);

  const mariposa = new MariposaClient({ transport: async (name, payload) => {
    assert.equal(name, 'source.search');
    assert.ok((payload.include_ids as string[]).includes('sm_archive_start'));
    return { ok: true, result: { hits: [{ message_id: 'sm_archive_start', excerpt: '保存时的正文' }] } };
  } });
  const registry = new CapabilityRegistry();
  registerArchivesCapabilities(registry, { archives, mariposa });
  registerConversationCapabilities(registry, { db, archives });
  const bridge = new ModelToolBridge({ db });
  bridge.setCapabilityRegistry(registry);
  const setup = (roomId: string, windowId: string, turnId: string) => {
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')")
      .run(windowId, roomId);
    freezeWindowTools(db, windowId, registry.currentCatalog(), 'deferred', registry.currentGroups());
    return { roomId, windowId, turnId, purpose: 'chat' as const, activeReviewId: null,
      requestId: 'req-' + windowId, seenSequence: 0, seenMessages: [] };
  };
  const ctx = setup('home', 'w-home', end.turnId);
  const outside = setup('other', 'w-other', other.turnId);

  const found = await bridge.execute('tool_invoke', { name: 'archives_search', arguments: { query: '保存时' } }, ctx);
  assert.equal(found.ok, true);
  const [{ archive_id }] = found.output.items as Array<{ archive_id: string }>;
  assert.equal(archive_id, written.archive.id);
  assert.equal(found.coverageAdditions, undefined, '搜索候选不标原文已读');
  assert.equal(found.seenAdditions, undefined);

  const read = (arguments_: Record<string, unknown>, scope = ctx) =>
    bridge.execute('tool_invoke', { name: 'conversation_read', arguments: arguments_ }, scope);
  const firstPage = await read({ archive_id, limit: 1 });
  assert.equal(firstPage.ok, true);
  assert.deepEqual((firstPage.output.entries as Array<{ text: string }>).map(e => e.text), ['这是存档保存时的正文。']);
  assert.equal((firstPage.output.entries as Array<{ rev: number }>)[0]!.rev, 1);
  assert.ok(!('seq' in (firstPage.output.entries as Record<string, unknown>[])[0]!));
  assert.deepEqual(firstPage.seenAdditions, [{ id: start.message.id, revision: 1 }]);
  assert.deepEqual(firstPage.coverageAdditions?.map(r => r.resource_ref), ['source_msg:sm_archive_start']);

  const pending = firstPage.coverageProjection!(firstPage.coverageAdditions!);
  assert.equal((pending.output.entries as Array<{ included_in_this_request: boolean }>)[0]!.included_in_this_request, true);
  assert.deepEqual(pending.seenAdditions, []);
  assert.deepEqual(pending.coverageAdditions, []);

  const pageTwo = await read({ cursor: firstPage.output.next_cursor, limit: 1 });
  assert.equal(pageTwo.ok, true);
  assert.equal(pageTwo.output.missing_archived_revisions, 2, '缺固定修订与缺本地消息均如实报告');
  assert.deepEqual((pageTwo.output.entries as Array<{ text: string }>).map(e => e.text), ['这是同一个存档的最后一句。']);
  assert.deepEqual(pageTwo.seenAdditions, [{ id: end.message.id, revision: 1 }]);
  assert.deepEqual(pageTwo.coverageAdditions?.map(r => r.resource_ref), ['source_msg:sm_archive_end']);
  assert.equal(pageTwo.output.next_cursor, undefined);

  const rejected = await read({ archive_id }, outside);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.output.error_code, 'ARCHIVE_CONVERSATION_MISMATCH');
  assert.equal(rejected.coverageAdditions, undefined);
  assert.equal(rejected.seenAdditions, undefined);
  assert.deepEqual(actors, ['jiaming', 'jiaming', 'jiaming']);
});
