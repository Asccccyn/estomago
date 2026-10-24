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

export type VoiceModuleDeps = { db: Db; sirenCall: SirenAdapter | null; programFacts?: ProgramFactsPort | null };

/** 装配入口：把 voice 域已迁能力登记进 registry（app-context 在 supervisor 就绪后调用——
 *  ProgramFactsPort 绑定当前唯一执行链的窄入口）。 */
export function registerVoiceCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: VoiceModuleDeps): void {
  const transcripts = new VoiceTranscriptService({ db: deps.db });
  registry.register({
    id: 'transcript_read',
    owner: 'voice',
    baselineOrder: 29,
    definition: TRANSCRIPT_READ_DEFINITION,
    memoryOnlyAllowed: true,
    label: 'transcript_read',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'transcript_read'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: TranscriptReadInput } | { ok: false; code: string; detail: string },
    run: (input, ctx) => Promise.resolve(transcripts.read(input, ctx)),
    toModel: (value) => value,
  });
  const calls = new VoiceCallService(deps);
  registry.register({
    id: 'call_control',
    owner: 'voice',
    baselineOrder: 25,
    definition: CALL_CONTROL_DEFINITION,
    memoryOnlyAllowed: true,
    label: '通话控制',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'call_control'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: CallControlInput } | { ok: false; code: string; detail: string },
    run: (input, ctx) => calls.control(input, ctx),
    toModel: (value) => value,
  });
}
