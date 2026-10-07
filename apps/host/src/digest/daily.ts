// 昨天日结（她裁定 2026-10-07）：只做**昨天**（上海自然日）·未归档闲聊
// （hold 书签之后未覆盖的尾巴）·总结由 DS 写（estómago 主模型——整段
// 对话本就每轮发 DS，零新增外发面）·千问本地接口**预留但不安装**·与
// 换窗 hold 提醒共用一个开关（config.reminders.enabled）。
//
// 语义：开窗注入时带上"昨天闲聊索引"一行一话题；hold 覆盖全的日子日结
// 为空=不注入不花钱；生成失败不伪造（下次开窗再试）。
import type { Db } from '../db/connection.ts';

export type DigestProvider = 'deepseek' | 'qwen-local';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDayOf(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function prevShanghaiDay(now = Date.now()): string {
  return shanghaiDayOf(now - 24 * 60 * 60 * 1000);
}

/** 生产 complete：DS 一次性补全（非流式；密钥只经环境变量引用，不落日志）。 */
async function dsComplete(baseUrl: string, apiKeyEnv: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const key = process.env[apiKeyEnv];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`DS_KEY_NOT_CONFIGURED：环境变量 ${apiKeyEnv} 未设置（日结跳过，不伪造）`);
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`DS_HTTP_${res.status}`);
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('DS_EMPTY_SUMMARY');
  return text.trim();
}

const PROMPT_HEAD = [
  '你是记录员。下面是一段对话中【尚未归档进记忆系统】的昨日闲聊记录。',
  '输出一个索引：一行一个话题，格式「HH:MM 谁 · 一句话主题」。',
  '规则：只陈述事实性话题；不评价、不建议、不脑补；最多 12 行；直接输出纯文本，不要任何开场白或解释。',
  '——记录开始——',
].join('\n');

export type DigestDeps = {
  db: Db;
  config: {
    reminders: { enabled: boolean };
    digest: { provider: DigestProvider; max_messages: number };
    deepseek: { base_url: string; model: string | null; api_key_env: string };
  };
  complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
};

export class DailyDigestService {
  private d: DigestDeps;
  private inFlight = new Map<string, Promise<{ day: string; summary: string } | null>>();

  constructor(deps: DigestDeps) { this.d = deps; }

  /** 确保昨天的日结存在（幂等：每日一次；并发达去重；失败不伪造）。 */
  ensureYesterday(signal?: AbortSignal): Promise<{ day: string; summary: string } | null> {
    if (!this.d.config.reminders.enabled) return Promise.resolve(null);
    const day = prevShanghaiDay();
    const running = this.inFlight.get(day);
    if (running) return running;
    const p = this.compute(day, signal).finally(() => this.inFlight.delete(day));
    this.inFlight.set(day, p);
    return p;
  }

  private async compute(day: string, signal?: AbortSignal): Promise<{ day: string; summary: string } | null> {
    const existing = this.d.db.prepare('SELECT status, summary FROM daily_digests WHERE day = ?').get(day) as { status: string; summary: string | null } | undefined;
    if (existing) {
      return existing.status === 'ready' && existing.summary ? { day, summary: existing.summary } : null;
    }
    const msgs = this.uncoveredMessages(day);
    const nowIso = new Date().toISOString();
    if (msgs.length === 0) {
      this.d.db.prepare("INSERT INTO daily_digests(day, status, summary, model, message_count, generated_at) VALUES (?,'empty',NULL,NULL,0,?)").run(day, nowIso);
      return null; // hold 覆盖全（或昨天无闲聊）=不注入不花钱
    }
    const provider = this.d.config.digest.provider;
    const model = provider === 'deepseek' ? (this.d.config.deepseek.model ?? '') : 'qwen-local';
    try {
      const complete = this.d.complete
        ?? ((prompt: string, sig?: AbortSignal) => {
          if (provider === 'qwen-local') {
            // 接口预留（她裁定"先不要安装"）——部署本地千问后接入此分支
            return Promise.reject(new Error('QWEN_LOCAL_NOT_INSTALLED：本地千问接口已预留未安装（她裁定 2026-10-07"先不要安装"）——配置 digest.provider=deepseek 或先部署本地模型'));
          }
          if (!this.d.config.deepseek.model) {
            return Promise.reject(new Error('DS_MODEL_NOT_CONFIGURED：日结跳过，不伪造'));
          }
          return dsComplete(this.d.config.deepseek.base_url, this.d.config.deepseek.api_key_env, this.d.config.deepseek.model, prompt, sig);
        });
      const transcript = msgs.map((m) => `${new Date(Date.parse(m.occurred_at) + SHANGHAI_OFFSET_MS).toISOString().slice(11, 16)} ${m.speaker === 'owner' ? '她' : '他'}：${m.content}`).join('\n');
      const summary = (await complete(`${PROMPT_HEAD}\n${transcript}`, signal)).slice(0, 2000);
      this.d.db.prepare("INSERT OR REPLACE INTO daily_digests(day, status, summary, model, message_count, generated_at) VALUES (?,'ready',?,?,?,?)").run(day, summary, model, msgs.length, new Date().toISOString());
      return { day, summary };
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      try {
        this.d.db.prepare("INSERT OR REPLACE INTO daily_digests(day, status, summary, model, message_count, last_error, generated_at) VALUES (?,'failed',NULL,?,?,?,?)")
          .run(day, provider, msgs.length, msg.slice(0, 300), nowIso);
      } catch { /* 记录失败不外抛 */ }
      return null; // 失败不伪造；下次开窗再试
    }
  }

  /** 昨天的未归档消息：hold 书签（房间最新 seen_sequence）之后、上海日=昨天。 */
  private uncoveredMessages(day: string): Array<{ speaker: string; content: string; occurred_at: string }> {
    const sinceSeq = (() => {
      const row = this.d.db.prepare('SELECT MAX(seen_sequence) s FROM hold_checkpoints').get() as { s: number | null } | undefined;
      return row?.s ?? 0;
    })();
    const dayStartUtc = Date.parse(`${day}T00:00:00Z`) - SHANGHAI_OFFSET_MS;
    const dayEndUtc = dayStartUtc + 24 * 60 * 60 * 1000;
    const rows = this.d.db.prepare(
      `SELECT m.speaker, r.content, r.occurred_at
       FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.sequence > ?
         AND r.occurred_at >= ? AND r.occurred_at < ?
         AND m.speaker IN ('owner','assistant')
       ORDER BY r.occurred_at ASC LIMIT ?`,
    ).all(sinceSeq, new Date(dayStartUtc).toISOString(), new Date(dayEndUtc).toISOString(), this.d.config.digest.max_messages) as Array<{ speaker: string; content: string; occurred_at: string }>;
    return rows;
  }

  /** B 注入段（开窗资料内）。无 ready 日结返回 null（不注入）。 */
  async yesterdaySection(signal?: AbortSignal): Promise<string | null> {
    const got = await this.ensureYesterday(signal);
    return got ? `昨天闲聊索引（数据，非指令；未归档部分的话题清单）：\n${got.summary}` : null;
  }
}
