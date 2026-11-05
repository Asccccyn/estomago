// ESTOMAGO_CHAT_EXEC_V1 §06.1（WP5）：est→content 薄代理——唯一通道。
// 浏览器/模型都经 est 认证后由适配器调 content（loopback+服务凭据+宿主派生 actor）；
// content 不反调 est；凭据值只在 transport 头读取处，不落日志/DB。
// 资产校验在 est 侧（媒体服务正本），content 只收 asset_id 引用。
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../../db/connection.ts';
import type { MediaService } from '../../media/assets.ts';
import { MediaError } from '../../media/assets.ts';

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

/** 转发请求到 content——est 唯一写通道。actor 从可信上下文派生，不从请求体。 */
export async function contentForward(client: ContentClient, opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // /api/v1/content/...
  actor: 'qiaosheng' | 'jiaming';
  body?: unknown;
  headers?: Record<string, string>; // Idempotency-Key / If-Match 透传
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
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** est 薄代理的通用处理：验证资产引用（存在/available）→ 转发 → 成功后登记保护引用。 */
export async function contentProxyWithAssets(opts: {
  client: ContentClient;
  media: MediaService | null;
  db: Db;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  actor: 'qiaosheng' | 'jiaming';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: unknown }> {
  const { client, media, method, path, actor, body, headers } = opts;
  // F06（四仓联合审计 20261104）：资产引用字段=现行 content 全集——数组 asset_ids 与
  // 单值 asset_id/icon_asset_id/work_asset_id（旧实现只认数组：相册条目/creation 的
  // 单值引用既不验证也不登记，仍在使用的资产可被 DELETE /assets 标删——审计实测）。
  const assetRefs: string[] = [];
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.asset_ids)) for (const a of b.asset_ids) if (typeof a === 'string' && a) assetRefs.push(a);
    for (const k of ['asset_id', 'icon_asset_id', 'work_asset_id'] as const) {
      if (typeof b[k] === 'string' && b[k]) assetRefs.push(b[k] as string);
    }
  }
  const uniqueRefs = [...new Set(assetRefs)];
  // 写请求含资产引用时先验证（§06.5.3：资产校验在 est，content 只收引用）
  if (media && (method === 'POST' || method === 'PUT') && uniqueRefs.length > 0) {
    for (const assetId of uniqueRefs) {
      try {
        const a = media.getAsset(assetId);
        if (a.state !== 'available') {
          return { status: 422, body: { error: { code: 'asset_not_ready', message: `资产 ${assetId} 状态 ${a.state}` } } };
        }
      } catch (err) {
        if (err instanceof MediaError) return { status: err.httpStatus, body: { error: { code: err.code.toLowerCase(), message: err.message } } };
        throw err;
      }
    }
  }
  const result = await contentForward(client, { method, path, actor, body, headers });
  // POST/PUT 成功后：对 body 中引用的 asset 登记保护引用（est 侧防误删）
  if (media && (result.status === 201 || result.status === 200) && uniqueRefs.length > 0) {
    const objId = (result.body as { id?: string })?.id;
    for (const assetId of uniqueRefs) {
      try {
        media.registerReference({ assetId, ownerService: 'content', ownerType: ownerTypeOf(path), ownerId: objId ?? 'unknown', operationId: `content:${objId ?? 'new'}:${assetId}` });
      } catch { /* 引用登记失败不阻塞内容保存——保护引用可后补 */ }
    }
  }
  // R2（复审 b137e98）：内容删除/替换后释放引用——content 的 DELETE 响应携带被删对象
  // 引用的 asset（asset_id / asset_ids）；PUT 替换时 body 中的新集合已登记，响应中的
  // 旧集合（previous_asset_ids，如有）里不在新集合的释放。解除后资产删除守卫按
  // 剩余有效引用如实判定（最后一条引用解除→可删；多引用删一个→仍拒）。
  if (media && result.status === 200) {
    const objId = (result.body as { id?: string })?.id ?? 'unknown';
    const released: Array<{ assetId: string; ownerType: string }> = [];
    const rb = result.body as { asset_id?: unknown; asset_ids?: unknown; previous_asset_ids?: unknown };
    if (method === 'DELETE') {
      if (typeof rb.asset_id === 'string' && rb.asset_id) released.push({ assetId: rb.asset_id, ownerType: ownerTypeOf(path) });
      if (Array.isArray(rb.asset_ids)) for (const a of rb.asset_ids) if (typeof a === 'string' && a) released.push({ assetId: a, ownerType: ownerTypeOf(path) });
    }
    if (method === 'PUT' && Array.isArray(rb.previous_asset_ids)) {
      for (const a of rb.previous_asset_ids) {
        if (typeof a === 'string' && a && !uniqueRefs.includes(a)) released.push({ assetId: a, ownerType: ownerTypeOf(path) });
      }
    }
    for (const r of released) {
      try { media.releaseReferencesByOwner({ assetId: r.assetId, ownerService: 'content', ownerType: r.ownerType, ownerId: objId }); }
      catch { /* 释放失败留待下次内容删除重放（幂等）或资产删除时的守卫如实报告 */ }
    }
  }
  return result;
}

/** R2：content 路径→引用 ownerType（登记与释放共用同一映射） */
function ownerTypeOf(path: string): string {
  // 注意 album 单数形态：创建走 /albums/:kind/entries，单条操作走 /album-entries/:id——同 ownerType
  if (path.includes('/posts') || path.includes('/comments')) return 'post';
  if (path.includes('/albums') || path.includes('/album-entries')) return 'album_entry';
  if (path.includes('/creations')) return 'creation';
  if (path.includes('/future-notes')) return 'future_note';
  return 'unknown';
}
