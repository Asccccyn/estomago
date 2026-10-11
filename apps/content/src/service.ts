// ESTOMAGO_CHAT_EXEC_V1 §06（WP5）：可选内容后端 apps/content——独立进程、独立 SQLite、
// 仅 loopback、内部服务凭据 + 宿主派生 actor（qiaosheng/jiaming 双人集合）。
// 朋友圈（post/letter 同一数据模型）+ 评论 + 三类相册归档 + 纪念作品 + 未来留言正文。
// 不拥有：桶/计划/星星正本（稳定引用）、媒体字节（asset_id 引用）、投递调度（est 调度器）。
// est 只经 HTTP 薄代理访问本服务（浏览器不得直连；body 无任何作者字段——作者只来自可信头）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const ACTORS = ['qiaosheng', 'jiaming'] as const;
export type Actor = (typeof ACTORS)[number];
export const CONTENT_SCHEMA_VERSION = 1;

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

export class ContentError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

type Db = DatabaseSync;

function openDb(stateRoot: string): Db {
  fs.mkdirSync(stateRoot, { recursive: true });
  const db = new DatabaseSync(path.join(stateRoot, 'content.sqlite3'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`CREATE TABLE IF NOT EXISTS content_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const have = (db.prepare('SELECT version FROM content_schema_migrations').all() as Array<{ version: number }>).map((r) => r.version);
  if (!have.includes(1)) {
    db.exec(`
CREATE TABLE feed_posts(
  id TEXT PRIMARY KEY,
  author_actor TEXT NOT NULL CHECK (author_actor IN ('qiaosheng','jiaming')),
  presentation TEXT NOT NULL CHECK (presentation IN ('post','letter')),
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX idx_feed_posts_order ON feed_posts(published_at DESC, id DESC);
CREATE TABLE feed_post_assets(
  post_id TEXT NOT NULL REFERENCES feed_posts(id),
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  alt_text TEXT,
  PRIMARY KEY (post_id, position)
);
CREATE TABLE feed_comments(
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES feed_posts(id),
  author_actor TEXT NOT NULL CHECK (author_actor IN ('qiaosheng','jiaming')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX idx_feed_comments_post ON feed_comments(post_id, created_at, id);
CREATE TABLE album_entries(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chat_screenshots','important_photos','stickers')),
  asset_id TEXT NOT NULL,
  added_by_actor TEXT NOT NULL CHECK (added_by_actor IN ('qiaosheng','jiaming')),
  caption TEXT,
  meaning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, asset_id)
);
CREATE TABLE album_entry_refs(
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES album_entries(id),
  service TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (entry_id, service, kind, source_id)
);
CREATE INDEX idx_album_refs_source ON album_entry_refs(service, kind, source_id, entry_id);
CREATE TABLE creations(
  id TEXT PRIMARY KEY,
  creator_actor TEXT NOT NULL CHECK (creator_actor IN ('qiaosheng','jiaming')),
  title TEXT,
  bucket_service TEXT NOT NULL DEFAULT 'mariposa',
  bucket_id TEXT NOT NULL,
  icon_asset_id TEXT NOT NULL,
  work_asset_id TEXT,
  work_kind TEXT CHECK (work_kind IN ('image','video','html') OR work_kind IS NULL),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE TABLE future_notes(
  id TEXT PRIMARY KEY,
  author_actor TEXT NOT NULL CHECK (author_actor IN ('qiaosheng','jiaming')),
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE TABLE future_note_assets(
  note_id TEXT NOT NULL REFERENCES future_notes(id),
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (note_id, position)
);
CREATE TABLE content_receipts(
  actor TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, idem_key)
);
`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
  }
  return db;
}

const sha = (s: string): string => randomBytes(0).toString('hex') || simpleHash(s);
function simpleHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; h2 ^= (s.charCodeAt(i) + i) & 0xff; h2 = Math.imul(h2, 0x85ebca6b) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const genId = (p: string): string => `${p}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

export type ContentServerOptions = { stateRoot: string; port: number; token?: string };

export class ContentServer {
  readonly db: Db;
  readonly token: string;
  private server: ReturnType<typeof createServer> | null = null;
  port = 0;

  constructor(opts: ContentServerOptions) {
    this.db = openDb(opts.stateRoot);
    fs.mkdirSync(opts.stateRoot, { recursive: true });
    const tokenFile = path.join(opts.stateRoot, 'service.token');
    if (opts.token) { this.token = opts.token; fs.writeFileSync(tokenFile, opts.token); }
    else if (fs.existsSync(tokenFile)) this.token = fs.readFileSync(tokenFile, 'utf8').trim();
    else { this.token = randomBytes(24).toString('hex'); fs.writeFileSync(tokenFile, this.token); }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => { this.server = createServer((req, res) => { void this.handle(req, res).catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'internal', message: String((err as Error).message).slice(0, 80) } })); }); }); this.server.listen(this.port, '127.0.0.1', () => resolve()); });
    const addr = this.server!.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : this.port;
  }

  async stop(): Promise<void> { await new Promise<void>((r) => this.server?.close(() => r()) ?? r()); this.db.close(); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://content');
    const route = `${req.method} ${url.pathname}`;
    // 内部认证：服务凭据必验（仅 loopback 不能代替内部认证，§06.1）
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${this.token}`) return this.json(res, 401, { error: { code: 'unauthorized', message: '内部服务凭据无效' } });
    const actor = String(req.headers['x-actor'] ?? '');
    if (!(ACTORS as readonly string[]).includes(actor)) return this.json(res, 403, { error: { code: 'actor_invalid', message: 'actor 必须由宿主派生（双人集合）' } });
    const body = await this.readBody(req);
    try {
      const result = await this.dispatch(route, actor as Actor, url, body, req, res);
      if (result !== undefined) this.json(res, result.status, result.body);
    } catch (err) {
      if (err instanceof ContentError) this.json(res, err.status, { error: { code: err.code.toLowerCase(), message: err.message } });
      else throw err;
    }
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []; let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > 5 * 1024 * 1024) { resolve({}); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { if (chunks.length === 0) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({ __bad_json: true }); } });
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  /** §3.2 幂等回执：同 actor+key 同指纹=原结果；同键异指纹=冲突；无键的新写操作=参数错误。 */
  private withReceipt(actor: Actor, key: string | null, requestHashSource: string, fn: () => { status: number; body: unknown }): { status: number; body: unknown } {
    if (!key) throw new ContentError(400, 'MISSING_IDEMPOTENCY_KEY', '写请求必须带 Idempotency-Key');
    const hash = simpleHash(requestHashSource);
    const prior = this.db.prepare('SELECT status, response_json, request_hash FROM content_receipts WHERE actor = ? AND idem_key = ?').get(actor, key) as { status: number; response_json: string; request_hash: string } | undefined;
    if (prior) {
      if (prior.request_hash !== hash) throw new ContentError(409, 'IDEMPOTENCY_CONFLICT', '同幂等键对应不同请求');
      return { status: prior.status, body: JSON.parse(prior.response_json) };
    }
    const out = fn();
    this.db.prepare('INSERT INTO content_receipts(actor, idem_key, request_hash, status, response_json, created_at) VALUES (?,?,?,?,?,?)').run(actor, key, hash, out.status, JSON.stringify(out.body), new Date().toISOString());
    return out;
  }

  private ifMatch(req: IncomingMessage, currentRevision: unknown): void {
    const v = String(req.headers['if-match'] ?? '').replace(/"/g, '');
    if (!v || !/^\d+$/.test(v)) throw new ContentError(428, 'PRECONDITION_REQUIRED', '必须带 If-Match: "<revision>"');
    if (Number(v) !== Number(currentRevision)) throw new ContentError(409, 'REVISION_CONFLICT', `修订不匹配（当前 ${Number(currentRevision)}）`);
  }

  private limitOf(url: URL): number {
    const n = Number(url.searchParams.get('limit')) || LIMIT_DEFAULT;
    if (n < 1 || n > LIMIT_MAX) throw new ContentError(400, 'LIMIT_INVALID', `limit 必须在 1..${LIMIT_MAX}`);
    return n;
  }

  private decodeCursor(c: string | null): Record<string, string> | null {
    if (!c) return null;
    try { return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, string>; } catch { throw new ContentError(400, 'CURSOR_INVALID', '游标非法'); }
  }

  private async dispatch(route: string, actor: Actor, url: URL, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<{ status: number; body: unknown } | undefined> {
    const now = () => new Date().toISOString();
    void res;

    // —— 朋友圈：posts / comments ——
    if (route === 'GET /api/v1/content/posts') {
      const limit = this.limitOf(url);
      const cursor = this.decodeCursor(url.searchParams.get('cursor'));
      const presentation = url.searchParams.get('presentation');
      const rows = this.db.prepare(`SELECT * FROM feed_posts WHERE deleted_at IS NULL ${presentation === 'post' || presentation === 'letter' ? 'AND presentation = ?' : ''} ORDER BY published_at DESC, id DESC`).all(...(presentation === 'post' || presentation === 'letter' ? [presentation] : [])) as Array<Record<string, unknown>>;
      const after = cursor?.after ?? null; // 首读上界固定；翻页不吞新增（§3.2）
      const filtered = after !== null ? rows.filter((r) => String(r.published_at) > after || (String(r.published_at) === after && String(r.id) > (cursor!.id ?? ''))) : rows;
      const page = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      return { status: 200, body: { items: page.map((r) => this.postDto(r)), next_cursor: hasMore && page.length > 0 ? Buffer.from(JSON.stringify({ after: String(page[page.length - 1]!.published_at), id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: hasMore } };
    }
    let m = /^GET \/api\/v1\/content\/posts\/([^/]+)$/.exec(route);
    if (m) return { status: 200, body: this.postDto(this.postRow(String(m[1])), true) };
    if (route === 'POST /api/v1/content/posts') {
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor }), () => {
        const presentation = body.presentation === 'letter' ? 'letter' : 'post';
        const title = typeof body.title === 'string' && body.title.length > 0 ? body.title.slice(0, 200) : null;
        const text = typeof body.body === 'string' ? body.body : '';
        const assetIds = Array.isArray(body.asset_ids) ? body.asset_ids.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
        if (text.trim().length === 0 && assetIds.length === 0) throw new ContentError(422, 'EMPTY_POST', '帖子必须至少有非空正文或一项附件');
        if (text.length > 40000) throw new ContentError(422, 'BODY_TOO_LONG', '正文超过 40000 字符');
        const id = genId('post');
        const t = now();
        this.db.prepare('INSERT INTO feed_posts(id, author_actor, presentation, title, body, created_at, published_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)').run(id, actor, presentation, title, text, t, t, t);
        const unique = [...new Set(assetIds)];
        for (let i = 0; i < unique.length; i++) this.db.prepare('INSERT INTO feed_post_assets(post_id, asset_id, position, alt_text) VALUES (?,?,?,?)').run(id, unique[i], i, null);
        return { status: 201, body: this.postDto(this.postRow(id)!) };
      });
    }
    m = /^PUT \/api\/v1\/content\/posts\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.postRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能编辑本人帖子');
      if (row.deleted_at != null) throw new ContentError(409, 'POST_DELETED', '帖子已删除');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        const text = typeof body.body === 'string' ? body.body : String(row.body ?? '');
        const title = typeof body.title === 'string' && body.title.length > 0 ? body.title.slice(0, 200) : (row.title as string | null);
        const assetIds = Array.isArray(body.asset_ids) ? dedupeAssetIds(body.asset_ids.filter((a): a is string => typeof a === 'string')) : null;
        if (text.trim().length === 0 && (assetIds ?? []).length === 0) throw new ContentError(422, 'EMPTY_POST', '帖子必须至少有非空正文或一项附件');
        this.db.prepare('UPDATE feed_posts SET body = ?, title = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(text, title, now(), String(row.id));
        if (assetIds !== null) {
          this.db.prepare('DELETE FROM feed_post_assets WHERE post_id = ?').run(String(row.id));
          for (let i = 0; i < assetIds.length; i++) this.db.prepare('INSERT INTO feed_post_assets(post_id, asset_id, position, alt_text) VALUES (?,?,?,?)').run(String(row.id), assetIds[i]!, i, null);
        }
        return { status: 200, body: this.postDto(this.postRow(String(row.id))) };
      });
    }
    m = /^DELETE \/api\/v1\/content\/posts\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.postRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能删除本人帖子');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ actor, del: row.id, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        // §4.3.3：不级联删除他人评论——保留占位与既有评论；不再接受新评论
        this.db.prepare('UPDATE feed_posts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        this.db.prepare('DELETE FROM feed_post_assets WHERE post_id = ?').run(String(row.id));
        return { status: 200, body: { id: row.id, deleted: true } };
      });
    }
    m = /^GET \/api\/v1\/content\/posts\/([^/]+)\/comments$/.exec(route);
    if (m) {
      this.postRow(String(m[1])); // 帖子必须存在（含已删占位——评论作者仍可查看自己的评论）
      const limit = this.limitOf(url);
      const rows = this.db.prepare('SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC').all(String(m[1])) as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.commentDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }
    m = /^POST \/api\/v1\/content\/posts\/([^/]+)\/comments$/.exec(route);
    if (m?.[1] !== undefined) {
      const postId = m[1];
      const post = this.postRow(m[1]!);
      if (post.deleted_at != null) throw new ContentError(409, 'POST_DELETED', '原帖已删除，不再接受新评论');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, post: postId }), () => {
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length === 0) throw new ContentError(422, 'EMPTY_COMMENT', '评论正文不能为空');
        if (text.length > 10000) throw new ContentError(422, 'COMMENT_TOO_LONG', '评论超过 10000 字符');
        const id = genId('cmt');
        this.db.prepare('INSERT INTO feed_comments(id, post_id, author_actor, body, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)').run(id, postId, actor, text, now(), now());
        return { status: 201, body: this.commentDto(this.db.prepare('SELECT * FROM feed_comments WHERE id = ?').get(id) as Record<string, unknown>) };
      });
    }
    m = /^PUT \/api\/v1\/content\/comments\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.commentRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能编辑本人评论');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length === 0) throw new ContentError(422, 'EMPTY_COMMENT', '评论正文不能为空');
        this.db.prepare('UPDATE feed_comments SET body = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(text, now(), String(row.id));
        return { status: 200, body: this.commentDto(this.db.prepare('SELECT * FROM feed_comments WHERE id = ?').get(String(row.id)) as Record<string, unknown>) };
      });
    }
    m = /^DELETE \/api\/v1\/content\/comments\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.commentRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能删除本人评论');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ actor, del: row.id, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE feed_comments SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        return { status: 200, body: { id: row.id, deleted: true } };
      });
    }

    // —— 相册（§5）——
    m = /^GET \/api\/v1\/content\/albums\/(chat_screenshots|important_photos|stickers)\/entries$/.exec(route);
    if (m) {
      const kind = m[1]!;
      const limit = this.limitOf(url);
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const ss = url.searchParams.get('source_service');
      const sk = url.searchParams.get('source_kind');
      const sid = url.searchParams.get('source_id');
      let rows = this.db.prepare('SELECT * FROM album_entries WHERE kind = ? ORDER BY created_at DESC, id DESC').all(kind) as Array<Record<string, unknown>>;
      if (ss && sk && sid) {
        // §5 反查：our_words 专道得到真实 source_id → 引用反查截图归档
        const refIds = new Set((this.db.prepare('SELECT entry_id FROM album_entry_refs WHERE service = ? AND kind = ? AND source_id = ?').all(ss, sk, sid) as Array<{ entry_id: string }>).map((r) => r.entry_id));
        rows = rows.filter((r) => refIds.has(String(r.id)));
      }
      if (q.length > 0) rows = rows.filter((r) => `${r.caption ?? ''} ${r.meaning ?? ''}`.toLowerCase().includes(q));
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.albumDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }
    m = /^POST \/api\/v1\/content\/albums\/(chat_screenshots|important_photos|stickers)\/entries$/.exec(route);
    if (m) {
      const kind = m[1]!;
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, kind }), () => {
        if (typeof body.asset_id !== 'string' || !body.asset_id) throw new ContentError(422, 'ASSET_REQUIRED', 'asset_id 必填（先经 est 媒体服务持久保存）');
        const existing = this.db.prepare('SELECT * FROM album_entries WHERE kind = ? AND asset_id = ?').get(kind, body.asset_id) as Record<string, unknown> | undefined;
        if (existing) return { status: 200, body: this.albumDto(existing), duplicate: true }; // §5：同 (kind,asset) 幂等返回既有
        const id = genId('ae');
        const t = now();
        this.db.prepare('INSERT INTO album_entries(id, kind, asset_id, added_by_actor, caption, meaning, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)').run(id, kind, body.asset_id, actor, typeof body.caption === 'string' ? body.caption.slice(0, 2000) : null, typeof body.meaning === 'string' ? body.meaning.slice(0, 2000) : null, t, t);
        const refs = Array.isArray(body.refs) ? body.refs : [];
        for (const r of refs as Array<Record<string, unknown>>) {
          if (typeof r?.service !== 'string' || typeof r?.kind !== 'string' || typeof r?.source_id !== 'string') throw new ContentError(422, 'REF_INVALID', '关联引用必须含 service/kind/source_id（任一校验失败则本次写入失败）');
          this.db.prepare('INSERT INTO album_entry_refs(id, entry_id, service, kind, source_id, created_at) VALUES (?,?,?,?,?,?)').run(genId('aer'), id, r.service, r.kind, r.source_id, t);
        }
        return { status: 201, body: this.albumDto(this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(id) as Record<string, unknown>) };
      });
    }
    m = /^PUT \/api\/v1\/content\/album-entries\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.albumRow(m[1]!);
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE album_entries SET caption = COALESCE(?, caption), meaning = COALESCE(?, meaning), updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.caption === 'string' ? body.caption.slice(0, 2000) : null, typeof body.meaning === 'string' ? body.meaning.slice(0, 2000) : null, now(), String(row.id));
        return { status: 200, body: this.albumDto(this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(String(row.id)) as Record<string, unknown>) };
      });
    }
    m = /^DELETE \/api\/v1\/content\/album-entries\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.albumRow(m[1]!);
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ actor, del: row.id, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        // §10.3：移除归档=解除该归档及关联；不删外部原文/全局原文件（est 资产引用保护另行）
        this.db.prepare('DELETE FROM album_entry_refs WHERE entry_id = ?').run(String(row.id));
        this.db.prepare('DELETE FROM album_entries WHERE id = ?').run(String(row.id));
        return { status: 200, body: { id: row.id, removed: true } };
      });
    }

    // —— 纪念作品（§6）——
    if (route === 'GET /api/v1/content/creations') {
      const limit = this.limitOf(url);
      const rows = this.db.prepare('SELECT * FROM creations WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC').all() as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.creationDto(r)), next_cursor: null, has_more: rows.length > limit } };
    }
    m = /^GET \/api\/v1\/content\/creations\/([^/]+)$/.exec(route);
    if (m) return { status: 200, body: this.creationDto(this.creationRow(m[1]!)) };
    if (route === 'POST /api/v1/content/creations') {
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor }), () => {
        if (typeof body.bucket_id !== 'string' || !body.bucket_id) throw new ContentError(422, 'BUCKET_REQUIRED', 'bucket_ref 必填（指向已有 Mariposa 桶；est 代理侧验证）');
        if (typeof body.icon_asset_id !== 'string' || !body.icon_asset_id) throw new ContentError(422, 'ICON_REQUIRED', 'icon_asset_id 必填');
        const workAsset: string | null = typeof body.work_asset_id === 'string' && body.work_asset_id ? body.work_asset_id : null;
        const workKind: string | null = workAsset !== null && typeof body.work_kind === 'string' ? body.work_kind : null;
        if ((workAsset === null) !== (workKind === null)) throw new ContentError(422, 'WORK_INCONSISTENT', 'work_asset_id 与 work_kind 必须同时为空或同时有效');
        if (workKind !== null && !['image', 'video', 'html'].includes(String(workKind))) throw new ContentError(422, 'WORK_KIND_INVALID', 'work_kind 必须是 image|video|html');
        const id = genId('crt');
        const t = now();
        const args: Array<string | null> = [id, actor, typeof body.title === 'string' ? body.title.slice(0, 200) : null, typeof body.bucket_service === 'string' ? body.bucket_service : 'mariposa', String(body.bucket_id), String(body.icon_asset_id), workAsset, workKind, t, t];
        this.db.prepare('INSERT INTO creations(id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)').run(...args);
        return { status: 201, body: this.creationDto(this.creationRow(id)) };
      });
    }
    m = /^PUT \/api\/v1\/content\/creations\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.creationRow(m[1]!);
      if (String(row.creator_actor) !== actor) throw new ContentError(403, 'NOT_CREATOR', '默认由创建者操作');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        const workAsset = typeof body.work_asset_id === 'string' && body.work_asset_id ? body.work_asset_id : (row.work_asset_id as string | null);
        const workKind = typeof body.work_kind === 'string' ? body.work_kind : (row.work_kind as string | null);
        if ((workAsset === null || workAsset === undefined) !== (workKind === null || workKind === undefined)) throw new ContentError(422, 'WORK_INCONSISTENT', 'work_asset_id 与 work_kind 必须同时为空或同时有效');
        this.db.prepare('UPDATE creations SET title = COALESCE(?, title), work_asset_id = ?, work_kind = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.title === 'string' ? body.title.slice(0, 200) : null, workAsset ?? null, workKind ?? null, now(), String(row.id));
        return { status: 200, body: this.creationDto(this.creationRow(String(row.id))) };
      });
    }
    m = /^DELETE \/api\/v1\/content\/creations\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.creationRow(m[1]!);
      if (String(row.creator_actor) !== actor) throw new ContentError(403, 'NOT_CREATOR', '默认由创建者操作');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ actor, del: row.id, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE creations SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        return { status: 200, body: { id: row.id, deleted: true } };
      });
    }

    // —— 未来留言正文（§8.1：正文归 content；投递时间/状态归 est 调度器——此处无 deliver_at）——
    if (route === 'GET /api/v1/content/future-notes') {
      const limit = this.limitOf(url);
      const rows = this.db.prepare('SELECT * FROM future_notes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC').all() as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.noteDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }
    m = /^GET \/api\/v1\/content\/future-notes\/([^/]+)$/.exec(route);
    if (m) return { status: 200, body: this.noteDto(this.noteRow(m[1]!)) };
    if (route === 'POST /api/v1/content/future-notes') {
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor }), () => {
        const text = typeof body.body === 'string' ? body.body : '';
        const assetIds = Array.isArray(body.asset_ids) ? dedupeAssetIds(body.asset_ids.filter((a): a is string => typeof a === 'string')) : [];
        if (text.trim().length === 0 && assetIds.length === 0) throw new ContentError(422, 'EMPTY_NOTE', '留言必须至少有非空正文或一项附件');
        const id = genId('fn');
        const t = now();
        this.db.prepare('INSERT INTO future_notes(id, author_actor, title, body, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)').run(id, actor, typeof body.title === 'string' ? body.title.slice(0, 200) : null, text, t, t);
        for (let i = 0; i < assetIds.length; i++) this.db.prepare('INSERT INTO future_note_assets(note_id, asset_id, position) VALUES (?,?,?)').run(id, assetIds[i], i);
        return { status: 201, body: this.noteDto(this.noteRow(id)) };
      });
    }
    m = /^PUT \/api\/v1\/content\/future-notes\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.noteRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '默认仅本人管理正文');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ body, actor, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE future_notes SET title = COALESCE(?, title), body = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.title === 'string' ? body.title.slice(0, 200) : null, typeof body.body === 'string' ? body.body : String(row.body ?? ''), now(), String(row.id));
        return { status: 200, body: this.noteDto(this.noteRow(String(row.id))) };
      });
    }
    m = /^DELETE \/api\/v1\/content\/future-notes\/([^/]+)$/.exec(route);
    if (m) {
      const row = this.noteRow(m[1]!);
      if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '默认仅本人管理正文');
      return this.withReceipt(actor, header(req, 'idempotency-key'), stable({ actor, del: row.id, rev: row.revision }), () => {
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE future_notes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        return { status: 200, body: { id: row.id, deleted: true } };
      });
    }
    return { status: 404, body: { error: { code: 'not_found', message: `未知路由：${route}` } } };
  }

  // —— 行读取与 DTO ——
  private postRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM feed_posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'POST_NOT_FOUND', '帖子不存在');
    return row;
  }
  private postDto(r: Record<string, unknown>, withAssets = true): Record<string, unknown> {
    const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
    const assets = deleted ? [] : (this.db.prepare('SELECT asset_id, alt_text FROM feed_post_assets WHERE post_id = ? ORDER BY position').all(String(r.id)) as Array<{ asset_id: string; alt_text: string | null }>);
    const commentCount = (this.db.prepare('SELECT COUNT(*) n FROM feed_comments WHERE post_id = ? AND deleted_at IS NULL').get(String(r.id)) as { n: number }).n;
    return {
      id: r.id, author: r.author_actor, presentation: r.presentation,
      title: deleted ? null : r.title, body: deleted ? null : r.body, // §4.3.5：删除后普通读取不再返回原正文
      created_at: r.created_at, published_at: r.published_at, updated_at: r.updated_at,
      revision: r.revision, deleted: deleted, deleted_at: r.deleted_at ?? null,
      asset_ids: withAssets ? assets.map((a) => a.asset_id) : undefined,
      comment_count: commentCount,
    };
  }
  private commentRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM feed_comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'COMMENT_NOT_FOUND', '评论不存在');
    return row;
  }
  private commentDto(r: Record<string, unknown>): Record<string, unknown> {
    const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
    return { id: r.id, post_id: r.post_id, author: r.author_actor, body: deleted ? null : r.body, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, deleted, deleted_at: r.deleted_at ?? null };
  }
  private albumRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'ENTRY_NOT_FOUND', '相册条目不存在');
    return row;
  }
  private albumDto(r: Record<string, unknown>): Record<string, unknown> {
    const refs = this.db.prepare('SELECT service, kind, source_id FROM album_entry_refs WHERE entry_id = ?').all(String(r.id)) as Array<Record<string, string>>;
    return { id: r.id, kind: r.kind, asset_id: r.asset_id, added_by: r.added_by_actor, caption: r.caption, meaning: r.meaning, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, refs };
  }
  private creationRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM creations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'CREATION_NOT_FOUND', '作品记录不存在');
    return row;
  }
  private creationDto(r: Record<string, unknown>): Record<string, unknown> {
    return { id: r.id, creator: r.creator_actor, title: r.title, bucket_ref: { service: r.bucket_service, kind: 'bucket', id: r.bucket_id }, icon_asset_id: r.icon_asset_id, work_asset_id: r.work_asset_id ?? null, work_kind: r.work_kind ?? null, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, deleted: r.deleted_at != null };
  }
  private noteRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM future_notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'NOTE_NOT_FOUND', '留言不存在');
    return row;
  }
  private noteDto(r: Record<string, unknown>): Record<string, unknown> {
    const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
    const assets = deleted ? [] : (this.db.prepare('SELECT asset_id FROM future_note_assets WHERE note_id = ? ORDER BY position').all(String(r.id)) as Array<{ asset_id: string }>);
    return { id: r.id, author: r.author_actor, title: deleted ? null : r.title, body: deleted ? null : r.body, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, deleted, asset_ids: assets.map((a) => a.asset_id) };
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function stable(o: unknown): string { return JSON.stringify(o); }
function dedupeAssetIds(ids: string[]): string[] { return [...new Set(ids)]; }

export function sha256ish(s: string): string { return sha(s); }
