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
  // 写请求含 asset_ids 时先验证（§06.5.3：资产校验在 est，content 只收引用）
  if (media && (method === 'POST' || method === 'PUT') && body && Array.isArray(body.asset_ids)) {
    for (const assetId of body.asset_ids) {
      if (typeof assetId !== 'string' || !assetId) continue;
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
  if (media && (result.status === 201 || result.status === 200) && body && Array.isArray(body.asset_ids)) {
    const objId = (result.body as { id?: string })?.id;
    for (const assetId of body.asset_ids) {
      if (typeof assetId !== 'string' || !assetId) continue;
      try {
        media.registerReference({ assetId, ownerService: 'content', ownerType: path.includes('/posts') ? 'post' : path.includes('/albums') ? 'album_entry' : path.includes('/creations') ? 'creation' : path.includes('/future-notes') ? 'future_note' : 'unknown', ownerId: objId ?? 'unknown', operationId: `content:${objId ?? 'new'}:${assetId}` });
      } catch { /* 引用登记失败不阻塞内容保存——保护引用可后补 */ }
    }
  }
  return result;
}
