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

/** 消息修订 → 内部投影块。语音带转写→标注来源的文本块；图片/表情→asset_image 引用块。
 *  textOnly（2026-10-18 她的裁定：多选只带文本）——人工选集装配专用：图片/表情不产出
 *  视觉引用块，以如实占位文本替代（模型知道此处有图、图未携带，不静默消失）；
 *  语音转写本就是文本，照常携带。
 *  JOINT-VOICE-20261022（04 voice_model_view）：当前输入语音块带 audio_ref+时长；
 *  转写未就绪且 oído 可听→结构化语音引用消息进入（可调 oido_analyze，非空输入）；
 *  无听觉能力→保持阻断语义。历史消息投影形状零变化（缓存前缀不可变）。 */
/** R3′（2026-10-23）：转写首页字数（按 UTF-8 3B/汉字上界 ≈7.4KB，留标注余量在 8192B 预算内） */
export const TRANSCRIPT_PAGE_CHARS = 2400;

export function projectRevisionBlocks(content: string, attachments: RevisionAttachment[], opts: { isCurrentInput?: boolean; textOnly?: boolean; hearing?: { available: boolean }; voiceDurations?: Map<string, number | null> } = {}): { blocks: ProjectedBlock[]; hasImage: boolean; hasVoiceWithoutTranscript: boolean } {
  const isCurrentInput = opts.isCurrentInput === true;
  const textOnly = opts.textOnly === true;
  const hearing = opts.hearing?.available === true;
  const blocks: ProjectedBlock[] = [];
  if (content.length > 0) blocks.push({ type: 'text', text: content });
  let hasImage = false;
  let hasVoiceWithoutTranscript = false;
  for (const a of attachments) {
    if (a.presentation === 'voice') {
      const audioRef = `est:${a.asset_id}`;
      const durMs = opts.voiceDurations?.get(a.asset_id);
      const durText = typeof durMs === 'number' ? `${Math.round(durMs)}ms` : '时长未知';
      // §3.3/§8.1：转写是派生文字——带来源标记进入模型；原音频不再另计模型音频 token。
      // 转写只在投影里出现一次（不进 message.content/attachment 双份）。
      // R3′（2026-10-23）：长转写分页——首页 TRANSCRIPT_PAGE_CHARS 字内（UTF-8 ≤ ~7.4KB，
      // 含标注在转写 8192B 预算内），未完部分用 transcript_read 续读（无 cursor=从头读）；
      // 不静默截断、不拆出无法续读的摘要。
      if (a.derived_text && a.derived_text.trim().length > 0) {
        const chars = [...a.derived_text];
        const totalPages = Math.ceil(chars.length / TRANSCRIPT_PAGE_CHARS);
        const firstPage = totalPages > 1 ? chars.slice(0, TRANSCRIPT_PAGE_CHARS).join('') : a.derived_text;
        const moreHint = totalPages > 1 ? `\n[转写第 1/${totalPages} 页（共 ${chars.length} 字）；续读用 transcript_read（audio_ref="${audioRef}"，无 cursor 从头，翻页传上页 next_cursor）]` : '';
        blocks.push({ type: 'text', text: `[语音消息转写（来源：${a.derived_source ?? 'unspecified'}，派生文字非亲笔正文）]\n${firstPage}${moreHint}${hearing && isCurrentInput ? `\n[原声引用 audio_ref: ${audioRef} | ${durText} | 语气须用 oido_analyze 查询，转写不含语气]` : ''}` });
      } else if (isCurrentInput === true && hearing) {
        // 转写未就绪但听觉可用：有意义的结构化语音引用消息（非空输入），模型可按需深听
        blocks.push({ type: 'text', text: `[语音消息（转写未就绪）| audio_ref: ${audioRef} | ${durText}]\n仅有原声；需声音证据时用 oido_analyze，取得证据前不推断内容或语气。` });
      } else if (isCurrentInput === true) {
        hasVoiceWithoutTranscript = true; // 当前输入无转写且无听觉能力→不空输入唤起模型（门阻断）
      } else {
        // 历史语音无转写：如实占位（模型知道存在语音消息），不静默消失也不空输入阻断
        blocks.push({ type: 'text', text: '[语音消息：本条无转写，原音频已保留]' });
      }
      continue;
    }
    if (textOnly) {
      blocks.push({ type: 'text', text: '[图片消息：按多选裁定不带入本窗，图片未随文本携带]' });
      if (a.caption && a.caption.trim().length > 0) blocks.push({ type: 'text', text: `[附件说明] ${a.caption}` });
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
type VisionCacheEntry = { supported: boolean | null; verifiedAt: number; verifiedMonotonicAt: number };
const visionCache = new Map<string, VisionCacheEntry>();
const DEFAULT_VISION_BASE_URL = 'https://openrouter.ai/api/v1';
const VISION_TTL_MS = 24 * 60 * 60 * 1000;
const VISION_LAST_GOOD_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function visionApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}
function visionCacheKey(baseUrl: string, model: string): string {
  return JSON.stringify([visionApiRoot(baseUrl), model]);
}

/** 测试注入点（离线套件不打网络）。supported=null=未核实；默认源与 OR 配置一致。 */
export function setVisionSupportForTests(model: string, supported: boolean | null, baseUrl = DEFAULT_VISION_BASE_URL): void {
  recordVisionEvidence(visionCacheKey(baseUrl, model), supported);
}
export function clearVisionSupportCache(): void {
  visionCache.clear();
}

function recordVisionEvidence(key: string, supported: boolean | null): void {
  visionCache.set(key, { supported, verifiedAt: Date.now(), verifiedMonotonicAt: performance.now() });
}

/** 两种时钟取保守年龄；观测到硬过期或时钟异常即删除，回拨不能复活旧证据。 */
function currentVisionEvidence(key: string): { entry: VisionCacheEntry; age: number } | null {
  const entry = visionCache.get(key);
  if (!entry) return null;
  const wallAge = Date.now() - entry.verifiedAt;
  const monotonicAge = performance.now() - entry.verifiedMonotonicAt;
  const age = Math.max(wallAge, monotonicAge);
  if (wallAge < 0 || monotonicAge < 0 || !Number.isFinite(age) || age > VISION_LAST_GOOD_MAX_AGE_MS) {
    visionCache.delete(key);
    return null;
  }
  return { entry, age };
}

export function visionSupportCached(model: string, baseUrl = DEFAULT_VISION_BASE_URL): boolean | null {
  const hit = currentVisionEvidence(visionCacheKey(baseUrl, model));
  return hit && hit.age <= VISION_TTL_MS ? hit.entry.supported : null;
}

/** 临时刷新失败只能沿用同源、同型号的已核实支持证据；失败不延长证据期限。 */
function recentVerifiedVision(key: string): boolean | null {
  return currentVisionEvidence(key)?.entry.supported === true ? true : null;
}

/** 从 OR /models 元数据核实 input_modalities；已核实能力缓存 24 小时；临时不可达最多沿用 48 小时内的成功证据（与 prompt 缓存 TTL 无关）。 */
export async function refreshVisionSupport(baseUrl: string, model: string): Promise<boolean | null> {
  const key = visionCacheKey(baseUrl, model);
  let res: Response;
  try {
    res = await fetch(`${visionApiRoot(baseUrl)}/api/v1/models`, { signal: AbortSignal.timeout(4000) });
  } catch {
    // fetch 拒绝=网络/超时；不能因一次目录查询失败把已核实的图片历史整窗阻断。
    return recentVerifiedVision(key);
  }
  if (!res.ok) {
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) return recentVerifiedVision(key);
    visionCache.delete(key);
    return null;
  }
  try {
    const data = await res.json() as { data?: Array<{ id?: string; architecture?: { input_modalities?: unknown } }> } | null;
    const row = Array.isArray(data?.data) ? data.data.find((m) => m?.id === model) : undefined;
    const mods = row?.architecture?.input_modalities;
    const validModalities = Array.isArray(mods) && mods.length > 0 && mods.every((m) => typeof m === 'string' && m.length > 0);
    if (!validModalities) {
      // 目录明确缺型号或形状无效=未核实；不能借旧 true 掩盖这次结果。
      visionCache.delete(key);
      return null;
    }
    const supported = (mods as string[]).includes('image');
    recordVisionEvidence(key, supported);
    return supported;
  } catch (error) {
    // 响应头已到后读取 body 仍可能断网/超时；与已读完整但 JSON 非法区分。
    if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
      return recentVerifiedVision(key);
    }
    visionCache.delete(key);
    return null;
  }
}

/** 容量保守控制（§6.1）：未核实计量方式时每张未知图按保守 token 计（工程默认，非用户批准值）。 */
export const CONSERVATIVE_IMAGE_TOKENS = 1600;
