// 首版单拥有者设备配对（01 §17：可复用现有身份体系，也可首版单拥有者配对）。
// token 存 $STATE/config/auth.token（0600，不进 Git/日志）；请求经 Bearer/Cookie/query 认证；
// 会话 cookie HttpOnly+SameSite=Strict；POST 校验 Origin（CSRF）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { EstomagoPaths } from '../config/paths.ts';

export const SESSION_COOKIE = 'estomago_session';
const derivePassword = promisify(scrypt);
type WebLogin = { username: string; salt: string; passwordHash: string };

export class AuthService {
  private token: string;
  private webLogin: WebLogin | null = null;

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
    const webFile = path.join(paths.configDir, 'auth.web.json');
    if (fs.existsSync(webFile)) {
      const value = JSON.parse(fs.readFileSync(webFile, 'utf8')) as Partial<WebLogin>;
      if (typeof value.username !== 'string' || !value.username.trim() || value.username.length > 64
        || typeof value.salt !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt)
        || typeof value.passwordHash !== 'string' || !/^[a-f0-9]{128}$/.test(value.passwordHash)) throw Error('WEB_LOGIN_CONFIG_INVALID');
      this.webLogin = value as WebLogin;
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

  account(): { configured: boolean; username: string | null } {
    return { configured: this.webLogin !== null, username: this.webLogin?.username ?? null };
  }

  sessionToken(): string {
    // Web password changes invalidate browser credentials without changing the
    // pairing token used by existing local tools and API clients.
    return this.webLogin ? createHmac('sha256', this.token).update(JSON.stringify(this.webLogin)).digest('hex') : this.token;
  }

  async verifyPassword(username: string, password: string): Promise<boolean> {
    if (!this.webLogin) return this.verifyToken(password.trim());
    const hash = await derivePassword(password, this.webLogin.salt, 64) as Buffer;
    return username === this.webLogin.username && timingSafeEqual(hash, Buffer.from(this.webLogin.passwordHash, 'hex'));
  }

  async setAccount(username: string, password: string): Promise<void> {
    const salt = randomBytes(16).toString('hex');
    const hash = await derivePassword(password, salt, 64) as Buffer;
    const next: WebLogin = { username, salt, passwordHash: hash.toString('hex') };
    const file = path.join(this.paths.configDir, 'auth.web.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    this.webLogin = next;
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
    return null;
  }

  isAuthorized(req: { headers: Record<string, string | string[] | undefined>; url?: string }): boolean {
    const candidate = this.extract(req);
    if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) return this.verifyToken(candidate);
    const expected = Buffer.from(this.sessionToken());
    const actual = Buffer.from(candidate ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
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
