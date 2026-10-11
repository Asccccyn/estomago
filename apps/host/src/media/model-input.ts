// ESTOMAGO_CHAT_EXEC_V1 §03.6（WP3/M2）：统一媒体输入投影器——全部入口（本轮输入/同窗追赶/
// 人工选集/轨迹恢复）经同一实现把"消息修订+附件"变成驱动输入。
// 两层形态严格分离：
//  - 内部投影（轨迹/payload_json 证据持久形态）：asset_image 引用块——不含 Base64（§6.2）；
//  - 发送物化（runner 边界）：从不可变文件确定性物化为 Provider 图像块；同资产同字节 → 同投影，
//    append-only 断言在物化形态上执行（§6.2：不拿未含图旧对象与新多模态对象比较后忽略失败）。
// 视觉能力门：所选型号未核实支持图片 → MODEL_VISION_UNAVAILABLE（消息保存、回复明确阻断，
// 不静默丢图、不切模型）。语音：无转写不空输入唤起模型（MEDIA_TRANSCRIPTION_FAILED）。
import type { MediaService } from './assets.ts';

/** 内部引用块（不直接传给 Provider；持久形态） */
export type AssetImageRefBlock = { type: 'asset_image'; asset_id: string; projection_version: 'v1' };
export type ProjectedBlock = { type: 'text'; text: string } | AssetImageRefBlock;
export const PROJECTION_VERSION = 'v1' as const;

export type RevisionAttachment = { asset_id: string; presentation: string; caption: string | null; derived_text: string | null; derived_source: string | null };

/** 消息修订 → 内部投影块。语音带转写→标注来源的文本块；图片/表情→asset_image 引用块。 */
export function projectRevisionBlocks(content: string, attachments: RevisionAttachment[], opts: { isCurrentInput?: boolean } = {}): { blocks: ProjectedBlock[]; hasImage: boolean; hasVoiceWithoutTranscript: boolean } {
  const isCurrentInput = opts.isCurrentInput === true;
  const blocks: ProjectedBlock[] = [];
  if (content.length > 0) blocks.push({ type: 'text', text: content });
  let hasImage = false;
  let hasVoiceWithoutTranscript = false;
  for (const a of attachments) {
    if (a.presentation === 'voice') {
      // §3.3/§8.1：转写是派生文字——带来源标记进入模型；原音频不再另计模型音频 token
      if (a.derived_text && a.derived_text.trim().length > 0) {
        blocks.push({ type: 'text', text: `[语音消息转写（来源：${a.derived_source ?? 'unspecified'}，派生文字非亲笔正文）]\n${a.derived_text}` });
      } else if (isCurrentInput === true) {
        hasVoiceWithoutTranscript = true; // 当前输入无转写→不空输入唤起模型（门阻断）
      } else {
        // 历史语音无转写：如实占位（模型知道存在语音消息），不静默消失也不空输入阻断
        blocks.push({ type: 'text', text: '[语音消息：本条无转写，原音频已保留]' });
      }
      continue;
    }
    // image / sticker：内部引用块（sticker 按 §8.2 以固定视觉派生版本送模型——一期即原件位图）
    hasImage = true;
    blocks.push({ type: 'asset_image', asset_id: a.asset_id, projection_version: PROJECTION_VERSION });
    if (a.caption && a.caption.trim().length > 0) blocks.push({ type: 'text', text: `[附件说明] ${a.caption}` });
  }
  return { blocks, hasImage, hasVoiceWithoutTranscript };
}

/** 发送物化：asset_image → Provider（Anthropic 族）图像块。确定性：同资产同字节同输出。 */
export function materializeBlocks(blocks: ProjectedBlock[], media: MediaService): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.type === 'text') { out.push({ type: 'text', text: b.text }); continue; }
    const { bytes, mime } = media.readContent(b.asset_id);
    out.push({ type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } });
  }
  return out;
}

/** 物化整个信封消息（深替换 content 数组中的 asset_image）。 */
export function materializeEnvelope<T extends { messages: Array<{ role: string; content: unknown }> }>(envelope: T, media: MediaService): T {
  return {
    ...envelope,
    messages: envelope.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      const needs = (m.content as Array<Record<string, unknown>>).some((b) => b && b.type === 'asset_image');
      if (!needs) return m;
      const blocks = (m.content as Array<Record<string, unknown>>).map((b) => (b && b.type === 'asset_image' ? { type: 'asset_image', asset_id: b.asset_id, projection_version: b.projection_version } as AssetImageRefBlock : b as unknown as ProjectedBlock));
      return { ...m, content: materializeBlocks(blocks, media) };
    }),
  };
}

/** 存储脱敏（§6.2 不把 Base64 复制进数据库）：wire 证据里 image source.data → sha256 指纹。 */
export function redactImageBlocksForStorage(payloadWireJson: string): { redactedJson: string; redactedImageCount: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image' && o.source && typeof o.source === 'object') {
        const src = o.source as Record<string, unknown>;
        if (src.type === 'base64' && typeof src.data === 'string') {
          count++;
          // 资产字节哈希可对账（media_assets.content_sha256），Base64 本体不入库
          const sha = simpleSha(src.data);
          return { ...o, source: { ...src, data: `redacted:sha256-base64:${sha}`, data_redacted: true } };
        }
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { redactedJson: JSON.stringify(walk(JSON.parse(payloadWireJson))), redactedImageCount: count };
}

// 轻 sha（FNV-1a 64bit hex）：仅作存储指纹对账用，非密码学（资产正身哈希在 media_assets 表）
function simpleSha(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (s.charCodeAt(i) + i) & 0xff; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// —— 视觉能力门（§6.1：使用经确认支持图片的确切型号；未核实=阻断，不静默丢图）——
type VisionCacheEntry = { supported: boolean | null; fetchedAt: number };
const visionCache = new Map<string, VisionCacheEntry>();
const VISION_TTL_MS = 300_000;

/** 测试注入点（离线套件不打网络）。supported=null=未核实。 */
export function setVisionSupportForTests(model: string, supported: boolean | null): void {
  visionCache.set(model, { supported, fetchedAt: Date.now() });
}
export function clearVisionSupportCache(): void {
  visionCache.clear();
}

export function visionSupportCached(model: string): boolean | null {
  const hit = visionCache.get(model);
  if (!hit || Date.now() - hit.fetchedAt > VISION_TTL_MS) return null;
  return hit.supported;
}

/** 从 OR /models 元数据核实 input_modalities（architecture.input_modalities 含 'image'）。 */
export async function refreshVisionSupport(baseUrl: string, model: string): Promise<boolean | null> {
  try {
    const root = baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
    const res = await fetch(`${root}/api/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }> };
    const row = (data.data ?? []).find((m) => m.id === model);
    const mods = row?.architecture?.input_modalities;
    const supported = Array.isArray(mods) ? mods.includes('image') : null;
    visionCache.set(model, { supported, fetchedAt: Date.now() });
    return supported;
  } catch {
    return null; // 不可达=未核实（阻断，不猜）
  }
}

/** 容量保守控制（§6.1）：未核实计量方式时每张未知图按保守 token 计（工程默认，非用户批准值）。 */
export const CONSERVATIVE_IMAGE_TOKENS = 1600;
