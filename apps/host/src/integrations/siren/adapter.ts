// ESTOMAGO_CHAT_EXEC_V1 §03.8.1（WP7）：Siren 语音适配器——真实 HTTP 调用。
// 端点：POST /v1/voice/transcribe（multipart）+ POST /v1/voice/synthesize（JSON）。
// 认证：Bearer SIREN_INTERNAL_TOKEN（loopback 直连，不经 OAuth）。
// 端口：默认 8790（SIREN_PORT 环境变量）。

export type SirenTranscribeResult = { text: string; language: string | null; durationMs: number | null; voiceMessageId: string | null } | null;
export type SirenSynthesizeResult = { audio: Uint8Array; mimeType: string } | null;

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

  /** POST /v1/voice/synthesize——JSON→音频字节。 */
  async synthesize(text: string, opts: { voiceProfile?: string } = {}): Promise<SirenSynthesizeResult> {
    if (this.status === 'not_configured') return null;
    const res = await fetch(`${this.baseUrl}/v1/voice/synthesize`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(opts.voiceProfile ? { voice_profile: opts.voiceProfile } : {}) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const audio = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? 'audio/mpeg';
    return { audio, mimeType };
  }

  /** GET /v1/voice/messages/:id——按 ID 读语音消息记录。 */
  async getVoiceMessage(id: string): Promise<Record<string, unknown> | null> {
    if (this.status === 'not_configured') return null;
    const res = await fetch(`${this.baseUrl}/v1/voice/messages/${encodeURIComponent(id)}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  }
}
