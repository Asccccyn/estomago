// 首版单拥有者设备配对（01 §17：可复用现有身份体系，也可首版单拥有者配对）。
// token 存 $STATE/config/auth.token（0600，不进 Git/日志）；请求经 Bearer/Cookie/query 认证；
// 会话 cookie HttpOnly+SameSite=Strict；POST 校验 Origin（CSRF）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EstomagoPaths } from '../config/paths.ts';

export const SESSION_COOKIE = 'estomago_session';

export class AuthService {
  private token: string;

  private paths: EstomagoPaths;
  constructor(paths: EstomagoPaths) {
    this.paths = paths;
    const file = path.join(paths.configDir, 'auth.token');
    fs.mkdirSync(paths.configDir, { recursive: true });
    if (fs.existsSync(file)) {
      this.token = fs.readFileSync(file, 'utf8').trim();
    } else {
      this.token = randomBytes(32).toString('hex');
      fs.writeFileSync(file, this.token + '\n', { mode: 0o600 });
    }
  }

  tokenFilePath(): string {
    return path.join(this.paths.configDir, 'auth.token');
  }

  verifyToken(candidate: string | null | undefined): boolean {
    if (!candidate || typeof candidate !== 'string') return false;
    if (candidate.length !== this.token.length) return false;
    // 常量时间比较
    let diff = 0;
    for (let i = 0; i < this.token.length; i++) diff |= this.token.charCodeAt(i) ^ candidate.charCodeAt(i);
    return diff === 0;
  }

  // 从请求解析凭证：Authorization: Bearer / 会话 cookie（F-J-45 她 2026-10-06 批准关 URL token——
// 凭据不进 URL（shell history/中间层日志泄漏面）；EventSource 走同源 cookie）
  extract(req: { headers: Record<string, string | string[] | undefined>; url?: string }): string | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    const cookie = req.headers['cookie'];
    if (typeof cookie === 'string') {
      for (const part of cookie.split(';')) {
        const [k, v] = part.trim().split('=');
        if (k === SESSION_COOKIE && v) return decodeURIComponent(v);
      }
    }
    if (req.url) {
    }
    return null;
  }

  isAuthorized(req: { headers: Record<string, string | string[] | undefined>; url?: string }): boolean {
    return this.verifyToken(this.extract(req));
  }

  // CSRF/Origin：POST/PUT 必须同源（本地无 Origin 的 curl 放行，便于脚本）
  originAllowed(req: { headers: Record<string, string | string[] | undefined>; url?: string }, host: string): boolean {
    const origin = req.headers['origin'];
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;
    if (origin === 'null') return false;
    try {
      const o = new URL(origin);
      const allowedHosts = [host, `127.0.0.1:${new URL(`http://${host}`).port}`, `localhost:${new URL(`http://${host}`).port}`];
      return o.host === host || allowedHosts.includes(o.host);
    } catch {
      return false;
    }
  }
}
