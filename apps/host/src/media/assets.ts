// ESTOMAGO_CHAT_EXEC_V1 §03.4-03.7（WP3/M1）：est 媒体服务——统一管理资产文件、消息附件引用与
// 内容后端引用保护。不另起进程；文件进 mediaDir（paths.mediaDir），DB 记元数据与引用。
// 原则：available 必须完成真实字节校验与原子写盘（临时文件→rename）；失败只清本次临时文件；
// URL 导入的连接目标受控（https-only、拒内网/环回/链路本地/云元数据、逐跳重查、字节/时长上限、
// 魔数校验）——不让"导一张图"变成任意内网请求（§7）。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import type { Config } from '../config/schema.ts';

export type IngestPurpose = 'chat_image' | 'chat_sticker' | 'chat_voice' | 'creation_icon' | 'creation_work' | 'derived_view';

// 用途 → 格式白名单（§5.1：两套小名单；不是按扩展名信任）
const PURPOSE_MIMES: Record<IngestPurpose, string[]> = {
  chat_image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  chat_sticker: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  chat_voice: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4'],
  creation_icon: ['image/svg+xml', 'image/png', 'image/webp'],
  creation_work: ['image/svg+xml', 'text/html', 'video/mp4', 'image/png', 'image/jpeg', 'image/webp'],
  // derived_view（2026-10-24，RE-05）：oído 测量图等宿主派生图工件（origin=generated+origin_service 标来源）
  derived_view: ['image/png'],
};

// 魔数/文件头校验：不按扩展名或 Content-Type 冒充（§7.5、MEDIA-02）
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'; // EBML（webm 音频容器）
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  if (b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (b.length >= 4 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4'; // ftyp（含 mp4 音频）
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x74 && b[2] === 0x79 && b[3] === 0x70) return 'video/mp4';
  const head = Buffer.from(b.slice(0, 512)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';
  return null;
}

export class MediaError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type StoredAsset = {
  id: string; state: string; mime_type: string; byte_size: number; content_sha256: string;
  origin: string; origin_service: string | null; origin_ref: string | null;
  ingest_purpose: string; created_by: string; created_at: string; duplicate: boolean;
};

export class MediaService {
  private db: Db;
  private mediaDir: string;
  private config: Config;
  constructor(db: Db, mediaDir: string, config: Config) {
    this.db = db;
    this.mediaDir = mediaDir;
    this.config = config;
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  private purposeLimitBytes(purpose: IngestPurpose): number {
    const m = this.config.media;
    if (purpose === 'chat_image' || purpose === 'chat_sticker') return m.max_image_bytes;
    if (purpose === 'chat_voice') return m.max_audio_bytes;
    if (purpose === 'creation_icon' || purpose === 'creation_work') return Math.max(m.max_code_artifact_bytes, m.max_video_bytes, m.max_image_bytes);
    if (purpose === 'derived_view') return m.max_image_bytes;
    return 0;
  }

  /** 幂等保存：同 creation_operation_id 返回既有资产；成功操作不重复建图。 */
  async saveBuffer(opts: {
    bytes: Uint8Array; purpose: IngestPurpose; operationId: string; createdBy: string;
    origin: 'upload' | 'import' | 'generated' | 'service'; originService?: string | null; originRef?: string | null;
    declaredMime?: string | null;
  }): Promise<StoredAsset> {
    if (opts.bytes.byteLength === 0) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, '空文件');
    const limit = this.purposeLimitBytes(opts.purpose);
    if (opts.bytes.byteLength > limit) throw new MediaError('ASSET_TOO_LARGE', 413, `超过用途上限 ${limit} 字节`);
    const sha = sha256Hex(Buffer.from(opts.bytes));
    // §5 幂等顺序：同键同指纹=原回执；同键不同字节=IDEMPOTENCY_CONFLICT（不无声复用另一结果）
    const existing = this.db.prepare('SELECT id, content_sha256 FROM media_assets WHERE creation_operation_id = ?').get(opts.operationId) as { id: string; content_sha256: string } | undefined;
    if (existing) {
      if (existing.content_sha256 !== sha) throw new MediaError('IDEMPOTENCY_CONFLICT', 409, '同幂等键对应不同内容');
      return this.getAsset(existing.id);
    }
    const sniffed = sniffMime(opts.bytes);
    if (sniffed === null) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, '无法识别的文件类型（魔数校验失败）');
    if (!PURPOSE_MIMES[opts.purpose].includes(sniffed)) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, `用途 ${opts.purpose} 不接受 ${sniffed}`);
    const id = genId('asset');
    const ext = sniffed.split('/')[1] === 'svg+xml' ? 'svg' : sniffed.split('/')[1] === 'plain' ? 'txt' : sniffed.split('/')[1];
    const storageKey = path.join(sha.slice(0, 2), `${sha}.${ext}`);
    const absDir = path.join(this.mediaDir, path.dirname(storageKey));
    const absPath = path.join(this.mediaDir, storageKey);
    const nowIso = new Date().toISOString();
    let duplicate = false;
    try {
      fs.mkdirSync(absDir, { recursive: true });
      if (!fs.existsSync(absPath)) {
        const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, opts.bytes); // 原子提交：临时文件写完再改名
        fs.renameSync(tmp, absPath);
      } else duplicate = true; // 内容去重：同 hash 只存一份字节；不同 asset 身份仍各自成立（§3.1）
      this.db.prepare(
        `INSERT INTO media_assets(id, creation_operation_id, state, mime_type, byte_size, content_sha256, storage_key,
           width, height, duration_ms, origin, origin_service, origin_ref, created_by, ingest_purpose, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?)`,
      ).run(id, opts.operationId, 'available', sniffed, opts.bytes.byteLength, sha, storageKey, opts.origin, opts.originService ?? null, opts.originRef ?? null, opts.createdBy, opts.purpose, nowIso, nowIso);
    } catch (err) {
      try { for (const f of fs.readdirSync(absDir)) { if (f.includes('.tmp-')) fs.unlinkSync(path.join(absDir, f)); } } catch { /* 清理失败不掩盖 */ }
      if (err instanceof MediaError) throw err;
      throw new MediaError('ASSET_STORAGE_UNAVAILABLE', 500, '媒体目录写入失败');
    }
    return { ...this.getAsset(id), duplicate };
  }

  getAsset(id: string): StoredAsset {
    const row = this.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new MediaError('ASSET_NOT_FOUND', 404, '资产不存在');
    return {
      id: row.id as string, state: row.state as string, mime_type: row.mime_type as string,
      byte_size: row.byte_size as number, content_sha256: row.content_sha256 as string,
      origin: row.origin as string, origin_service: (row.origin_service as string | null) ?? null,
      origin_ref: (row.origin_ref as string | null) ?? null,
      ingest_purpose: row.ingest_purpose as string, created_by: row.created_by as string,
      created_at: row.created_at as string, duplicate: false,
    };
  }

  /** 授权读取字节（storage_key 由宿主管理，不暴露绝对路径）。 */
  readContent(id: string): { bytes: Buffer; mime: string } {
    const row = this.db.prepare('SELECT storage_key, mime_type, state FROM media_assets WHERE id = ?').get(id) as { storage_key: string; mime_type: string; state: string } | undefined;
    if (!row) throw new MediaError('ASSET_NOT_FOUND', 404, '资产不存在');
    if (row.state !== 'available') throw new MediaError('ASSET_NOT_READY', 409, `资产状态 ${row.state}`);
    const abs = path.join(this.mediaDir, row.storage_key);
    if (!fs.existsSync(abs)) throw new MediaError('ASSET_STORAGE_UNAVAILABLE', 500, '资产文件缺失');
    return { bytes: fs.readFileSync(abs), mime: row.mime_type };
  }

  /** §7 URL 导入：连接目标受控。逐跳重查（≤max_redirects）；私网/环回/链路本地/云元数据全拒。 */
  async importFromUrl(opts: { sourceUrl: string; operationId: string; createdBy: string }): Promise<StoredAsset> {
    const existing = this.db.prepare('SELECT id FROM media_assets WHERE creation_operation_id = ?').get(opts.operationId) as { id: string } | undefined;
    if (existing) return this.getAsset(existing.id);
    let url: URL;
    try { url = new URL(opts.sourceUrl); } catch { throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, 'URL 非法'); }
    let current = url;
    for (let hop = 0; hop <= this.config.media.max_redirects; hop++) {
      const checked = await this.guardTarget(current);
      const r = await this.fetchGuarded(checked.url);
      if (r.kind === 'redirect') {
        current = r.next; // 逐跳回到 guardTarget 重查（§7.2：每次跳转重新检查，不能只查最初字符串）
        continue;
      }
      const sniffed = sniffMime(r.bytes);
      if (sniffed === null || !sniffed.startsWith('image/')) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, '目标不是图片（拒绝 HTML 错误页冒充）');
      return this.saveBuffer({ bytes: r.bytes, purpose: 'chat_image', operationId: opts.operationId, createdBy: opts.createdBy, origin: 'import', originRef: opts.sourceUrl });
    }
    throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '重定向次数超上限');
  }

  // —— §7 目标校验：协议 https-only；无用户名密码；主机非 localhost/内网/链路本地/元数据；DNS 解析全公网 ——
  private async guardTarget(u: URL): Promise<{ url: URL; hostForLookup: string }> {
    if (u.protocol !== 'https:') throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '只接受 https 导入');
    if (u.username !== '' || u.password !== '') throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '拒绝带凭据的 URL');
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '拒绝本地/内部主机名');
    if (net.isIP(host)) {
      if (!isPublicIp(host)) throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '拒绝非公网地址');
      return { url: u, hostForLookup: host };
    }
    const addrs = await dns.promises.lookup(host, { all: true }).catch(() => { throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '域名无法解析'); });
    for (const a of addrs) if (!isPublicIp(a.address)) throw new MediaError('ASSET_SOURCE_NOT_ALLOWED', 422, '域名解析到非公网地址');
    return { url: u, hostForLookup: host };
  }

  private fetchGuarded(u: URL): Promise<{ kind: 'bytes'; bytes: Buffer } | { kind: 'redirect'; next: URL }> {
    const timeoutMs = this.config.media.import_timeout_ms;
    const maxBytes = this.config.media.max_image_bytes;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new MediaError('ASSET_IMPORT_FAILED', 504, '导入超时')); }, timeoutMs);
      // 连接层 lookup 锁定目标：解析结果必须全公网，且与 guardTarget 校验一致（§7.3 不做"先检查后另解析"）
      const guardedLookup: dns.LookupOptions & ((h: string, o: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void) = Object.assign(
        (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
          dns.promises.lookup(hostname, { all: true, family: options.family }).then((addrs) => {
            for (const a of addrs) if (!isPublicIp(a.address)) { cb(new Error('EACCES-private-target') as NodeJS.ErrnoException, []); return; }
            cb(null, addrs as dns.LookupAddress[]);
          }).catch((err) => cb(err as NodeJS.ErrnoException, []));
        },
        { all: true },
      );
      const req = https.request(u, { method: 'GET', lookup: guardedLookup as never, headers: { 'user-agent': 'estomago-media-import/1' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          clearTimeout(timer);
          res.resume();
          resolve({ kind: 'redirect', next: new URL(res.headers.location, u) }); // 逐跳交回外层 guardTarget 重查（§7.2）
          return;
        }
        if (status < 200 || status >= 300) { clearTimeout(timer); res.resume(); reject(new MediaError('ASSET_IMPORT_FAILED', 502, `来源返回 ${status}`)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { clearTimeout(timer); req.destroy(); reject(new MediaError('ASSET_TOO_LARGE', 413, '导入流超过上限')); return; }
          chunks.push(c);
        });
        res.on('end', () => { clearTimeout(timer); resolve({ kind: 'bytes', bytes: Buffer.concat(chunks) }); });
        res.on('error', () => { clearTimeout(timer); reject(new MediaError('ASSET_IMPORT_FAILED', 502, '下载中断')); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(new MediaError('ASSET_IMPORT_FAILED', 502, String((err as Error).message ?? err).slice(0, 80))); });
      req.end();
    });
  }

  // —— §4.3/§10.2 引用登记：protected pin → committed；解除 released ——
  registerReference(opts: { assetId: string; ownerService: string; ownerType: string; ownerId: string; ownerRevision?: number | null; operationId: string }): { referenceId: string; revision: number; state: string } {
    this.getAsset(opts.assetId); // ASSET_NOT_FOUND 如实
    const existing = this.db.prepare(
      'SELECT id, revision, state FROM asset_external_refs WHERE asset_id = ? AND owner_service = ? AND owner_type = ? AND owner_id = ? AND operation_id = ?',
    ).get(opts.assetId, opts.ownerService, opts.ownerType, opts.ownerId, opts.operationId) as { id: string; revision: number; state: string } | undefined;
    if (existing) return { referenceId: existing.id, revision: existing.revision, state: existing.state }; // 幂等
    const id = genId('aref');
    const nowIso = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO asset_external_refs(id, asset_id, owner_service, owner_type, owner_id, owner_revision, revision, operation_id, state, created_at)
       VALUES (?,?,?,?,?,?,1,?, 'protected', ?)`,
    ).run(id, opts.assetId, opts.ownerService, opts.ownerType, opts.ownerId, opts.ownerRevision ?? null, opts.operationId, nowIso);
    return { referenceId: id, revision: 1, state: 'protected' };
  }

  confirmReference(referenceId: string): { referenceId: string; revision: number; state: string } {
    const row = this.db.prepare('SELECT id, revision, state FROM asset_external_refs WHERE id = ?').get(referenceId) as { id: string; revision: number; state: string } | undefined;
    if (!row) throw new MediaError('ASSET_NOT_FOUND', 404, '引用不存在');
    if (row.state === 'committed') return { referenceId: row.id, revision: row.revision, state: row.state };
    this.db.prepare("UPDATE asset_external_refs SET state = 'committed' WHERE id = ?").run(referenceId);
    return { referenceId, revision: row.revision, state: 'committed' };
  }

  /** 解除引用（幂等键=operationId；If-Match 校验引用自身 revision）。历史消息附件引用不在此表，不受此操作影响。 */
  releaseReference(opts: { referenceId: string; expectedRevision: number; operationId: string }): { referenceId: string; revision: number; state: string } {
    const row = this.db.prepare('SELECT id, revision, state FROM asset_external_refs WHERE id = ?').get(opts.referenceId) as { id: string; revision: number; state: string } | undefined;
    if (!row) throw new MediaError('ASSET_NOT_FOUND', 404, '引用不存在');
    if (row.revision !== opts.expectedRevision) throw new MediaError('REVISION_CONFLICT', 412, '引用 revision 不匹配（If-Match）');
    if (row.state === 'released') return { referenceId: row.id, revision: row.revision, state: 'released' }; // 幂等重放
    this.db.prepare("UPDATE asset_external_refs SET state = 'released', revision = revision + 1, released_at = ? WHERE id = ?").run(new Date().toISOString(), opts.referenceId);
    return { referenceId: opts.referenceId, revision: row.revision + 1, state: 'released' };
  }

  /** 有效引用查询（§4.4）：历史消息附件 ∪ protected/committed 外部引用。删除守卫的唯一依据。 */
  isAssetReferenced(assetId: string): { referenced: boolean; by_message_revisions: number; by_external_refs: number } {
    const byMsg = (this.db.prepare('SELECT COUNT(*) n FROM message_attachments WHERE asset_id = ?').get(assetId) as { n: number }).n;
    const byRef = (this.db.prepare("SELECT COUNT(*) n FROM asset_external_refs WHERE asset_id = ? AND state IN ('protected','committed')").get(assetId) as { n: number }).n;
    return { referenced: byMsg > 0 || byRef > 0, by_message_revisions: byMsg, by_external_refs: byRef };
  }

  /** R6′（2026-10-23，她批 R6P 方案）：源资产删除原语——state→missing（引用守卫外的显式删除）。
   *  若该语音有 oído 导入回执，同事务写删除传播意图（远端物理清理由独立重试循环收口，
   *  404=已删幂等成功；失败退避下跳再试；重启恢复=表即状态）。解除单条分析引用不删数据
   *  ——那只是删 oido_source_bindings 行（撤权不毁原声，其他会话可共享同一远端资产）。 */
  markAssetMissing(assetId: string): void {
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare("UPDATE media_assets SET state = 'missing', updated_at = ? WHERE id = ?").run(now, assetId);
      const receipt = this.db.prepare('SELECT oido_audio_id FROM oido_ingest_receipts WHERE est_asset_id = ?').get(assetId) as { oido_audio_id: string } | undefined;
      if (receipt) {
        this.db.prepare(`INSERT INTO oido_delete_intents(est_asset_id,oido_audio_id,attempts,last_error,created_at,updated_at) VALUES (?,?,0,NULL,?,?)
          ON CONFLICT(est_asset_id) DO UPDATE SET updated_at=excluded.updated_at`).run(assetId, receipt.oido_audio_id, now, now);
      }
    });
  }

  /** 消息附件绑定：按 (message, revision, position) 固定；新修订复制沿用（§3.3 编辑保留原附件）。 */
  bindMessageAttachments(messageId: string, revision: number, attachments: Array<{ asset_id: string; presentation: 'image' | 'sticker' | 'voice'; caption?: string | null }>): void {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i]!;
      this.db.prepare(
        `INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at)
         VALUES (?,?,?,?,?,?,NULL,NULL,?)`,
      ).run(messageId, revision, i, a.asset_id, a.presentation, a.caption ?? null, nowIso);
    }
  }

  listMessageAttachments(messageId: string, revision: number): Array<{ asset_id: string; presentation: string; caption: string | null; derived_text: string | null; derived_source: string | null }> {
    return this.db.prepare('SELECT asset_id, presentation, caption, derived_text, derived_source FROM message_attachments WHERE message_id = ? AND revision = ? ORDER BY position').all(messageId, revision) as Array<{ asset_id: string; presentation: string; caption: string | null; derived_text: string | null; derived_source: string | null }>;
  }

  /** §03.6：按真实修订投影（content+attachments）——supervisor 全部装配入口共用。 */
  projectForRevision(messageId: string, revision: number): { content: string; attachments: Array<{ asset_id: string; presentation: string; caption: string | null; derived_text: string | null; derived_source: string | null }> } {
    const rev = this.db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = ?').get(messageId, revision) as { content: string } | undefined;
    if (!rev) throw new MediaError('ASSET_NOT_FOUND', 404, `修订不存在 ${messageId}@${revision}`);
    return { content: rev.content, attachments: this.listMessageAttachments(messageId, revision) };
  }

  /** 校验发送附件：存在/available/格式匹配 presentation（§5.2 先全量校验再入事务）。 */
  validateForSend(items: Array<{ asset_id: string; presentation: string }>): void {
    for (const it of items) {
      const a = this.getAsset(it.asset_id);
      if (a.state !== 'available') throw new MediaError('ASSET_NOT_READY', 409, `资产 ${it.asset_id} 状态 ${a.state}`);
      const wanted = it.presentation === 'voice' ? PURPOSE_MIMES.chat_voice : PURPOSE_MIMES.chat_image;
      if (!wanted.includes(a.mime_type)) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, `presentation=${it.presentation} 不接受 ${a.mime_type}`);
    }
  }
}

/** 公网判定：拒环回/私网/链路本地/唯一本地/云元数据（§7.2）。 */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    const [a, b] = [o[0]!, o[1]!];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // 链路本地含云元数据 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // 组播/保留
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return false;
    if (/^fe[89ab]/.test(low) || low.startsWith('fc') || low.startsWith('fd')) return false; // 链路本地/ULA
    if (low.startsWith('ff')) return false;
    if (low.startsWith('::ffff:')) return isPublicIp(low.slice(7)); // IPv4-mapped
    return true;
  }
  return false;
}
