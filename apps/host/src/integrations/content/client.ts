// ESTOMAGO_CHAT_EXEC_V1 §06.1（WP5）：est→content 薄代理——唯一通道。
// 浏览器/模型都经 est 认证后由适配器调 content（loopback+服务凭据+宿主派生 actor）；
// content 不反调 est；凭据值只在 transport 头读取处，不落日志/DB。
// 资产校验在 est 侧（媒体服务正本），content 只收 asset_id 引用。
// P1（四仓合并审计 20261106，F06/F07）：写路径改经 coordinator（先解析原操作、
// HTTP 前持久意图+pin、成功后按权威快照确认映射）；本文件只保留纯转发与两个
// 只读面：同操作回查（resolve）与当前引用快照（references）。
import fs from 'node:fs';
import path from 'node:path';

export type ContentClient = {
  baseUrl: string;
  token: string;
};

/** 从 stateRoot 读取 content 服务凭据（由 content 进程启动时生成）。 */
export function contentClientFor(stateRoot: string, port: number, enabled: boolean): ContentClient | null {
  if (!enabled) return null;
  const tokenFile = path.join(stateRoot, 'content', 'service.token');
  if (!fs.existsSync(tokenFile)) return null;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) return null;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

/** 转发请求到 content——est 唯一通道。actor 从可信上下文派生，不从请求体。
 *  RR4-F4：可选 signal 与每次请求超时合并（取消立即生效，不必等当页超时）。 */
export async function contentForward(client: ContentClient, opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // /api/v1/content/...
  actor: 'qiaosheng' | 'jiaming';
  body?: unknown;
  headers?: Record<string, string>; // Idempotency-Key / If-Match 透传
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${client.baseUrl}${opts.path}`, {
    method: opts.method,
    headers: {
      'Authorization': `Bearer ${client.token}`,
      'X-Actor': opts.actor,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 5000), opts.signal]) : AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** RR4-F4（复审 2026-11-11）：content 列表**全量分页读取器**——archives/media 的
 *  集合读取共用同一实现，取消/游标停滞/非 200 语义只在此定义一次：
 *  - 结束条件唯一=next_cursor=null（批次大小只控制单次请求工作量，不限制业务范围）；
 *  - 每页发起前检查 signal（取消不再继续读后页），HTTP 与调用方取消合并；
 *  - 游标回环/非 200/网络异常=分页失败（'failed'，调用方按各自错误语义映射），不装全量；
 *  - 调用方传入 buildPath(cursor) 定位列表端点（items/next_cursor 形状各列表一致）。 */
export async function readAllContentPages<T>(client: ContentClient, o: {
  buildPath: (cursor: string | null) => string;
  actor?: 'qiaosheng' | 'jiaming';
  signal?: AbortSignal;
}): Promise<{ ok: true; items: T[] } | { ok: false; reason: 'cancelled' | 'failed'; status?: number }> {
  const items: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    if (o.signal?.aborted) return { ok: false, reason: 'cancelled' };
    let res: { status: number; body: unknown };
    try {
      res = await contentForward(client, { method: 'GET', path: o.buildPath(cursor), actor: o.actor ?? 'jiaming', signal: o.signal });
    } catch {
      if (o.signal?.aborted) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'failed' };
    }
    if (o.signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (res.status !== 200) return { ok: false, reason: 'failed', status: res.status };
    const body = res.body as { items?: T[]; next_cursor?: string | null };
    if (Array.isArray(body.items)) items.push(...body.items);
    cursor = body.next_cursor ?? null;
    if (cursor === null) return { ok: true, items };
    if (seen.has(cursor)) return { ok: false, reason: 'failed' }; // 游标回环：分页失败
    seen.add(cursor);
  }
}

/** P1：content 当前权威引用快照——宿主确认映射与存量对账的唯一当前状态来源。
 *  404/不可达不是“已删除且可释放”的证据，由调用方如实处理。
 *  F3（复审 2026-11-09 二轮）：conversation_archive 快照读**墓碑**（deleted=true 仍可
 *  读，含固定消息引用）——删除确认依赖它；archive 字段只对存档类型出现。 */
export type ContentReferenceSnapshot = {
  owner_service: 'content';
  owner_type: 'post' | 'comment' | 'album_entry' | 'creation' | 'future_note' | 'conversation_archive';
  owner_id: string;
  owner_revision: number;
  deleted: boolean;
  asset_ids: string[];
  archive?: { kind: string; created_by: string; messages: Array<{ message_id: string; revision: number; sequence: number }> };
};

export async function fetchReferenceSnapshot(client: ContentClient, ownerType: string, ownerId: string): Promise<ContentReferenceSnapshot | null> {
  const r = await contentForward(client, { method: 'GET', path: `/api/v1/content/references/${encodeURIComponent(ownerType)}/${encodeURIComponent(ownerId)}`, actor: 'qiaosheng' });
  if (r.status !== 200) return null;
  return r.body as ContentReferenceSnapshot;
}

/** P1：同操作回查——不执行，只解析该 actor+key 的既有回执对当前命令的含义。 */
export type ContentResolveOutcome =
  | { outcome: 'replay'; status: number; body: unknown }
  | { outcome: 'new' }
  | { outcome: 'conflict' | 'legacy_unresolved'; status: number; body: unknown };

export async function resolveContentOperation(client: ContentClient, opts: {
  actor: 'qiaosheng' | 'jiaming';
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey: string;
  ifMatch?: string;
}): Promise<ContentResolveOutcome> {
  const r = await contentForward(client, {
    method: 'POST', path: '/api/v1/content/operations/resolve', actor: opts.actor,
    body: { method: opts.method, path: opts.path, body: opts.body ?? {}, idempotency_key: opts.idempotencyKey, if_match: opts.ifMatch ?? '' },
  });
  if (r.status !== 200) throw new Error(`content resolve failed: ${r.status}`);
  return r.body as ContentResolveOutcome;
}

/** P1：content 写路径→引用 ownerType（快照读取与意图记录共用同一映射）。 */
export function ownerTypeOf(path: string): string {
  const p = path.split('?')[0]!;
  // 评论两条路径（/posts/:id/comments 与 /comments/:id）都含 /comments，先于 /posts 判定
  if (p.includes('/comments')) return 'comment';
  if (p.includes('/posts')) return 'post';
  // 注意 album 单数形态：创建走 /albums/:kind/entries，单条操作走 /album-entries/:id——同 ownerType
  if (p.includes('/albums') || p.includes('/album-entries')) return 'album_entry';
  if (p.includes('/archives')) return 'conversation_archive';
  if (p.includes('/creations')) return 'creation';
  if (p.includes('/future-notes')) return 'future_note';
  return 'unknown';
}
