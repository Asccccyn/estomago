// ESTOMAGO_CHAT_EXEC_V1 §06（WP5）：可选内容后端 apps/content——独立进程、独立 SQLite、
// 仅 loopback、内部服务凭据 + 宿主派生 actor（qiaosheng/jiaming 双人集合）。
// 朋友圈（post/letter 同一数据模型）+ 评论 + 三类相册归档 + 纪念作品 + 未来留言正文。
// 不拥有：桶/计划/星星正本（稳定引用）、媒体字节（asset_id 引用）、投递调度（est 调度器）。
// est 只经 HTTP 薄代理访问本服务（浏览器不得直连；body 无任何作者字段——作者只来自可信头）。
//
// P1（四仓合并审计 20261106，F06/F07）：全部 15 条写路由共用类型化命令身份
// {fingerprint_version, actor, resource_type, action, target, original_expected_revision, params}；
// 回执解析先于存在性/作者/CAS（新操作才做这些校验）；历史回执（指纹版本 0）经受限
// 兼容入口解析——旧算法哈希与回执资源形状都能对上才回放，否则待核冲突，不换 key 重建。
// 权威当前状态经 GET /references/:type/:id 快照独立提供（含相册最小墓碑与零集合版本锚），
// 回执只代表过去某次请求的结果，两者不得互相冒充。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { CONTENT_ALBUMS, CARRY_IMAGE_LIMIT, CARRY_MODES, type CarryMode, type CarrySetItem } from '../../../packages/contracts/src/content.ts';

export const ACTORS = ['qiaosheng', 'jiaming'] as const;
export type Actor = (typeof ACTORS)[number];
export const CONTENT_SCHEMA_VERSION = 5;
export const CONTENT_FINGERPRINT_VERSION = 2;

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

export const CONTENT_RESOURCE_TYPES = ['post', 'comment', 'album_entry', 'creation', 'future_note', 'conversation_archive'] as const;
export type ResourceType = (typeof CONTENT_RESOURCE_TYPES)[number];

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
  db.exec('PRAGMA busy_timeout=5000');
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
  if (!have.includes(2)) {
    // v2（F06/F07 P1）：①回执记录类型化命令身份（旧 13 条行为指纹版本 0，原样保留）；
    // ②相册最小墓碑——删除递增 revision 软删，UNIQUE(kind,asset_id) 只约束有效行，
    // 移除后可重新归档（新 ID）。换表需在 FK 关闭下重建（album_entry_refs 引用旧表）。
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec(`
ALTER TABLE content_receipts ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_receipts ADD COLUMN resource_type TEXT;
ALTER TABLE content_receipts ADD COLUMN action TEXT;
ALTER TABLE content_receipts ADD COLUMN target_json TEXT;
CREATE TABLE album_entries_v2(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chat_screenshots','important_photos','stickers')),
  asset_id TEXT NOT NULL,
  added_by_actor TEXT NOT NULL CHECK (added_by_actor IN ('qiaosheng','jiaming')),
  caption TEXT,
  meaning TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
INSERT INTO album_entries_v2(id, kind, asset_id, added_by_actor, caption, meaning, created_at, updated_at, revision, deleted_at)
  SELECT id, kind, asset_id, added_by_actor, caption, meaning, created_at, updated_at, revision, NULL FROM album_entries;
DROP TABLE album_entries;
ALTER TABLE album_entries_v2 RENAME TO album_entries;
CREATE UNIQUE INDEX idx_album_entries_live ON album_entries(kind, asset_id) WHERE deleted_at IS NULL;
`);
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
  }
  if (!have.includes(3)) {
    // v3（相册重构 P3，GLM_ALBUM_REFACTOR_EXECUTION 20261108）：携带模式——仅收藏/下次
    // 滚窗一次/每次滚窗。取值校验在写入路径（ALTER 无法带 CHECK）；上限校验见
    // assertCarryWithinLimit（合并去重集合 ≤ CARRY_IMAGE_LIMIT，常量正本在共享合同）。
    db.exec(`ALTER TABLE album_entries ADD COLUMN carry_mode TEXT NOT NULL DEFAULT 'none';`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (3, ?)').run(new Date().toISOString());
  }
  if (!have.includes(4)) {
    // v4（相册重构 P4）：对话存档——争吵/甜蜜的业务正本。存档确定的是消息引用集合
    // （message_id+revision+sequence，非连续集合按原会话序保序展示，不夹带未选消息）；
    // 原文正本在 M（est 同步），content 不复制正文。kind 由明确操作确定，不猜。
    db.exec(`
CREATE TABLE conversation_archives(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('quarrel','sweet')),
  created_by_actor TEXT NOT NULL CHECK (created_by_actor IN ('qiaosheng','jiaming')),
  note TEXT,
  messages_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX idx_conversation_archives_conv ON conversation_archives(conversation_id, kind, created_at DESC);
`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (4, ?)').run(new Date().toISOString());
  }
  if (!have.includes(5)) {
    // v5（相册重构 P3，R10/R11）：生成图片作品免桶——creations 的 bucket_ref 原指向
    // Mariposa 纪念桶且 NOT NULL；纯图片作品（work_asset_id+work_kind='image'）没有桶
    // 语义，重建表使 bucket_service/bucket_id 可空（存量行原样保留）。
    db.exec(`
CREATE TABLE creations_v5(
  id TEXT PRIMARY KEY,
  creator_actor TEXT NOT NULL CHECK (creator_actor IN ('qiaosheng','jiaming')),
  title TEXT,
  bucket_service TEXT,
  bucket_id TEXT,
  icon_asset_id TEXT NOT NULL,
  work_asset_id TEXT,
  work_kind TEXT CHECK (work_kind IN ('image','video','html') OR work_kind IS NULL),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
INSERT INTO creations_v5(id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision, deleted_at)
  SELECT id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision, deleted_at FROM creations;
DROP TABLE creations;
ALTER TABLE creations_v5 RENAME TO creations;
`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (5, ?)').run(new Date().toISOString());
  }
  if (!have.includes(6)) {
    // v6（相册整改 R5，复审 2026-11-08）：creation_save_artifact 保存即入作品——本地生成
    // 作品 svg/html 免桶入条目，work_kind 枚举扩 'svg'（重建表换 CHECK；存量行原样保留）。
    db.exec(`
CREATE TABLE creations_v6(
  id TEXT PRIMARY KEY,
  creator_actor TEXT NOT NULL CHECK (creator_actor IN ('qiaosheng','jiaming')),
  title TEXT,
  bucket_service TEXT,
  bucket_id TEXT,
  icon_asset_id TEXT NOT NULL,
  work_asset_id TEXT,
  work_kind TEXT CHECK (work_kind IN ('image','video','html','svg') OR work_kind IS NULL),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
INSERT INTO creations_v6(id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision, deleted_at)
  SELECT id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision, deleted_at FROM creations;
DROP TABLE creations;
ALTER TABLE creations_v6 RENAME TO creations;
`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (6, ?)').run(new Date().toISOString());
  }
  if (!have.includes(7)) {
    // v7（相册整改 RR2，复审 2026-11-09）：携带限额与集合按 **M 对象身份** 计——
    // 同字节经不同上传操作是不同 E asset_id、同一张图；album_entries 记录入库时的
    // content_sha256（E 侧写入方补注，存量行 NULL=退回 asset 身份）。重建表加列
    //（SQLite ALTER 加列即可，但保持本仓迁移风格：轻量 ALTER，无索引依赖）。
    db.exec(`ALTER TABLE album_entries ADD COLUMN content_sha256 TEXT`);
    db.prepare('INSERT INTO content_schema_migrations(version, applied_at) VALUES (7, ?)').run(new Date().toISOString());
  }
  return db;
}

function simpleHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; h2 ^= (s.charCodeAt(i) + i) & 0xff; h2 = Math.imul(h2, 0x85ebca6b) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const genId = (p: string): string => `${p}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const ID_PREFIX: Record<ResourceType, string> = { post: 'post_', comment: 'cmt_', album_entry: 'ae_', creation: 'crt_', future_note: 'fn_', conversation_archive: 'ca_' };

export type ContentServerOptions = { stateRoot: string; port: number; token?: string };

/** P1.2：一次写请求的类型化命令身份（唯一入口，resolve 与执行共用）。 */
export type WriteCommand = {
  resourceType: ResourceType;
  action: 'create' | 'update' | 'delete';
  target: string | null; // 对象 ID（update/delete）；评论=父 post ID；相册创建=kind；其余 create=null
  expectedRevision: string | null; // 原始 If-Match 头（原样，含引号；创建=null）
  params: Record<string, unknown>; // 原始 body（指纹用规范化副本，业务校验读原值）
};

function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalJson((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** v2 指纹：资源类型/动作/目标/原 If-Match/规范化参数 + actor。字段缺席与显式清空、
 *  有意义的附件顺序都在 params 原样保留（规范化只排序对象键，不动数组顺序）。 */
export function commandFingerprint(actor: Actor, cmd: WriteCommand): string {
  return simpleHash(JSON.stringify({
    v: CONTENT_FINGERPRINT_VERSION, actor,
    rt: cmd.resourceType, a: cmd.action, t: cmd.target ?? null,
    er: cmd.expectedRevision ?? null, p: canonicalJson(cmd.params),
  }));
}

/** 旧指纹算法（指纹版本 0）按原始路由逐字重建——只用于既有回执的兼容解析。 */
function legacyFingerprint(actor: Actor, cmd: WriteCommand): string | null {
  const b = cmd.params;
  const im = cmd.expectedRevision ?? '';
  if (cmd.action === 'create') {
    if (cmd.resourceType === 'post' || cmd.resourceType === 'creation' || cmd.resourceType === 'future_note') return JSON.stringify({ body: b, actor });
    if (cmd.resourceType === 'comment') return JSON.stringify({ body: b, actor, post: cmd.target });
    if (cmd.resourceType === 'album_entry') return JSON.stringify({ body: b, actor, kind: cmd.target });
    return null;
  }
  if (cmd.action === 'update') return JSON.stringify({ op: 'put', path: cmd.target, body: b, actor, im });
  if (cmd.action === 'delete') {
    if (cmd.resourceType === 'comment') return JSON.stringify({ actor, del: cmd.target, im });
    return JSON.stringify({ op: 'del', path: cmd.target, actor, im });
  }
  return null;
}

type ReceiptRow = { status: number; response_json: string; request_hash: string; fingerprint_version: number; resource_type: string | null; action: string | null; target_json: string | null };

export class ContentServer {
  readonly db: Db;
  readonly token: string;
  private server: ReturnType<typeof createServer> | null = null;
  port = 0;

  constructor(opts: ContentServerOptions) {
    this.db = openDb(opts.stateRoot);
    fs.mkdirSync(opts.stateRoot, { recursive: true });
    this.port = opts.port;
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

  // —— P1.2 统一写入口：回执解析先于一切新操作校验；业务与回执同事务 ——
  private receiptRow(actor: Actor, key: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT status, response_json, request_hash, fingerprint_version, resource_type, action, target_json FROM content_receipts WHERE actor = ? AND idem_key = ?').get(actor, key) as ReceiptRow | undefined;
  }

  /** 解析该 actor+key 的既有回执对当前命令的含义：replay=回放原结果；conflict=同键异请求；
   *  legacy_unresolved=旧回执但旧算法/资源形状对不上（待核，保留原结果）；new=无回执。 */
  resolveReceipt(actor: Actor, key: string, cmd: WriteCommand): { outcome: 'replay'; status: number; body: unknown } | { outcome: 'new' } | { outcome: 'conflict' | 'legacy_unresolved'; status: number; body: unknown } {
    const prior = this.receiptRow(actor, key);
    if (!prior) return { outcome: 'new' };
    if (prior.fingerprint_version >= CONTENT_FINGERPRINT_VERSION) {
      if (prior.request_hash === commandFingerprint(actor, cmd)) return { outcome: 'replay', status: prior.status, body: JSON.parse(prior.response_json) };
      return { status: 409, outcome: 'conflict', body: { error: { code: 'idempotency_conflict', message: '同幂等键对应不同请求' } } };
    }
    // 旧回执（指纹版本 0）：旧算法哈希命中后还必须有**正面**资源类型/目标证据才回放
    // （RF03，复审 20261106：旧删除回执 {id,deleted,asset_ids} 判不出类型≠可放行——
    // 曾经可借 album 前缀豁免跨类型回放）。正面证据=回执形状可判同型，或真实域 ID
    // 前缀+对象事实（含墓碑行）同型；证据不足按待核冲突处理，不自动换 key 重建。
    const legacy = legacyFingerprint(actor, cmd);
    if (legacy !== null && simpleHash(legacy) === prior.request_hash) {
      let responseShape: Record<string, unknown>;
      try { responseShape = JSON.parse(prior.response_json) as Record<string, unknown>; } catch { responseShape = {}; }
      const inferred = inferResourceTypeFromResponse(responseShape);
      const responseId = typeof responseShape.id === 'string' ? responseShape.id : null;
      const shapeOk = inferred === cmd.resourceType;
      const domainOk = cmd.action !== 'create' && cmd.target !== null
        && cmd.target.startsWith(ID_PREFIX[cmd.resourceType])
        && this.legacyDomainRowExists(cmd.resourceType, cmd.target);
      const typeOk = shapeOk || domainOk;
      const targetOk = cmd.action === 'create' ? typeOk : responseId === cmd.target && typeOk;
      if (targetOk) return { outcome: 'replay', status: prior.status, body: responseShape };
    }
    return { outcome: 'legacy_unresolved', status: 409, body: { error: { code: 'legacy_receipt_unresolved', message: '同幂等键存在历史回执，但无法确认与当前请求同源（保留原结果，请用新键或人工核对）' } } };
  }

  /** RF03：旧回执兼容解析用的对象事实核对——ID 前缀判定类型后，在对应域表查该 ID
   *  是否真实存在（含软删墓碑）。旧格式对象全部软删保留，硬删不存在；ID 无该类型
   *  前缀或无对应行=类型证据不成立。 */
  private legacyDomainRowExists(rt: ResourceType, id: string): boolean {
    const table = { post: 'feed_posts', comment: 'feed_comments', album_entry: 'album_entries', creation: 'creations', future_note: 'future_notes', conversation_archive: 'conversation_archives' }[rt];
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(id) !== undefined;
  }

  private runWrite(actor: Actor, key: string | null, cmd: WriteCommand, business: () => { status: number; body: unknown }): { status: number; body: unknown } {
    if (!key) throw new ContentError(400, 'MISSING_IDEMPOTENCY_KEY', '写请求必须带 Idempotency-Key');
    const resolved = this.resolveReceipt(actor, key, cmd);
    if (resolved.outcome === 'replay') return { status: resolved.status, body: resolved.body };
    if (resolved.outcome !== 'new') return { status: resolved.status, body: resolved.body };
    this.db.exec('BEGIN');
    try {
      const out = business();
      this.db.prepare('INSERT INTO content_receipts(actor, idem_key, request_hash, status, response_json, created_at, fingerprint_version, resource_type, action, target_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(actor, key, commandFingerprint(actor, cmd), out.status, JSON.stringify(out.body), new Date().toISOString(), CONTENT_FINGERPRINT_VERSION, cmd.resourceType, cmd.action, JSON.stringify(cmd.target ?? null));
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** P1.2 路由→命令映射（resolve 与 dispatch 共用，保证指纹一致）。返回 null=非写路由。 */
  private matchWrite(actor: Actor, method: string, pathname: string, body: Record<string, unknown>, req: IncomingMessage): { cmd: WriteCommand; business: () => { status: number; body: unknown } } | null {
    const ifm = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : null;
    const er = ifm !== null && ifm.length > 0 ? ifm : null;
    const now = () => new Date().toISOString();
    let m: RegExpExecArray | null;

    const cmd = (resourceType: ResourceType, action: WriteCommand['action'], target: string | null): WriteCommand => ({ resourceType, action, target, expectedRevision: er, params: body });

    // —— 朋友圈 posts ——
    if (method === 'POST' && pathname === '/api/v1/content/posts') {
      const c = cmd('post', 'create', null);
      return { cmd: c, business: () => {
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
      } };
    }
    if ((m = /^\/api\/v1\/content\/posts\/([^/]+)$/.exec(pathname)) !== null && method === 'PUT') {
    const id = m[1]!;
      const c = cmd('post', 'update', id);
      return { cmd: c, business: () => {
        const row = this.postRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能编辑本人帖子');
        if (row.deleted_at != null) throw new ContentError(409, 'POST_DELETED', '帖子已删除');
        this.ifMatch(req, Number(row.revision));
        const text = typeof body.body === 'string' ? body.body : String(row.body ?? '');
        const title = typeof body.title === 'string' && body.title.length > 0 ? body.title.slice(0, 200) : (row.title as string | null);
        const assetIds = Array.isArray(body.asset_ids) ? dedupeAssetIds(body.asset_ids.filter((a): a is string => typeof a === 'string')) : null;
        if (text.trim().length === 0 && (assetIds ?? []).length === 0) throw new ContentError(422, 'EMPTY_POST', '帖子必须至少有非空正文或一项附件');
        const previousAssetIds = assetIds !== null
          ? (this.db.prepare('SELECT asset_id FROM feed_post_assets WHERE post_id = ?').all(String(row.id)) as Array<{ asset_id: string }>).map((a) => a.asset_id)
          : undefined;
        this.db.prepare('UPDATE feed_posts SET body = ?, title = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(text, title, now(), String(row.id));
        if (assetIds !== null) {
          this.db.prepare('DELETE FROM feed_post_assets WHERE post_id = ?').run(String(row.id));
          for (let i = 0; i < assetIds.length; i++) this.db.prepare('INSERT INTO feed_post_assets(post_id, asset_id, position, alt_text) VALUES (?,?,?,?)').run(String(row.id), assetIds[i], i, null);
        }
        return { status: 200, body: { ...this.postDto(this.postRow(String(row.id))), ...(previousAssetIds !== undefined ? { previous_asset_ids: previousAssetIds } : {}) } };
      } };
    }
    if ((m = /^\/api\/v1\/content\/posts\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
    const id = m[1]!;
      const c = cmd('post', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.postRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能删除本人帖子');
        this.ifMatch(req, Number(row.revision));
        const priorAssets = (this.db.prepare('SELECT asset_id FROM feed_post_assets WHERE post_id = ?').all(String(row.id)) as Array<{ asset_id: string }>).map((a) => a.asset_id);
        // §4.3.3：不级联删除他人评论——保留占位与既有评论；不再接受新评论
        this.db.prepare('UPDATE feed_posts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        this.db.prepare('DELETE FROM feed_post_assets WHERE post_id = ?').run(String(row.id));
        return { status: 200, body: { id: row.id, deleted: true, asset_ids: priorAssets, revision: Number(row.revision) + 1 } };
      } };
    }
    // —— comments ——
    if ((m = /^\/api\/v1\/content\/posts\/([^/]+)\/comments$/.exec(pathname)) !== null && method === 'POST') {
    const id = m[1]!;
      const c = cmd('comment', 'create', id);
      return { cmd: c, business: () => {
        const post = this.postRow(id); // 帖子必须存在（含已删占位——评论作者仍可查看自己的评论）
        if (post.deleted_at != null) throw new ContentError(409, 'POST_DELETED', '原帖已删除，不再接受新评论');
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length === 0) throw new ContentError(422, 'EMPTY_COMMENT', '评论正文不能为空');
        if (text.length > 10000) throw new ContentError(422, 'COMMENT_TOO_LONG', '评论超过 10000 字符');
        const cmtId = genId('cmt');
        this.db.prepare('INSERT INTO feed_comments(id, post_id, author_actor, body, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)').run(cmtId, id, actor, text, now(), now());
        return { status: 201, body: this.commentDto(this.db.prepare('SELECT * FROM feed_comments WHERE id = ?').get(cmtId) as Record<string, unknown>) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/comments\/([^/]+)$/.exec(pathname)) !== null && method === 'PUT') {
    const id = m[1]!;
      const c = cmd('comment', 'update', id);
      return { cmd: c, business: () => {
        const row = this.commentRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能编辑本人评论');
        this.ifMatch(req, Number(row.revision));
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length === 0) throw new ContentError(422, 'EMPTY_COMMENT', '评论正文不能为空');
        this.db.prepare('UPDATE feed_comments SET body = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(text, now(), String(row.id));
        return { status: 200, body: this.commentDto(this.db.prepare('SELECT * FROM feed_comments WHERE id = ?').get(String(row.id)) as Record<string, unknown>) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/comments\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
    const id = m[1]!;
      const c = cmd('comment', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.commentRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '只能删除本人评论');
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE feed_comments SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        return { status: 200, body: { id: row.id, deleted: true, revision: Number(row.revision) + 1 } };
      } };
    }
    // —— 相册 album_entries ——
    if ((m = /^\/api\/v1\/content\/albums\/([^/]+)\/entries$/.exec(pathname)) !== null && method === 'POST') {
    const id = m[1]!;
      const c = cmd('album_entry', 'create', id);
      return { cmd: c, business: () => {
        const kind = id;
        if (!CONTENT_ALBUMS.some(album => album.album === kind)) throw new ContentError(404, 'ALBUM_NOT_FOUND', '相册不存在');
        if (typeof body.asset_id !== 'string' || !body.asset_id) throw new ContentError(422, 'ASSET_REQUIRED', 'asset_id 必填（先经 est 媒体服务持久保存）');
        const carryMode = parseCarryMode(body.carry_mode);
        const existing = this.db.prepare('SELECT * FROM album_entries WHERE kind = ? AND asset_id = ? AND deleted_at IS NULL').get(kind, body.asset_id) as Record<string, unknown> | undefined;
        // RR2（复审 2026-11-09）：content_sha256=E 侧写入方补注的 M 对象身份（同字节
        // 不同上传 ID=同一张图）；缺席=NULL，各口径退回 asset 身份。
        const sha256 = typeof body.content_sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.content_sha256) ? body.content_sha256 : null;
        if (existing) {
          // §5：同 (kind,asset) 幂等返回既有（有效行；墓碑可重新归档=新 ID）。
          // 携带模式若显式给出且不同，按同条目更新处理（同 asset 不算新增一张）。
          if (carryMode !== null && String(existing.carry_mode) !== carryMode) {
            // F1（复审 2026-11-09 二轮）：第 4 参数必须显式传——已有条目的原件身份优先取行内
            // content_sha256（存量 NULL 行退回本次请求补注值）；漏传会被默认参数掩成 null，
            // aliasInSet 恒 false，满限时同原件别名被错拒。
            this.assertCarryWithinLimit(carryMode, String(existing.asset_id), String(existing.id), (existing.content_sha256 as string | null) ?? sha256);
            this.db.prepare("UPDATE album_entries SET carry_mode = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(carryMode, now(), String(existing.id));
          }
          if (sha256 !== null && existing.content_sha256 == null) {
            // F1：补身份仅改 content_sha256——不碰 updated_at（它是 consume-next-once 的
            // before 比较基线，属"一次携带"的业务时间，对账补注不得移动它）。
            this.db.prepare('UPDATE album_entries SET content_sha256 = ? WHERE id = ?').run(sha256, String(existing.id)); // 存量行按新信息补身份（幂等）
          }
          return { status: 200, body: this.albumDto(this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(String(existing.id)) as Record<string, unknown>), duplicate: true };
        }
        this.assertCarryWithinLimit(carryMode ?? 'none', String(body.asset_id), null, sha256);
        const entryId = genId('ae');
        const t = now();
        this.db.prepare('INSERT INTO album_entries(id, kind, asset_id, added_by_actor, caption, meaning, created_at, updated_at, revision, carry_mode, content_sha256) VALUES (?,?,?,?,?,?,?,?,1,?,?)').run(entryId, kind, body.asset_id, actor, typeof body.caption === 'string' ? body.caption.slice(0, 2000) : null, typeof body.meaning === 'string' ? body.meaning.slice(0, 2000) : null, t, t, carryMode ?? 'none', sha256);
        const refs = Array.isArray(body.refs) ? body.refs : [];
        for (const r of refs as Array<Record<string, unknown>>) {
          if (typeof r?.service !== 'string' || typeof r?.kind !== 'string' || typeof r?.source_id !== 'string') throw new ContentError(422, 'REF_INVALID', '关联引用必须含 service/kind/source_id（任一校验失败则本次写入失败）');
          this.db.prepare('INSERT INTO album_entry_refs(id, entry_id, service, kind, source_id, created_at) VALUES (?,?,?,?,?,?)').run(genId('aer'), entryId, r.service, r.kind, r.source_id, t);
        }
        return { status: 201, body: this.albumDto(this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(entryId) as Record<string, unknown>) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/album-entries\/([^/]+)$/.exec(pathname)) !== null && method === 'PUT') {
    const id = m[1]!;
      const c = cmd('album_entry', 'update', id);
      return { cmd: c, business: () => {
        const row = this.albumRow(id);
        this.ifMatch(req, Number(row.revision));
        const carryMode = parseCarryMode(body.carry_mode);
        if (carryMode !== null && carryMode !== String(row.carry_mode)) {
          // F1（复审 2026-11-09 二轮）：PUT 改模式同样按行内原件身份判别名（默认参数已移除，
          // 此处必须显式传）；存量 NULL 行在对账补齐前按 asset 身份保守计数。
          this.assertCarryWithinLimit(carryMode, String(row.asset_id), String(row.id), row.content_sha256 as string | null);
        }
        this.db.prepare('UPDATE album_entries SET caption = COALESCE(?, caption), meaning = COALESCE(?, meaning), carry_mode = COALESCE(?, carry_mode), updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.caption === 'string' ? body.caption.slice(0, 2000) : null, typeof body.meaning === 'string' ? body.meaning.slice(0, 2000) : null, carryMode, now(), String(row.id));
        return { status: 200, body: this.albumDto(this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(String(row.id)) as Record<string, unknown>) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/album-entries\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
    const id = m[1]!;
      const c = cmd('album_entry', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.albumRow(id);
        this.ifMatch(req, Number(row.revision));
        // §10.3 + P1.1：移除归档=最小墓碑（revision+1 软删、清关联引用）——零集合有可定序版本，
        // 不删外部原文/全局原文件；同 (kind,asset) 可重新归档（新 ID）。
        this.db.prepare('DELETE FROM album_entry_refs WHERE entry_id = ?').run(String(row.id));
        this.db.prepare('UPDATE album_entries SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        return { status: 200, body: { id: row.id, removed: true, asset_id: String(row.asset_id), revision: Number(row.revision) + 1 } };
      } };
    }
    // —— creations ——
    if (method === 'POST' && pathname === '/api/v1/content/creations') {
      const c = cmd('creation', 'create', null);
      return { cmd: c, business: () => {
        // 免桶仅当 bucket_id 缺席：显式给桶的图片作品（纪念作品换图）仍按原合同存桶。
        // R5（复审 2026-11-08）：免桶范围扩到本地生成作品 svg/html（creation_save_artifact
        // 自动入作品；无 Mariposa 桶），icon 同 v5 规则以自身 work 资产充当。
        const bucketlessGeneratedWork = !(typeof body.bucket_id === 'string' && body.bucket_id) && typeof body.work_asset_id === 'string' && !!body.work_asset_id && ['image', 'svg', 'html'].includes(String(body.work_kind));
        if (!bucketlessGeneratedWork) {
          if (typeof body.bucket_id !== 'string' || !body.bucket_id) throw new ContentError(422, 'BUCKET_REQUIRED', 'bucket_ref 必填（指向已有 Mariposa 桶；est 代理侧验证）；本地生成作品可免桶（work_asset_id+work_kind=image|svg|html）');
        }
        if (typeof body.icon_asset_id !== 'string' || !body.icon_asset_id) {
          // v5：免桶作品以自身 work 资产为 icon（同一对象，不复制字节）
          if (!bucketlessGeneratedWork) throw new ContentError(422, 'ICON_REQUIRED', 'icon_asset_id 必填');
          body = { ...body, icon_asset_id: body.work_asset_id };
        }
        const workAsset: string | null = typeof body.work_asset_id === 'string' && body.work_asset_id ? body.work_asset_id : null;
        const workKind: string | null = workAsset !== null && typeof body.work_kind === 'string' ? body.work_kind : null;
        if ((workAsset === null) !== (workKind === null)) throw new ContentError(422, 'WORK_INCONSISTENT', 'work_asset_id 与 work_kind 必须同时为空或同时有效');
        if (workKind !== null && !['image', 'video', 'html', 'svg'].includes(String(workKind))) throw new ContentError(422, 'WORK_KIND_INVALID', 'work_kind 必须是 image|video|html|svg');
        const id = genId('crt');
        const t = now();
        const args: Array<string | null> = [id, actor, typeof body.title === 'string' ? body.title.slice(0, 200) : null, bucketlessGeneratedWork ? null : (typeof body.bucket_service === 'string' ? body.bucket_service : 'mariposa'), bucketlessGeneratedWork ? null : String(body.bucket_id), String(body.icon_asset_id), workAsset, workKind, t, t];
        this.db.prepare('INSERT INTO creations(id, creator_actor, title, bucket_service, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,1)').run(...args);
        return { status: 201, body: this.creationDto(this.creationRow(id)) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/creations\/([^/]+)$/.exec(pathname)) !== null && method === 'PUT') {
    const id = m[1]!;
      const c = cmd('creation', 'update', id);
      return { cmd: c, business: () => {
        const row = this.creationRow(id);
        if (String(row.creator_actor) !== actor) throw new ContentError(403, 'NOT_CREATOR', '默认由创建者操作');
        this.ifMatch(req, Number(row.revision));
        const workAsset = typeof body.work_asset_id === 'string' && body.work_asset_id ? body.work_asset_id : (row.work_asset_id as string | null);
        const workKind = typeof body.work_kind === 'string' ? body.work_kind : (row.work_kind as string | null);
        if ((workAsset === null || workAsset === undefined) !== (workKind === null || workKind === undefined)) throw new ContentError(422, 'WORK_INCONSISTENT', 'work_asset_id 与 work_kind 必须同时为空或同时有效');
        const prevWork = typeof body.work_asset_id === 'string' && body.work_asset_id && body.work_asset_id !== (row.work_asset_id as string | null)
          ? [row.work_asset_id as string] : undefined;
        this.db.prepare('UPDATE creations SET title = COALESCE(?, title), work_asset_id = ?, work_kind = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.title === 'string' ? body.title.slice(0, 200) : null, workAsset ?? null, workKind ?? null, now(), String(row.id));
        return { status: 200, body: { ...this.creationDto(this.creationRow(String(row.id))), ...(prevWork !== undefined ? { previous_asset_ids: prevWork } : {}) } };
      } };
    }
    if ((m = /^\/api\/v1\/content\/creations\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
    const id = m[1]!;
      const c = cmd('creation', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.creationRow(id);
        if (String(row.creator_actor) !== actor) throw new ContentError(403, 'NOT_CREATOR', '默认由创建者操作');
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE creations SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        const crAssets = [row.icon_asset_id, row.work_asset_id].filter((a): a is string => typeof a === 'string' && !!a);
        return { status: 200, body: { id: row.id, deleted: true, asset_ids: crAssets, revision: Number(row.revision) + 1 } };
      } };
    }
    // —— future_notes ——
    if (method === 'POST' && pathname === '/api/v1/content/future-notes') {
      const c = cmd('future_note', 'create', null);
      return { cmd: c, business: () => {
        const text = typeof body.body === 'string' ? body.body : '';
        const assetIds = Array.isArray(body.asset_ids) ? dedupeAssetIds(body.asset_ids.filter((a): a is string => typeof a === 'string')) : [];
        if (text.trim().length === 0 && assetIds.length === 0) throw new ContentError(422, 'EMPTY_NOTE', '留言必须至少有非空正文或一项附件');
        const id = genId('fn');
        const t = now();
        this.db.prepare('INSERT INTO future_notes(id, author_actor, title, body, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)').run(id, actor, typeof body.title === 'string' ? body.title.slice(0, 200) : null, text, t, t);
        for (let i = 0; i < assetIds.length; i++) this.db.prepare('INSERT INTO future_note_assets(note_id, asset_id, position) VALUES (?,?,?)').run(id, assetIds[i], i);
        return { status: 201, body: this.noteDto(this.noteRow(id)) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/future-notes\/([^/]+)$/.exec(pathname)) !== null && method === 'PUT') {
    const id = m[1]!;
      const c = cmd('future_note', 'update', id);
      return { cmd: c, business: () => {
        const row = this.noteRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '默认仅本人管理正文');
        this.ifMatch(req, Number(row.revision));
        const newAssets = Array.isArray(body.asset_ids) ? dedupeAssetIds(body.asset_ids.filter((a): a is string => typeof a === 'string')) : null;
        const previousAssetIds = newAssets !== null
          ? (this.db.prepare('SELECT asset_id FROM future_note_assets WHERE note_id = ?').all(String(row.id)) as Array<{ asset_id: string }>).map((a) => a.asset_id)
          : undefined;
        this.db.prepare('UPDATE future_notes SET title = COALESCE(?, title), body = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
          .run(typeof body.title === 'string' ? body.title.slice(0, 200) : null, typeof body.body === 'string' ? body.body : String(row.body ?? ''), now(), String(row.id));
        if (newAssets !== null) {
          this.db.prepare('DELETE FROM future_note_assets WHERE note_id = ?').run(String(row.id));
          for (let i = 0; i < newAssets.length; i++) this.db.prepare('INSERT INTO future_note_assets(note_id, asset_id, position) VALUES (?,?,?)').run(String(row.id), newAssets[i], i);
        }
        return { status: 200, body: { ...this.noteDto(this.noteRow(String(row.id))), ...(previousAssetIds !== undefined ? { previous_asset_ids: previousAssetIds } : {}) } };
      } };
    }
    if ((m = /^\/api\/v1\/content\/future-notes\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
    const id = m[1]!;
      const c = cmd('future_note', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.noteRow(id);
        if (String(row.author_actor) !== actor) throw new ContentError(403, 'NOT_AUTHOR', '默认仅本人管理正文');
        this.ifMatch(req, Number(row.revision));
        const noteAssets = (this.db.prepare('SELECT asset_id FROM future_note_assets WHERE note_id = ?').all(String(row.id)) as Array<{ asset_id: string }>).map((a) => a.asset_id);
        this.db.prepare('UPDATE future_notes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), String(row.id));
        this.db.prepare('DELETE FROM future_note_assets WHERE note_id = ?').run(String(row.id));
        return { status: 200, body: { id: row.id, deleted: true, asset_ids: noteAssets, revision: Number(row.revision) + 1 } };
      } };
    }
    // —— 对话存档（相册重构 P4）：kind 由明确操作确定（争吵/甜蜜），引用集合由调用方
    //    （E 宿主）按已发布消息校验后提交；content 只保存业务记录，不进 E 库、不复制正文。
    //    幂等由统一回执承担；同集合重复建档以 E 侧操作身份去重（content 不猜"相同"）。
    if (method === 'POST' && pathname === '/api/v1/content/archives') {
      const c = cmd('conversation_archive', 'create', null);
      return { cmd: c, business: () => {
        const kind = body.kind === 'quarrel' || body.kind === 'sweet' ? body.kind : null;
        if (!kind) throw new ContentError(422, 'ARCHIVE_KIND_INVALID', 'kind 必须是 quarrel|sweet（由明确操作确定，不猜测分类）');
        if (typeof body.conversation_id !== 'string' || !body.conversation_id) throw new ContentError(422, 'CONVERSATION_REQUIRED', 'conversation_id 必填');
        const refs = Array.isArray(body.messages) ? body.messages : [];
        if (refs.length === 0) throw new ContentError(422, 'ARCHIVE_EMPTY', '存档必须引用至少一条已发布消息');
        const seen = new Set<string>();
        const items: Array<{ message_id: string; revision: number; sequence: number }> = [];
        for (const r of refs as Array<Record<string, unknown>>) {
          if (!r || typeof r.message_id !== 'string' || !r.message_id || typeof r.revision !== 'number' || typeof r.sequence !== 'number') {
            throw new ContentError(422, 'ARCHIVE_REF_INVALID', '引用必须含 message_id/revision/sequence（由宿主按真实修订生成）');
          }
          if (seen.has(r.message_id)) continue;
          seen.add(r.message_id);
          items.push({ message_id: r.message_id, revision: r.revision, sequence: r.sequence });
        }
        items.sort((a, b) => a.sequence - b.sequence); // 原会话序展示；非连续集合不夹带
        const id = genId('ca');
        const t = now();
        this.db.prepare('INSERT INTO conversation_archives(id, conversation_id, kind, created_by_actor, note, messages_json, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,1)')
          .run(id, String(body.conversation_id), kind, actor, typeof body.note === 'string' ? body.note.slice(0, 2000) : null, JSON.stringify(items), t, t);
        return { status: 201, body: this.archiveDto(this.db.prepare('SELECT * FROM conversation_archives WHERE id = ?').get(id) as Record<string, unknown>) };
      } };
    }
    if ((m = /^\/api\/v1\/content\/archives\/([^/]+)$/.exec(pathname)) !== null && method === 'DELETE') {
      const id = m[1]!;
      const c = cmd('conversation_archive', 'delete', id);
      return { cmd: c, business: () => {
        const row = this.archiveRow(id);
        this.ifMatch(req, Number(row.revision));
        this.db.prepare('UPDATE conversation_archives SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), now(), id);
        return { status: 200, body: { id, removed: true, kind: String(row.kind), revision: Number(row.revision) + 1 } };
      } };
    }
    // —— 携带集合消费（相册重构 P5）：E 在一次滚窗成功投递并确认后调用；把全部
    //    next_once 原子翻回 none。天然幂等（重放=再翻一次无变化），另受统一回执保护。
    if (method === 'POST' && pathname === '/api/v1/content/carry-set/consume-next-once') {
      const c = cmd('album_entry', 'update', 'carry-set');
      return { cmd: c, business: () => {
        // before（ISO，可选）：只消费该时刻之前已设置的 next_once——投递确认晚到/补消费
        // 时，不误吞本次投递之后新设置的携带项（P5 §7.4：旧请求不能消耗后来重设的携带）。
        const before = typeof body.before === 'string' && body.before ? body.before : null;
        const n = (before !== null
          ? this.db.prepare("UPDATE album_entries SET carry_mode = 'none', updated_at = ?, revision = revision + 1 WHERE deleted_at IS NULL AND carry_mode = 'next_once' AND updated_at <= ?")
          : this.db.prepare("UPDATE album_entries SET carry_mode = 'none', updated_at = ?, revision = revision + 1 WHERE deleted_at IS NULL AND carry_mode = 'next_once'")
        ).run(now(), ...(before !== null ? [before] : [])).changes;
        return { status: 200, body: { consumed: n, limit: CARRY_IMAGE_LIMIT } };
      } };
    }
    return null;
  }

  // —— 相册重构 P3：携带集合（03 §7/§8）。合并跨相册去重；always 优先于 next_once ——
  // （同一 asset 多条携带关系只算一张；留言取排序后首条，不合并改写）。

  private carryRows(): Array<{ id: string; kind: string; asset_id: string; carry_mode: string; caption: string | null; meaning: string | null; added_by_actor: string; created_at: string; content_sha256: string | null }> {
    return this.db.prepare(
      "SELECT id, kind, asset_id, carry_mode, caption, meaning, added_by_actor, created_at, content_sha256 FROM album_entries WHERE deleted_at IS NULL AND carry_mode IN ('next_once','always') ORDER BY created_at ASC, id ASC",
    ).all() as Array<{ id: string; kind: string; asset_id: string; carry_mode: string; caption: string | null; meaning: string | null; added_by_actor: string; created_at: string; content_sha256: string | null }>;
  }

  /** 合并有效携带集合（E 滚窗装配的唯一读取口径；条目数=去重后 asset 数，天然 ≤ 上限）。 */
  carrySet(): { limit: number; items: CarrySetItem[] } {
    // R2 残余（复审 2026-11-08）：逐携带关系返回，不再按 asset 预去重——同 asset
    // 多条携带关系的留言都要保留（03 §7.2 留言不得丢弃）；合并去重与 always/next_once
    // 取舍是 E 规划器（planCarryImages）的单一职责，本接口不另立口径。
    return { limit: CARRY_IMAGE_LIMIT, items: this.carryRows().map((r) => ({
      asset_id: r.asset_id, mode: r.carry_mode === 'always' ? 'always' : 'next_once', entry_id: r.id, kind: r.kind,
      caption: r.caption, meaning: r.meaning, added_by: r.added_by_actor as CarrySetItem['added_by'],
      ...(r.content_sha256 ? { content_sha256: r.content_sha256 } : {}),
    })) };
  }

  /** 写入校验：把某条目改为 newMode 后，合并去重集合不得超 CARRY_IMAGE_LIMIT。
   *  RR2（复审 2026-11-09）：去重口径=M 对象身份——content_sha256 已知的行按 hash
   *  归并（同字节不同上传 ID=一张），NULL 行退回 'est:'+asset_id（不因缺身份漏计）。
   *  排除该条目自身现有贡献（改模式/改留言不算新增一张；同字节别名在集合内=不新增）。
   *  F1：selfSha256 无默认值（F1 前漏传调用点被 =null 默认掩掉）；调用方必须显式给出
   *  该条目的行内身份（无则请求补注值，再无才 null=按 asset 身份保守计数）。 */
  private assertCarryWithinLimit(newMode: CarryMode, assetId: string, excludeEntryId: string | null, selfSha256: string | null): void {
    if (newMode === 'none') return;
    const excludeSql = excludeEntryId === null ? "''" : '?';
    const baseArgs = excludeEntryId === null ? [assetId] : [assetId, excludeEntryId];
    const n = (this.db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(content_sha256, 'est:' || asset_id)) n FROM album_entries
       WHERE deleted_at IS NULL AND carry_mode IN ('next_once','always')
         AND asset_id != ?
         AND id != ${excludeSql}`,
    ).get(...baseArgs) as { n: number }).n;
    const aliasInSet = selfSha256 !== null && Boolean(this.db.prepare(
      `SELECT 1 FROM album_entries WHERE deleted_at IS NULL AND carry_mode IN ('next_once','always')
         AND asset_id != ? AND id != ${excludeSql} AND content_sha256 = ? LIMIT 1`,
    ).get(...baseArgs, selfSha256));
    if (!aliasInSet && n >= CARRY_IMAGE_LIMIT) {
      throw new ContentError(422, 'CARRY_LIMIT_EXCEEDED', `携带图片合计已达上限 ${CARRY_IMAGE_LIMIT}/${CARRY_IMAGE_LIMIT}（跨相册按原图去重计数）；请先减选或改回仅收藏`);
    }
  }

  /** P1.1：按对象真实版本给出当前完整去重成员集合的权威快照（与回执分离）。
   *  deleted=true 时集合恒为空且 owner_revision 是删除版本（零集合版本锚）。未知对象 404——
   *  不得把 404 猜成带版本的删除。creation 墓碑保留的 icon/work 字段不算有效引用。
   *  F3：conversation_archive 读墓碑（含删除行），archive 字段带固定消息引用+业务身份。 */
  referenceSnapshot(rt: ResourceType, id: string): { owner_service: 'content'; owner_type: ResourceType; owner_id: string; owner_revision: number; deleted: boolean; asset_ids: string[]; archive?: { kind: string; created_by: string; messages: Array<{ message_id: string; revision: number; sequence: number }> } } {
    switch (rt) {
      case 'post': {
        const row = this.postRow(id);
        const deleted = row.deleted_at != null;
        const assets = deleted ? [] : (this.db.prepare('SELECT asset_id FROM feed_post_assets WHERE post_id = ? ORDER BY position').all(id) as Array<{ asset_id: string }>).map((a) => a.asset_id);
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(row.revision), deleted, asset_ids: dedupeAssetIds(assets) };
      }
      case 'comment': {
        const row = this.commentRow(id);
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(row.revision), deleted: row.deleted_at != null, asset_ids: [] };
      }
      case 'album_entry': {
        const row = this.db.prepare('SELECT * FROM album_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) throw new ContentError(404, 'ENTRY_NOT_FOUND', '相册条目不存在');
        const deleted = row.deleted_at != null;
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(row.revision), deleted, asset_ids: deleted ? [] : [String(row.asset_id)] };
      }
      case 'creation': {
        const row = this.creationRow(id);
        const deleted = row.deleted_at != null;
        const assets = deleted ? [] : [row.icon_asset_id, row.work_asset_id].filter((a): a is string => typeof a === 'string' && !!a);
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(row.revision), deleted, asset_ids: dedupeAssetIds(assets) };
      }
      case 'future_note': {
        const row = this.noteRow(id);
        const deleted = row.deleted_at != null;
        const assets = deleted ? [] : (this.db.prepare('SELECT asset_id FROM future_note_assets WHERE note_id = ? ORDER BY position').all(id) as Array<{ asset_id: string }>).map((a) => a.asset_id);
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(row.revision), deleted, asset_ids: dedupeAssetIds(assets) };
      }
      case 'conversation_archive': {
        // F3（复审 2026-11-09 二轮）：直查含墓碑（同 album_entry 口径）——删除确认必须
        // 读到 deleted=true 的快照（旧实现走 archiveRow 过滤已删行，删除后 404→协调器
        // 永远无法确认、撤销投影永远不触发）。archive 字段供投影 payload：固定消息
        // 引用+业务身份（kind/created_by），不复制正文。
        const rowA = this.db.prepare('SELECT * FROM conversation_archives WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!rowA) throw new ContentError(404, 'ARCHIVE_NOT_FOUND', '存档不存在');
        const messages = JSON.parse(String(rowA.messages_json)) as Array<{ message_id: string; revision: number; sequence: number }>;
        return { owner_service: 'content', owner_type: rt, owner_id: id, owner_revision: Number(rowA.revision), deleted: rowA.deleted_at != null, asset_ids: [], archive: { kind: String(rowA.kind), created_by: String(rowA.created_by_actor), messages } };
      }
    }
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
    try { const value = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw Error('shape'); return value; } catch { throw new ContentError(400, 'CURSOR_INVALID', '游标非法'); }
  }

  private async dispatch(route: string, actor: Actor, url: URL, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<{ status: number; body: unknown } | undefined> {
    const now = () => new Date().toISOString();
    void res;
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // —— P1 统一写入口：全部 15 条写路由共用（回执解析→新操作校验→同事务提交） ——
    const write = this.matchWrite(actor, method, pathname, body, req);
    if (write) return this.runWrite(actor, header(req, 'idempotency-key'), write.cmd, write.business);

    // —— P1 宿主同操作回查：不执行，只解析回执（Host 据此决定重放或准备新写） ——
    if (route === 'POST /api/v1/content/operations/resolve') {
      const m = body.method, p = typeof body.path === 'string' ? body.path : '';
      if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE') return { status: 400, body: { error: { code: 'bad_resolve_request', message: 'method/path 必填（写操作）' } } };
      const fakeReq = { headers: { 'if-match': typeof body.if_match === 'string' ? body.if_match : '', 'idempotency-key': typeof body.idempotency_key === 'string' ? body.idempotency_key : '' } } as unknown as IncomingMessage;
      const match = this.matchWrite(actor, m, p, (body.body && typeof body.body === 'object' && !Array.isArray(body.body)) ? body.body as Record<string, unknown> : {}, fakeReq);
      if (!match) return { status: 400, body: { error: { code: 'not_a_write_route', message: '该路径不是写路由' } } };
      if (typeof body.idempotency_key !== 'string' || !body.idempotency_key) return { status: 400, body: { error: { code: 'missing_idempotency_key', message: '写请求必须带 Idempotency-Key' } } };
      const resolved = this.resolveReceipt(actor, body.idempotency_key, match.cmd);
      if (resolved.outcome === 'replay') return { status: 200, body: { outcome: 'replay', status: resolved.status, body: resolved.body } };
      if (resolved.outcome === 'new') return { status: 200, body: { outcome: 'new' } };
      return { status: 200, body: { outcome: resolved.outcome, status: resolved.status, body: resolved.body } };
    }

    // —— P1.1 权威快照（宿主确认映射与存量对账共用；404=未知对象，不是删除证据） ——
    let m2 = /^GET \/api\/v1\/content\/references\/([^/]+)\/([^/]+)$/.exec(route);
    if (m2) {
      const rt = decodeURIComponent(m2[1]!) as ResourceType;
      if (!(CONTENT_RESOURCE_TYPES as readonly string[]).includes(rt)) return { status: 400, body: { error: { code: 'bad_resource_type', message: `resource_type 必须是 ${CONTENT_RESOURCE_TYPES.join('|')}` } } };
      return { status: 200, body: this.referenceSnapshot(rt, decodeURIComponent(m2[2]!)) };
    }

    // —— 朋友圈：posts / comments（读） ——
    if (route === 'GET /api/v1/content/posts') {
      const limit = this.limitOf(url);
      const cursor = this.decodeCursor(url.searchParams.get('cursor'));
      const presentation = url.searchParams.get('presentation');
      const rows = this.db.prepare(`SELECT * FROM feed_posts WHERE deleted_at IS NULL ${presentation === 'post' || presentation === 'letter' ? 'AND presentation = ?' : ''} ORDER BY published_at DESC, id DESC`).all(...(presentation === 'post' || presentation === 'letter' ? [presentation] : [])) as Array<Record<string, unknown>>;
      const scope = JSON.stringify(['posts', presentation ?? null]);
      if (cursor && (cursor.scope !== scope || !cursor.after || !cursor.id)) throw new ContentError(400, 'CURSOR_INVALID', '游标与查询不匹配，请重新读取首页');
      const after = cursor?.after ?? null;
      const filtered = after !== null ? rows.filter((r) => String(r.published_at) < after || (String(r.published_at) === after && String(r.id) < (cursor!.id ?? ''))) : rows;
      const page = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      return { status: 200, body: { items: page.map((r) => this.postDto(r)), next_cursor: hasMore && page.length > 0 ? Buffer.from(JSON.stringify({ scope, after: String(page[page.length - 1]!.published_at), id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: hasMore } };
    }
    m2 = /^GET \/api\/v1\/content\/posts\/([^/]+)$/.exec(route);
    if (m2) return { status: 200, body: this.postDto(this.postRow(String(m2[1])), true) };
    m2 = /^GET \/api\/v1\/content\/posts\/([^/]+)\/comments$/.exec(route);
    if (m2) {
      this.postRow(String(m2[1])); // 帖子必须存在（含已删占位——评论作者仍可查看自己的评论）
      const limit = this.limitOf(url);
      const rows = this.db.prepare('SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC').all(String(m2[1])) as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.commentDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }

    // —— 对话存档（相册重构 P4，读） ——
    if (route === 'GET /api/v1/content/archives') {
      const limit = this.limitOf(url);
      const kind = url.searchParams.get('kind');
      const conversationId = url.searchParams.get('conversation_id');
      let rows = this.db.prepare(`SELECT * FROM conversation_archives WHERE deleted_at IS NULL ${kind === 'quarrel' || kind === 'sweet' ? 'AND kind = ?' : ''} ${conversationId ? 'AND conversation_id = ?' : ''} ORDER BY created_at DESC, id DESC`).all(...(kind === 'quarrel' || kind === 'sweet' ? [kind] : []), ...(conversationId ? [conversationId] : [])) as Array<Record<string, unknown>>;
      const cursor = this.decodeCursor(url.searchParams.get('cursor'));
      const scope = JSON.stringify(['archives', kind ?? null, conversationId ?? null]);
      if (cursor && (cursor.scope !== scope || !cursor.after || !cursor.id)) throw new ContentError(400, 'CURSOR_INVALID', '游标与查询不匹配，请重新读取首页');
      if (cursor) rows = rows.filter(r => String(r.created_at) < cursor.after! || (String(r.created_at) === cursor.after && String(r.id) < cursor.id!));
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.archiveDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ scope, after: String(page[page.length - 1]!.created_at), id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }
    m2 = /^GET \/api\/v1\/content\/archives\/([^/]+)$/.exec(route);
    if (m2) return { status: 200, body: this.archiveDto(this.archiveRow(decodeURIComponent(m2[1]!))) };

    // —— 携带集合（相册重构 P3/P5，读：E 滚窗装配的唯一读取口径） ——
    if (route === 'GET /api/v1/content/carry-set') {
      return { status: 200, body: this.carrySet() };
    }

    // —— 相册（§5，读） ——
    if (route === 'GET /api/v1/content/albums') {
      const assetId = url.searchParams.get('asset_id');
      const albums = CONTENT_ALBUMS.filter(a => !assetId || Boolean(this.db.prepare('SELECT 1 FROM album_entries WHERE kind=? AND asset_id=? AND deleted_at IS NULL LIMIT 1').get(a.album, assetId)));
      return { status: 200, body: { albums } };
    }
    m2 = /^GET \/api\/v1\/content\/albums\/([^/]+)\/entries$/.exec(route);
    if (m2) {
      const kind = m2[1]!;
      if (!CONTENT_ALBUMS.some(album => album.album === kind)) throw new ContentError(404, 'ALBUM_NOT_FOUND', '相册不存在');
      const limit = this.limitOf(url);
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const ss = url.searchParams.get('source_service');
      const sk = url.searchParams.get('source_kind');
      const sid = url.searchParams.get('source_id');
      let rows = this.db.prepare('SELECT * FROM album_entries WHERE kind = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC').all(kind) as Array<Record<string, unknown>>;
      if (ss && sk && sid) {
        // §5 反查：our_words 专道得到真实 source_id → 引用反查截图归档（已删条目排除）
        const refIds = new Set((this.db.prepare('SELECT entry_id FROM album_entry_refs WHERE service = ? AND kind = ? AND source_id = ?').all(ss, sk, sid) as Array<{ entry_id: string }>).map((r) => r.entry_id));
        rows = rows.filter((r) => refIds.has(String(r.id)));
      }
      if (q.length > 0) rows = rows.filter((r) => `${r.caption ?? ''} ${r.meaning ?? ''}`.toLowerCase().includes(q));
      const cursor = this.decodeCursor(url.searchParams.get('cursor'));
      const scope = JSON.stringify([kind, q, ss, sk, sid]);
      if (cursor && (cursor.scope !== scope || !cursor.after || !cursor.id)) throw new ContentError(400, 'CURSOR_INVALID', '游标与相册或查询不匹配，请重新读取首页');
      if (cursor) rows = rows.filter(r => String(r.created_at) < cursor.after! || (String(r.created_at) === cursor.after && String(r.id) < cursor.id!));
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.albumDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ scope, after: String(page.at(-1)!.created_at), id: String(page.at(-1)!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }

    // —— 纪念作品（§6，读） ——
    if (route === 'GET /api/v1/content/creations') {
      const limit = this.limitOf(url);
      // ALB-05④（审计 2026-11-08）：按资产反查作品（icon 或 work 引用即可读）——
      // media_view 的作品读取授权分支用；不另建端点。
      const assetId = url.searchParams.get('asset_id');
      const rows = (assetId
        ? this.db.prepare('SELECT * FROM creations WHERE deleted_at IS NULL AND (icon_asset_id = ? OR work_asset_id = ?) ORDER BY created_at DESC, id DESC').all(assetId, assetId)
        : this.db.prepare('SELECT * FROM creations WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC').all()) as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.creationDto(r)), next_cursor: null, has_more: rows.length > limit } };
    }
    m2 = /^GET \/api\/v1\/content\/creations\/([^/]+)$/.exec(route);
    if (m2) return { status: 200, body: this.creationDto(this.creationRow(m2[1]!)) };

    // —— 未来留言正文（§8.1，读） ——
    if (route === 'GET /api/v1/content/future-notes') {
      const limit = this.limitOf(url);
      const rows = this.db.prepare('SELECT * FROM future_notes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC').all() as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      return { status: 200, body: { items: page.map((r) => this.noteDto(r)), next_cursor: rows.length > limit && page.length > 0 ? Buffer.from(JSON.stringify({ id: String(page[page.length - 1]!.id) })).toString('base64url') : null, has_more: rows.length > limit } };
    }
    m2 = /^GET \/api\/v1\/content\/future-notes\/([^/]+)$/.exec(route);
    if (m2) return { status: 200, body: this.noteDto(this.noteRow(m2[1]!)) };
    void now;
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
  private archiveRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM conversation_archives WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'ARCHIVE_NOT_FOUND', '存档不存在');
    return row;
  }

  private archiveDto(r: Record<string, unknown>): Record<string, unknown> {
    return { id: r.id, conversation_id: r.conversation_id, kind: r.kind, created_by: r.created_by_actor, note: r.note, messages: JSON.parse(String(r.messages_json)) as Array<{ message_id: string; revision: number; sequence: number }>, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, deleted: r.deleted_at != null };
  }

  private albumRow(id: string): Record<string, unknown> {
    // 写路径只接纳有效行（墓碑=不存在）；快照读取走 referenceSnapshot 直查
    const row = this.db.prepare('SELECT * FROM album_entries WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'ENTRY_NOT_FOUND', '相册条目不存在');
    return row;
  }
  private albumDto(r: Record<string, unknown>): Record<string, unknown> {
    const refs = this.db.prepare('SELECT service, kind, source_id FROM album_entry_refs WHERE entry_id = ?').all(String(r.id)) as Array<Record<string, string>>;
    return { id: r.id, kind: r.kind, asset_id: r.asset_id, added_by: r.added_by_actor, caption: r.caption, meaning: r.meaning, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, carry_mode: (r.carry_mode as string) ?? 'none', refs };
  }
  private creationRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM creations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ContentError(404, 'CREATION_NOT_FOUND', '作品记录不存在');
    return row;
  }
  private creationDto(r: Record<string, unknown>): Record<string, unknown> {
    return { id: r.id, creator: r.creator_actor, title: r.title, bucket_ref: r.bucket_id != null ? { service: r.bucket_service, kind: 'bucket', id: r.bucket_id } : null, icon_asset_id: r.icon_asset_id, work_asset_id: r.work_asset_id ?? null, work_kind: r.work_kind ?? null, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision, deleted: r.deleted_at != null };
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
function dedupeAssetIds(ids: string[]): string[] { return [...new Set(ids)]; }

/** body.carry_mode 解析：缺席/undefined=null（不改变）；非法值 422。 */
function parseCarryMode(v: unknown): CarryMode | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !(CARRY_MODES as readonly string[]).includes(v)) {
    throw new ContentError(422, 'CARRY_MODE_INVALID', `carry_mode 必须是 ${CARRY_MODES.join('|')}`);
  }
  return v as CarryMode;
}

/** 旧回执响应形状→资源类型推断（兼容解析的“类型/目标一致”证据；判不出=null）。 */
function inferResourceTypeFromResponse(body: Record<string, unknown>): ResourceType | null {
  if (typeof body.removed === 'boolean') return 'album_entry';
  if (body.conversation_id !== undefined && body.messages !== undefined && body.kind !== undefined) return 'conversation_archive';
  if (body.bucket_ref !== undefined || body.icon_asset_id !== undefined) return 'creation';
  if (body.post_id !== undefined) return 'comment';
  if (body.presentation !== undefined) return 'post';
  if (body.refs !== undefined && body.kind !== undefined) return 'album_entry';
  if (body.author !== undefined && body.asset_ids !== undefined && typeof body.deleted === 'boolean') return 'future_note';
  return null;
}

export function sha256ish(s: string): string { return simpleHash(s); }
