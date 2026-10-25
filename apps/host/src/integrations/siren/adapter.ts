// ESTOMAGO_CHAT_EXEC_V1 §03.8.1（WP7）：Siren 语音适配器——真实 HTTP 调用。
// 端点：POST /v1/voice/transcribe（multipart）+ 协议①通话/邀请族（R11 减法后：
// synthesize/getVoiceMessage 无 est 消费者已退役；Siren 公开服务能力不受影响）。
// 认证：Bearer SIREN_INTERNAL_TOKEN（loopback 直连，不经 OAuth）。
// 端口：默认 8790（SIREN_PORT 环境变量）。

export type SirenTranscribeResult = { text: string; language: string | null; durationMs: number | null; voiceMessageId: string | null } | null;

export class SirenTranscriptionError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  constructor(code: string, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}

export class SirenAdapter {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: 'not_configured' | 'contract_unverified' | 'available';
  private readonly transport: typeof fetch;

  constructor(baseUrl: string | null, token: string | null, transport: typeof fetch = fetch) {
    if (transport !== fetch && process.env.ESTOMAGO_TEST_MODE !== '1') throw new Error('TEST_TRANSPORT_FORBIDDEN');
    this.transport = transport;
    this.baseUrl = baseUrl ?? 'http://127.0.0.1:8790';
    this.token = token ?? '';
    this.status = baseUrl ? 'available' : 'not_configured';
  }

  /** POST /v1/voice/transcribe——multipart 音频→文字。 */
  async transcribe(audioBytes: Uint8Array, opts: { format?: string; mimeType?: string; conversationId?: string } = {}): Promise<SirenTranscribeResult> {
    if (this.status === 'not_configured') return null;
    const form = new FormData();
    const uploadBytes = new Uint8Array(audioBytes.byteLength);
    uploadBytes.set(audioBytes);
    form.append('audio', new Blob([uploadBytes.buffer], { type: opts.mimeType ?? 'application/octet-stream' }), `audio.${opts.format ?? 'webm'}`);
    if (opts.format) form.append('format', opts.format);
    if (opts.conversationId) form.append('conversation_id', opts.conversationId);
    form.append('store', 'false'); // 原音频正本保存在 est；只请求实际 ASR，不在 Siren 再建消息。
    let res: Response;
    try { res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/voice/transcribe`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form,
      redirect: 'error', // 禁止向重定向目标转发凭据和音频。
      signal: AbortSignal.timeout(30000),
    }); } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) throw new SirenTranscriptionError(res.status === 401 || res.status === 403 ? 'SIREN_AUTH_REJECTED' : 'SIREN_TRANSCRIBE_FAILED');
    let data: { text?: unknown; language?: unknown; duration_ms?: unknown; voice_message_id?: unknown };
    try { data = await res.json(); } catch { throw new SirenTranscriptionError('SIREN_RESPONSE_INVALID', true); }
    if (typeof data.text !== 'string' || data.text.length > 100000) throw new SirenTranscriptionError('SIREN_RESPONSE_INVALID', true);
    if (!data.text.trim()) throw new SirenTranscriptionError('SIREN_TRANSCRIPT_EMPTY');
    return {
      text: data.text,
      language: typeof data.language === 'string' ? data.language : null,
      durationMs: typeof data.duration_ms === 'number' && Number.isFinite(data.duration_ms) && data.duration_ms >= 0 ? data.duration_ms : null,
      voiceMessageId: typeof data.voice_message_id === 'string' ? data.voice_message_id : null,
    };
  }

  // —— 协议①（2026-10-24）：来电邀请（est 认证授权→Siren 创建/查询/接听/拒接）——

  /** POST /v1/invites——创建来电邀请（expires_at 服务端权威；est 拨号动作的下游）。 */
  async createInvite(conversationId: string, opts: { ttlSeconds?: number; signal?: AbortSignal } = {}): Promise<{ inviteId: string; expiresAt: number } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/invites`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}) }),
        redirect: 'error',
        signal: opts.signal ?? AbortSignal.timeout(8000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) throw new SirenTranscriptionError(res.status === 401 || res.status === 403 ? 'SIREN_AUTH_REJECTED' : 'SIREN_INVITE_FAILED');
    const data = await res.json() as { invite_id?: unknown; expires_at?: unknown };
    if (typeof data.invite_id !== 'string' || typeof data.expires_at !== 'number') throw new SirenTranscriptionError('SIREN_RESPONSE_INVALID', true);
    return { inviteId: data.invite_id, expiresAt: data.expires_at };
  }

  /** GET /v1/conversations/:id/invites——卡片投影数据源（active+近期终态）。 */
  async listInvites(conversationId: string, opts: { signal?: AbortSignal } = {}): Promise<{ active: Record<string, unknown> | null; recent: Array<Record<string, unknown>> } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/conversations/${encodeURIComponent(conversationId)}/invites`, {
        headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ?? AbortSignal.timeout(6000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) throw new SirenTranscriptionError('SIREN_INVITE_QUERY_FAILED');
    const data = await res.json() as { active?: unknown; recent?: unknown };
    return { active: (data.active ?? null) as Record<string, unknown> | null, recent: Array.isArray(data.recent) ? data.recent as Array<Record<string, unknown>> : [] };
  }

  /** POST /v1/invites/:id/cancel——发起方取消邀请（char侧；幂等）。 */
  async cancelInvite(inviteId: string, opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown> | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/invites/${encodeURIComponent(inviteId)}/cancel`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ?? AbortSignal.timeout(6000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (res.status === 404) throw new SirenTranscriptionError('SIREN_INVITE_NOT_FOUND');
    if (!res.ok) throw new SirenTranscriptionError('SIREN_INVITE_TRANSITION_FAILED');
    return await res.json() as Record<string, unknown>;
  }

  /** POST /v1/invites/:id/accept|decline——接听/拒接（幂等；与过期竞态服务端单终态）。 */
  async transitionInvite(inviteId: string, action: 'accept' | 'decline', opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown> | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/invites/${encodeURIComponent(inviteId)}/${action}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ?? AbortSignal.timeout(6000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) throw new SirenTranscriptionError(res.status === 404 ? 'SIREN_INVITE_NOT_FOUND' : 'SIREN_INVITE_TRANSITION_FAILED');
    return await res.json() as Record<string, unknown>;
  }

  /** A11（2026-10-24）：POST /v1/calls/:id/hangup-request——模型提出挂断（立即回执；
   *  真正结束由 Siren drain→linger 决定，她开口可取消）。 */
  async requestHangup(callId: string, opts: { signal?: AbortSignal } = {}): Promise<{ accepted: boolean } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/calls/${encodeURIComponent(callId)}/hangup-request`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ?? AbortSignal.timeout(5000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (res.status === 404) return { accepted: false };
    if (!res.ok) throw new SirenTranscriptionError('SIREN_HANGUP_REQUEST_FAILED');
    const data = await res.json() as { accepted?: unknown };
    return { accepted: data.accepted === true };
  }

  // —— 协议②（2026-10-24）：通话用户原声取回（服务间只读；绑 est 消息供 oído）——

  /** GET /v1/voice-assets/:id/audio——按 CoreTurnInput.audio_ref=siren:<id> 取回 WAV 字节。 */
  async fetchVoiceAssetAudio(assetId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      // 审计修复：合并父取消与原超时（原 signal ?? timeout 会丢弃父取消）
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/voice-assets/${encodeURIComponent(assetId)}/audio`, {
        headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 10000)]) : AbortSignal.timeout(opts.timeoutMs ?? 10000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (res.status === 404) return null;
    if (!res.ok) throw new SirenTranscriptionError('SIREN_AUDIO_FETCH_FAILED');
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'audio/wav' };
  }
}

// —— P03.5：受控建呼工厂（原 callControl.accept_call 内的直接 fetch + 环境变量读取抽出）——
// URL、认证（可选内部 token）、5s 超时、返回与 unknown 语义逐字保持；配置存在≠服务在线
//（不可达仍如实 SIREN_UNREACHABLE）。不在通用 executor 读 Siren 配置。
export type SirenCallCreation =
  | { ok: true; call_id: string; ws_url: string; token: string }
  | { ok: false; code: 'SIREN_UNCONFIGURED' | 'SIREN_UNREACHABLE' | 'SIREN_CONTRACT_INVALID' }
  | { ok: false; code: 'SIREN_CALL_FAILED'; httpStatus: number };

export async function createCallFromInternalEnv(conversationId: string, opts: { signal?: AbortSignal } = {}): Promise<SirenCallCreation> {
  const sirenBase = process.env.ESTOMAGO_SIREN_BASE_URL;
  if (!sirenBase) return { ok: false, code: 'SIREN_UNCONFIGURED' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sirenToken = process.env.ESTOMAGO_SIREN_INTERNAL_TOKEN;
  if (sirenToken) headers.Authorization = `Bearer ${sirenToken}`;
  let sirenRes: Response;
  try {
    sirenRes = await fetch(`${sirenBase.replace(/\/$/, '')}/v1/calls`, { method: 'POST', headers, body: JSON.stringify({ conversation_id: conversationId }), signal: opts.signal ?? AbortSignal.timeout(5000) });
  } catch {
    return { ok: false, code: 'SIREN_UNREACHABLE' };
  }
  if (!sirenRes.ok) return { ok: false, code: 'SIREN_CALL_FAILED', httpStatus: sirenRes.status };
  const created = await sirenRes.json() as { call_id?: string; ws_url?: string; token?: string };
  if (typeof created.call_id !== 'string' || typeof created.ws_url !== 'string' || typeof created.token !== 'string') {
    return { ok: false, code: 'SIREN_CONTRACT_INVALID' };
  }
  return { ok: true, call_id: created.call_id, ws_url: created.ws_url, token: created.token };
}
