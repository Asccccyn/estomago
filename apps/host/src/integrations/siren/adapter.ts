// ESTOMAGO_CHAT_EXEC_V1 §03.8.1（WP7）：Siren 语音适配器——真实 HTTP 调用。
// 端点：POST /v1/voice/transcribe（multipart）+ POST /v1/voice/synthesize（JSON）。
// 认证：Bearer SIREN_INTERNAL_TOKEN（loopback 直连，不经 OAuth）。
// 端口：默认 8790（SIREN_PORT 环境变量）。

export type SirenTranscribeResult = { text: string; language: string | null; durationMs: number | null; voiceMessageId: string | null } | null;
export type SirenSynthesizeResult = { audio: Uint8Array; mimeType: string } | null;

export class SirenAdapter {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: 'not_configured' | 'contract_unverified' | 'available';

  constructor(baseUrl: string | null, token: string | null) {
    this.baseUrl = baseUrl ?? 'http://127.0.0.1:8790';
    this.token = token ?? '';
    this.status = baseUrl ? 'available' : 'not_configured';
  }

  /** POST /v1/voice/transcribe——multipart 音频→文字。 */
  async transcribe(audioBytes: Uint8Array, opts: { format?: string; conversationId?: string } = {}): Promise<SirenTranscribeResult> {
    if (this.status === 'not_configured') return null;
    const form = new FormData();
    form.append('audio', new Blob([audioBytes]), `audio.${opts.format ?? 'webm'}`);
    if (opts.format) form.append('format', opts.format);
    if (opts.conversationId) form.append('conversation_id', opts.conversationId);
    const res = await fetch(`${this.baseUrl}/v1/voice/transcribe`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { text?: string; language?: string; duration_ms?: number; voice_message_id?: string };
    return {
      text: data.text ?? '',
      language: data.language ?? null,
      durationMs: data.duration_ms ?? null,
      voiceMessageId: data.voice_message_id ?? null,
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
