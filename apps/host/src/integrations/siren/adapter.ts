// ESTOMAGO_CHAT_EXEC_V1 §03.8.1（WP7）：Siren 语音适配器框架——合同未核不冒充。
// 真实合同核验后填入：转写输入/返回格式、合成接口、保存与消息关联、重复请求处理。
export type SirenTranscribeResult = { text: string; confidence: number | null; duration_ms: number | null } | null;
export class SirenAdapter {
  readonly baseUrl: string | null;
  readonly status: 'not_configured' | 'contract_unverified' | 'available';
  constructor(baseUrl: string | null) {
    this.baseUrl = baseUrl;
    this.status = baseUrl ? 'contract_unverified' : 'not_configured';
  }
  async transcribe(_audioBytes: Uint8Array): Promise<SirenTranscribeResult> {
    return null; // contract_unverified：不冒充
  }
  async synthesize(_text: string): Promise<Uint8Array | null> {
    return null;
  }
}
