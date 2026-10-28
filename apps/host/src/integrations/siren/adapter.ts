// ESTOMAGO_CHAT_EXEC_V1 §03.8.1（WP7）：Siren 语音适配器——真实 HTTP 调用。
// 端点：POST /v1/voice/transcribe（multipart）+ 协议①通话/邀请族（R11 减法后：
// synthesize/getVoiceMessage 无 est 消费者已退役；Siren 公开服务能力不受影响）。
// 认证：Bearer SIREN_INTERNAL_TOKEN（loopback 直连，不经 OAuth）。
// 端口：默认 8790（SIREN_PORT 环境变量）。

export type SirenTranscribeResult = { text: string; language: string | null; durationMs: number | null; voiceMessageId: string | null } | null;

export type SirenCallAudioTurn = {
  turn_id: string;
  turn_index: number;
  outcome: string | null;
  user_audio: { asset_id: string; duration_ms: number } | null;
  reply_audio: { asset_id: string; duration_ms: number; completeness: 'complete' | 'partial' | null } | null;
  sent_audio_ms: number | null;
  filler_audio_ms: number | null;
  playback: { basis: 'unknown' | 'client_drained' } | { basis: 'client_reported'; played_ms: number };
};

export type SirenCallAudio = { turns: SirenCallAudioTurn[]; audio_finalized: boolean };

function parseCallAudio(data: unknown, callId: string): SirenCallAudio {
  const invalid = (): never => { throw new SirenTranscriptionError('SIREN_CALL_AUDIO_INVALID'); };
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const ms = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const audio = (v: unknown): boolean => v === null || (obj(v) && typeof v.asset_id === 'string' && v.asset_id.length > 0 && ms(v.duration_ms));
  if (!obj(data) || data.schema_version !== 1 || data.call_id !== callId || !Array.isArray(data.turns)) return invalid();
  if (data.audio_finalized !== undefined && typeof data.audio_finalized !== 'boolean') return invalid();
  for (const t of data.turns) {
    if (!obj(t) || typeof t.turn_id !== 'string' || !t.turn_id || !Number.isInteger(t.turn_index) || Number(t.turn_index) < 0
      || !(t.outcome === null || typeof t.outcome === 'string') || !audio(t.user_audio) || !audio(t.reply_audio)
      || !(t.sent_audio_ms === null || ms(t.sent_audio_ms)) || !(t.filler_audio_ms === null || ms(t.filler_audio_ms))) return invalid();
    if (t.reply_audio !== null && (!obj(t.reply_audio) || ![null, 'complete', 'partial'].includes(t.reply_audio.completeness as null | string))) return invalid();
    if (!obj(t.playback) || !['unknown', 'client_drained', 'client_reported'].includes(String(t.playback.basis))
      || (t.playback.basis === 'client_reported' && !ms(t.playback.played_ms))) return invalid();
  }
  // 已部署旧版没有收尾字段；缺少证明时仍可读取已有音频，不能据空清单判定永久缺失。
  return { turns: data.turns as SirenCallAudioTurn[], audio_finalized: data.audio_finalized === true };
}

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

  /** F-02（跨仓预审 2026-10-25）：POST /v1/calls——接听交接的建呼出口。
   *  与邀请族同一 adapter（同 baseUrl/凭据/超时），不让邀请链一半走 env 直读的
   *  createCallFromInternalEnv（预审 U 类：两套配置来源易漂移）。
   *  契约与 createCallFromInternalEnv 一致：call_id/ws_url/token 必备，缺=合同无效；
   *  expires_at 可选透传（R-03：接听重放时判断短 token 是否仍可连）。 */
  async createCall(conversationId: string, opts: { signal?: AbortSignal } = {}): Promise<{ ok: true; callId: string; wsUrl: string; token: string; expiresAt?: string } | { ok: false; code: 'SIREN_UNREACHABLE' | 'SIREN_CALL_FAILED' | 'SIREN_CONTRACT_INVALID'; httpStatus?: number }> {
    if (this.status === 'not_configured') return { ok: false, code: 'SIREN_CALL_FAILED' };
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/calls`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }), redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch { return { ok: false, code: 'SIREN_UNREACHABLE' }; }
    if (!res.ok) return { ok: false, code: 'SIREN_CALL_FAILED', httpStatus: res.status };
    const created = await res.json().catch(() => null) as { call_id?: unknown; ws_url?: unknown; token?: unknown; expires_at?: unknown } | null;
    if (!created || typeof created.call_id !== 'string' || typeof created.ws_url !== 'string' || typeof created.token !== 'string') {
      return { ok: false, code: 'SIREN_CONTRACT_INVALID' };
    }
    return { ok: true, callId: created.call_id, wsUrl: created.ws_url, token: created.token, ...(typeof created.expires_at === 'string' ? { expiresAt: created.expires_at } : {}) };
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

  /** 真实 turn UUID 是跨仓关联键；没有音频的轮次也必须保留，不能按数组位置猜配。 */
  async callTurnAudio(callId: string, opts: { signal?: AbortSignal } = {}): Promise<SirenCallAudio | 'not_found' | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/calls/${encodeURIComponent(callId)}/turn-audio`, {
        headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw new SirenTranscriptionError('SIREN_CALL_STATUS_FAILED');
    return parseCallAudio(await res.json(), callId);
  }

  /** GLM_VOICE_UNIFICATION（04§5.3，A05）：POST /v1/voice/synthesize——char主动
   *  语音的真实合成出口（模型在 est 工具 chat_send_voice 下调用）。返回音频字节+
   *  时长/格式头；失败如实（付费 TTS 边界在 Siren）。
   *  A01（联合审计 2026-10-27）：operationId=费用边界前的稳定操作身份——Siren 侧
   *  生成即持久、同键重放/并发只合成一次；响应丢失后可按同键找回已生成资产。 */
  async synthesize(args: { text: string; ttsScript?: string; emotion?: string; speed?: number; operationId?: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mime: string; format: string; durationMs: number | null; profileId: string | null } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/voice/synthesize`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: args.text, ...(args.ttsScript ? { tts_script: args.ttsScript } : {}), ...(args.emotion ? { emotion: args.emotion } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}), ...(args.operationId ? { operation_id: args.operationId } : {}) }),
        redirect: 'error',
        // 取消与超时并存：传入轮次取消信号不能顶掉超时（否则 Siren 挂起会一直占住串行链）
        signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) {
      // 409=同操作键但关键输入与已持久资产不一致：不是可重试失败，需换新操作意图
      if (res.status === 409) throw new SirenTranscriptionError('SIREN_OPERATION_CONFLICT');
      throw new SirenTranscriptionError(res.status === 401 || res.status === 403 ? 'SIREN_AUTH_REJECTED' : 'SIREN_SYNTHESIS_FAILED');
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    return {
      bytes,
      mime: res.headers.get('content-type') ?? 'audio/mpeg',
      format: res.headers.get('x-siren-format') ?? 'mp3',
      durationMs: Number(res.headers.get('x-siren-duration-ms')) || null,
      profileId: res.headers.get('x-siren-voice-profile'),
    };
  }

  /** A01（联合审计 2026-10-27）恢复口：按操作身份查 Siren 已持久语音资产。
   *  GET /v1/voice/messages?message_id=<operation_id>（既有资源查询面，Siren message_id
   *  即 est 侧操作键）。命中返回资产 id；未持久/未命中返回 null（调用方如实报结果不明）。 */
  async findVoiceAssetByOperationId(operationId: string, opts: { signal?: AbortSignal } = {}): Promise<{ id: string; durationMs: number | null; format: string } | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/voice/messages?message_id=${encodeURIComponent(operationId)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ id?: unknown; duration_ms?: unknown; audio_format?: unknown }> };
    const first = data.items?.find((item) => typeof item.id === 'string' && item.id.length > 0);
    if (!first) return null;
    return { id: first.id as string, durationMs: typeof first.duration_ms === 'number' ? first.duration_ms : null, format: typeof first.audio_format === 'string' ? first.audio_format : 'mp3' };
  }

  /** JV-04（联合审计 2026-10-26）：GET /v1/calls/:id——Siren 会话事实（只读、幂等）。
   *  db_status 来自 Siren 持久正本（ended=已收口），session_active=WS 会话仍在；
   *  est 启动对账据此纠正 voice_calls 投影。404=正本无此通话（返回 null 之外的
   *  三态由调用方区分：throw=不可达）。 */
  async callStatus(callId: string, opts: { signal?: AbortSignal } = {}): Promise<{ dbStatus: 'active' | 'ended'; sessionActive: boolean } | 'not_found' | null> {
    if (this.status === 'not_configured') return null;
    let res: Response;
    try {
      res = await this.transport(`${this.baseUrl.replace(/\/$/, '')}/v1/calls/${encodeURIComponent(callId)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }, redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch { throw new SirenTranscriptionError('SIREN_OUTCOME_UNKNOWN', true); }
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw new SirenTranscriptionError('SIREN_CALL_STATUS_FAILED');
    const data = await res.json() as { db_status?: unknown; session_active?: unknown };
    return {
      dbStatus: data.db_status === 'ended' ? 'ended' : 'active',
      sessionActive: data.session_active === true,
    };
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
