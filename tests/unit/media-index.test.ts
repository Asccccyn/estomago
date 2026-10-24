import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MediaEmbedWorkerClient, MediaIndexService } from '../../apps/host/src/media/index/service.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

// JOINT-VOICE-20261022（07）P4：图片语义索引合同（fake worker 离线）。
// M01 候选可权限过滤/no_match；M02 namespace 不混库；M05 worker 只编码。
// fake 相似度规则：one-hot(len % 768)——同字节长度=相似度 1，不同=0（确定性可控）。
// 真实 EmbeddingGemma 2 效果 = NOT_EXECUTED。

const FINGERPRINT = 'fake|test|dims=768|norm=l2';

// fake 相似度映射：文本含"猫"→slot1、"狗"→slot2、其他→正交槽；图片首填充字节 1/2→slot1/2
function slotOf(modality: string, raw: Buffer): number {
  if (modality === 'text') {
    const s = raw.toString('utf8');
    if (s.includes('猫')) return 1;
    if (s.includes('狗')) return 2;
    return (s.length % 100) + 10;
  }
  return raw[8] === 1 ? 1 : raw[8] === 2 ? 2 : 3;
}

function startFakeWorker(): Promise<{ server: http.Server; url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, backend: 'fake', fingerprint: FINGERPRINT }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/embed') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { items } = JSON.parse(body) as { items: Array<{ id: string; modality: string; data_b64: string }> };
        const vectors = items.map((it) => {
          const raw = Buffer.from(it.data_b64, 'base64');
          const v = new Float32Array(768);
          v[slotOf(it.modality, raw)] = 1; // 确定性相似度：text 关键词 ↔ image 填充字节配对
          return { id: it.id, vector_b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64'), dims: 768 };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vectors, fingerprint: FINGERPRINT }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

function fixture(workerUrl: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-midx-test-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig(workerUrl ? { media_embedding: { base_url: workerUrl } } : {});
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  messages.ensureConversation('other');
  const worker = workerUrl ? new MediaEmbedWorkerClient({ base_url: workerUrl }) : null;
  const index = new MediaIndexService(db, media, worker);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media, messages, mediaIndex: workerUrl ? index : null });
  const png = (n: number, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, fill)]);
  const uploadImage = (n: number, fill = 1) => media.saveBuffer({ bytes: png(n, fill), purpose: 'chat_image', operationId: `img-${n}-${fill}`, createdBy: 'qiaosheng', origin: 'upload' });
  const publish = (conversationId: string, assetId: string, cmid: string) =>
    messages.publishAssistantMessage({ conversationId, turnId: 't1', content: '', kind: 'text', clientMessageId: cmid, attachments: [{ asset_id: assetId, presentation: 'image' }] });
  // R8′（2026-10-23）：mediaSearch 不再前台补索引——测试先经后台同一路径预索引
  const preIndex = async (...assetIds: string[]) => { for (const id of assetIds) await index.indexImage(id); };
  return { root, db, config, media, messages, index, tools, uploadImage, publish, preIndex, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ctxBase = { roomId: 'primary', windowId: 'w1', turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r1' };

test('M01: 中文找图——同会话候选可返回、无关查询 no_match、跨会话不出现', async () => {
  const w = await startFakeWorker();
  const f = fixture(w.url);
  try {
    const a1 = await f.uploadImage(100, 1); // 猫图（fill 1 → slot1）
    const a2 = await f.uploadImage(200, 2); // 狗图（fill 2 → slot2）
    f.publish('primary', a1.id, 'm1');
    f.publish('other', a2.id, 'm2'); // 另一会话的狗图：权限门外
    await f.preIndex(a1.id); // 只索引本会话图（另一会话图保持未索引，权限门外）
    const r = await f.tools.execute('media_search', { query: '找那张猫猫的图' }, ctxBase);
    assert.equal(r.ok, true, JSON.stringify(r.output));
    assert.equal(r.output['state'], 'candidates');
    const items = r.output['items'] as Array<{ asset_ref: string }>;
    assert.equal(items.length, 1);
    assert.equal(items[0].asset_ref, `est:${a1.id}`);
    // 无关查询（不落任何图槽位）→ no_match 如实返回
    const r2 = await f.tools.execute('media_search', { query: '今天天气怎么样' }, ctxBase);
    assert.equal(r2.ok, true);
    assert.equal(r2.output['state'], 'no_match');
    assert.deepEqual(r2.output['items'], []);
  } finally { w.close(); f.close(); }
});

test('删除失效：资产非 ready 立即从候选消失（读路径权限门，不等清理）', async () => {
  const w = await startFakeWorker();
  const f = fixture(w.url);
  try {
    const a1 = await f.uploadImage(100, 1);
    f.publish('primary', a1.id, 'm1');
    await f.preIndex(a1.id);
    const r0 = await f.tools.execute('media_search', { query: '猫猫' }, ctxBase);
    assert.equal(r0.output['state'], 'candidates');
    f.db.prepare("UPDATE media_assets SET state = 'missing' WHERE id = ?").run(a1.id);
    const r1 = await f.tools.execute('media_search', { query: '猫猫' }, ctxBase);
    assert.equal(r1.output['state'], 'no_match', '删除后读取立即阻断');
    assert.equal(f.index.purgeOrphans(), 1, '孤儿清理可重试收走');
  } finally { w.close(); f.close(); }
});

test('M02: namespace 不混库——异指纹索引行不参与查询', async () => {
  const w = await startFakeWorker();
  const f = fixture(w.url);
  try {
    const a1 = await f.uploadImage(100, 1);
    f.publish('primary', a1.id, 'm1');
    // 手工塞一条异 namespace 行（模拟旧版本向量残留）
    const vec = Buffer.from(new Float32Array(768).buffer as ArrayBuffer);
    f.db.prepare("INSERT INTO media_embedding_index (asset_id, modality, namespace, vector, content_sha256, created_at) VALUES (?, 'image', 'old_namespace_v0', ?, 'x', datetime('now'))").run(a1.id, vec);
    await f.preIndex(a1.id); // R8′：预索引走当前 namespace（检索不再前台补）
    const r = await f.tools.execute('media_search', { query: '猫猫' }, ctxBase);
    const items = r.output['items'] as Array<{ asset_ref: string }>;
    assert.ok(items.length >= 1); // 命中来自当前 namespace 的真索引
    assert.ok(items.every((it) => it.asset_ref === `est:${a1.id}`));
    // 异 namespace 行即使向量匹配也不会单独产生第二个重复候选
    assert.equal(items.filter((it) => it.asset_ref === `est:${a1.id}`).length, 1);
  } finally { w.close(); f.close(); }
});

test('M05/J: worker 关停 → 检索能力如实 unavailable（聊天不受影响）；恢复后自动补索引', async () => {
  const w = await startFakeWorker();
  const f = fixture(w.url);
  const a1 = await f.uploadImage(100, 1);
  f.publish('primary', a1.id, 'm1');
  await new Promise<void>((done) => w.server.close(() => done()));
  const r = await f.tools.execute('media_search', { query: '猫猫' }, ctxBase);
  assert.equal(r.ok, false);
  assert.equal(r.output['error_code'], 'MEDIA_WORKER_UNAVAILABLE');
  assert.match(String(r.output['detail']), /文字聊天不受影响/);
  f.close();
});

test('worker 未配置 → 工具如实 INTEGRATION_UNCONFIGURED；未配置时零行为变化', async () => {
  const f = fixture(null);
  try {
    const r = await f.tools.execute('media_search', { query: '猫' }, ctxBase);
    assert.equal(r.ok, false);
    assert.equal(r.output['error_code'], 'INTEGRATION_UNCONFIGURED');
    const cfg = buildConfig({});
    assert.equal(cfg.media_embedding.base_url, null, '默认未配置');
  } finally { f.close(); }
});

test('预算：media_candidates 投影 ≤4096 字节（10 条上限）', async () => {
  const w = await startFakeWorker();
  const f = fixture(w.url);
  try {
    // 造 10 张猫图（全部命中）——limit 10
    for (let i = 0; i < 10; i++) {
      const a = await f.uploadImage(100 + i, 1);
      f.publish('primary', a.id, `m${i}`);
    }
    await f.preIndex(...(f.db.prepare("SELECT asset_id FROM message_attachments").all() as Array<{ asset_id: string }>).map((x) => x.asset_id));
    const r = await f.tools.execute('media_search', { query: '猫猫', limit: 10 }, ctxBase);
    const items = r.output['items'] as unknown[];
    assert.equal(items.length, 10);
    const bytes = Buffer.byteLength(JSON.stringify({ state: r.output['state'], items }), 'utf8');
    assert.ok(bytes <= 4096, `投影 ${bytes}B 超预算`);
  } finally { w.close(); f.close(); }
});
