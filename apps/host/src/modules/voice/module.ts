// modules/voice/module.ts（P03.4/P03.5）：voice 域能力登记（transcript_read、call_control）。
// 定义逐字搬迁为唯一正本；quote 沿 quoteBackgroundTool（transcript_read 在 verified-free 名单，
// call_control 不在）；memoryOnlyAllowed 按 MEMORY_ONLY_TOOLS 现行清单逐项声明（D39）。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { validateArgsAgainstSchema } from '../../capabilities/validation.ts';
import type { CapabilityDescriptor, } from '../../capabilities/registry.ts';
import type { HostToolSpec, ProgramFactsPort } from '../../capabilities/contracts.ts';
import { VoiceTranscriptService, type TranscriptReadInput } from './transcript-service.ts';
import { VoiceSendService } from './voice-send.ts';
import { VoiceCallService, type CallControlInput } from './call-service.ts';

/** transcript_read 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const TRANSCRIPT_READ_DEFINITION: HostToolSpec = {
  type: 'function',
  function: {
    // R3′（2026-10-23）：长转写稳定续读——cursor 绑定 (asset, offset, 总字数)，
    // 读取时按当前会话+活资产+可信转写复验（E10 同门），源变更如实报不静默重读
    name: 'transcript_read',
    description: '读取语音消息转写的下一页（长转写分页续读）。audio_ref 如 "est:<asset_id>"；首页可不带 cursor（从头读）；翻页带上页 next_cursor。源被删除或转写版本变化时如实报错，不静默重读。',
    parameters: {
      type: 'object',
      properties: {
        audio_ref: { type: 'string', pattern: '^est:[A-Za-z0-9_-]{1,128}$', description: '语音消息块里的原声引用' },
        cursor: { type: 'string', minLength: 8, maxLength: 200, description: '上页 next_cursor（首页省略）' },
      },
      required: ['audio_ref'], additionalProperties: false,
    },
  },
};

/** call_control 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const CALL_CONTROL_DEFINITION: HostToolSpec = {
  type: 'function',
  function: {
    name: 'call_control',
    description: '通话控制（协议①2026-10-24）：action=invite 给当前会话的她发出来电邀请（她页面会显示来电；她可以接听或拒接——拒接就是拒接，不自动补打）。邀请过期由服务端管理；她没接≠她拒绝。action=status 查询当前邀请状态。普通聊天与通话内均可用于接通相关控制；不能用于其他业务动作。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['invite', 'status', 'end', 'cancel', 'accept_call', 'decline_call'], description: 'invite=发起来电邀请；status=查询当前邀请；end=提出挂断当前通话（柔性：她说什么都会取消，不是说出口就立刻挂）；cancel=取消自己刚发起、还没被接听的邀请；accept_call=接听她刚发起的语音通话请求；decline_call=拒绝她的通话请求（拒绝后在同一回复里对她说一句为什么/改约——她会看到）' },
        ttl_seconds: { type: 'integer', minimum: 5, maximum: 3600, description: '可选：邀请有效期秒数（缺省 45）' },
      },
      required: ['action'], additionalProperties: false,
    },
  },
};

export type VoiceModuleDeps = { db: Db; sirenCall: SirenAdapter | null; programFacts?: ProgramFactsPort | null; media?: import('../../media/assets.ts').MediaService; messages?: import('../../messages/service.ts').MessageService };

/** chat_send_voice 定义唯一正本（GLM_VOICE_UNIFICATION 04§5.3，A05）：
 *  char主动决定用语音说某句时的唯一出口（P08：不自动朗读文字）。 */
export const CHAT_SEND_VOICE_DEFINITION: HostToolSpec = {
  type: 'function',
  function: {
    name: 'chat_send_voice',
    description: '把一句话用你的语音发给她（生成真实语音消息，她会听到你的声音）。只在两种情况使用：她明确说想听你说/听这条内容；你自己决定这句话用语音说更合适。普通回复默认文字，不要每条都用。text=她将看到的正文（与语音一致）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4000, description: '语音消息的正文（她会看到这段字，也是合成的源文本）' },
        tts_script: { type: 'string', maxLength: 8000, description: '可选：交给 TTS 的表达文本（可含情绪标记），缺省用 text' },
        emotion: { type: 'string', description: '可选：情绪风格（如 softly/warm，按合成服务支持）' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: '可选：语速（0.5-2，缺省 1）' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
};

/** 装配入口：把 voice 域已迁能力登记进 registry（app-context 在 supervisor 就绪后调用——
 *  ProgramFactsPort 绑定当前唯一执行链的窄入口）。 */
export function registerVoiceCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: VoiceModuleDeps & { events?: import('../../events/service.ts').EventService | null }): void {
  const transcripts = new VoiceTranscriptService({ db: deps.db });
  registry.register({
    id: 'transcript_read',
    owner: 'voice',
    baselineOrder: 29,
    definition: () => TRANSCRIPT_READ_DEFINITION,
    memoryOnlyAllowed: true,
    label: 'transcript_read',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'transcript_read'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: TranscriptReadInput } | { ok: false; code: string; detail: string },
    run: (input, ctx) => Promise.resolve(transcripts.read(input, ctx)),
    toModel: (value) => value,
  });
  // GLM_VOICE_UNIFICATION A05：模型主动语音——需要 media（资产）与 messages（发布）。
  // 未装配（测试最小 deps）=工具不注册，如实缺失而非运行时崩。
  if (deps.media && deps.messages) {
    const sender = new VoiceSendService({
      db: deps.db, sirenCall: deps.sirenCall, media: deps.media,
      // RR-06：主动语音走正式消息发布事件/SSE（同一 message.published 合同）
      publish: (opts) => deps.messages!.publishAssistantMessage({ ...opts, events: deps.events ?? null }) as never,
    });
    registry.register({
      id: 'chat_send_voice',
      owner: 'voice',
      baselineOrder: 26,
      definition: () => CHAT_SEND_VOICE_DEFINITION,
      memoryOnlyAllowed: false, // 通话中无此需求（通话内语音由通话链承担）；聊天期可用
      label: '发一条语音',
      silent: false,
      quote: (db) => quoteBackgroundTool(db, 'chat_send_voice'),
      parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string },
      run: (input, ctx) => sender.send(input as never, ctx) as never,
      toModel: (value) => value,
    });
  }
  const calls = new VoiceCallService(deps);
  registry.register({
    id: 'call_control',
    owner: 'voice',
    baselineOrder: 25,
    definition: () => CALL_CONTROL_DEFINITION,
    memoryOnlyAllowed: true,
    label: '通话控制',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'call_control'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: CallControlInput } | { ok: false; code: string; detail: string },
    run: (input, ctx) => calls.control(input, ctx),
    toModel: (value) => value,
  });
}
