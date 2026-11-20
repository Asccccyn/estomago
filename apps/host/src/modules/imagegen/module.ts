// 相册重构 P3：image_generate 模型工具。Key 状态只给"是否已配置/可执行"（R12），
// 密钥不进参数示例/日志。回执给稳定 asset 引用与作品条目——不含供应商原始响应。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { ToolExecContext } from '../../capabilities/contracts.ts';
import type { ImageGenService } from './service.ts';
import { imageGenOpKey } from './service.ts';

export const IMAGEGENERATE_DEFINITION: import('../../capabilities/contracts.ts').HostToolSpec = {
  type: 'function' as const,
  function: {
    name: 'image_generate',
    description: '画一张图：默认同一次操作完成 生成→保存为作品→发布到当前聊天（回执 sent=true 即已发送，不要再调用 chat_send_attachment 补发）。她要求先验图再发、或明确只要保存时，传 deliver=save_only 仅保存（之后可用 chat_send_attachment 发送同一 asset_id，不会重新生成）。默认静态图；要 GIF 动图必须显式 format=gif（可配 frame_count 2..16 帧与 frame_duration_ms 每帧毫秒；帧数和尺寸拼成大图受供应商"最长边≤3840"限制，大尺寸请减少帧数，超限组合会在请求前被拒）。失败回执如实分阶段：上游明确失败（含 5xx）retryable=true，同键重试会重新请求上游；结果未确认（超时/断连）不自动重发避免重复计费；已生成保存失败、或已保存发布失败时，同键重试只补缺失阶段，不重新付费生成。同一 client_operation_id 重试沿用同一值。',
    parameters: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' as const, description: '画面描述（你要画什么）' },
        client_operation_id: { type: 'string' as const, description: '本次生成的操作标识（重试沿用同一值）' },
        title: { type: 'string' as const, description: '可选作品标题' },
        format: { type: 'string' as const, enum: ['png', 'jpeg', 'webp', 'gif'] as const, description: '输出格式；动图必须显式 gif（不写默认静态图）' },
        size: { type: 'string' as const, description: '可选尺寸，形如 1024x1024 或 auto' },
        frame_count: { type: 'integer' as const, description: '仅 gif：帧数 2..16' },
        frame_duration_ms: { type: 'integer' as const, description: '仅 gif：每帧毫秒，最低 20（如 200）' },
        deliver: { type: 'string' as const, enum: ['send', 'save_only'] as const, description: '交付方式：默认 send=保存后发布到当前聊天；save_only=仅保存不发送（先验图流程用，之后用 chat_send_attachment 发同一资产）' },
      },
      required: ['prompt', 'client_operation_id'] as const,
      additionalProperties: false as const,
    },
  },
};

export type ImageGenModuleDeps = {
  imagegen: ImageGenService | null;
};

export function registerImageGenCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ImageGenModuleDeps): void {
  registry.register(toolCapability({
    owner: 'imagegen',
    id: 'image_generate', baselineOrder: 50, definition: () => IMAGEGENERATE_DEFINITION, memoryOnlyAllowed: false, label: '生成图片',
    run: (input: { prompt: string; client_operation_id: string; title?: string }, ctx) => runImageGenerate(deps, input, ctx),
    toModel: (value) => value,
  }));
}

async function runImageGenerate(deps: ImageGenModuleDeps, input: { prompt: string; client_operation_id: string; title?: string; format?: string; size?: string; frame_count?: number; frame_duration_ms?: number; deliver?: string }, ctx: ToolExecContext): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  if (!deps.imagegen) return { ok: false, output: { error_code: 'IMAGEGEN_UNCONFIGURED', detail: '图片生成未配置（服务端 Key 缺席）——能力如实不可用，不切换其他供应商' } };
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { ok: false, output: { error_code: 'IMAGEGEN_PROMPT_INVALID', detail: 'prompt 必填' } };
  if (typeof input.client_operation_id !== 'string' || !input.client_operation_id) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: 'client_operation_id 必填（重试沿用同一值）' } };
  const deliver = input.deliver === 'save_only' ? 'save_only' as const : 'send' as const;
  const r = await deps.imagegen.generateAndStore({
    prompt: input.prompt,
    opKey: imageGenOpKey(ctx, input.client_operation_id),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, 200) : null,
    format: typeof input.format === 'string' ? input.format : undefined,
    size: typeof input.size === 'string' ? input.size : undefined,
    frameCount: typeof input.frame_count === 'number' ? input.frame_count : undefined,
    frameDurationMs: typeof input.frame_duration_ms === 'number' ? input.frame_duration_ms : undefined,
    deliver,
    roomId: ctx.roomId,
    turnId: ctx.turnId,
    windowId: ctx.windowId,
    attemptId: ctx.attemptId,
    backgroundRunId: ctx.backgroundRunId,
    signal: ctx.signal,
  });
  if (!r.ok) return { ok: false, output: { error_code: r.code, detail: r.detail, ...(r.retryable ? { retryable: true } : {}), ...(r.saved_asset_id ? { saved: true, asset_id: r.saved_asset_id, creation_id: r.saved_creation_id ?? null } : {}) } };
  return { ok: true, output: {
    generated: true,
    sent: r.published_message_id ? true : false,
    ...(r.published_message_id
      ? { message_id: r.published_message_id }
      : { note: r.note ?? '仅保存未发送（deliver=save_only）——发送用 chat_send_attachment 同一 asset_id' }),
    asset_ref: `est:${r.asset_id}`, asset_id: r.asset_id, creation_id: r.creation_id, mime_type: r.mime,
    ...(r.revised_prompt ? { revised_prompt: r.revised_prompt } : {}),
  } };
}
