// 相册重构 P3：image_generate 模型工具。Key 状态只给"是否已配置/可执行"（R12），
// 密钥不进参数示例/日志。回执给稳定 asset 引用与作品条目——不含供应商原始响应。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { ImageGenService } from './service.ts';
import { imageGenOpKey } from './service.ts';

export const IMAGEGENERATE_DEFINITION: import('../../capabilities/contracts.ts').HostToolSpec = {
  type: 'function' as const,
  function: {
    name: 'image_generate',
    description: '用图片生成模型画一张图并保存为作品（自动进入作品集）。默认静态图；她要 GIF 动图时必须显式 format=gif（可配 frame_count 2..16 帧与 frame_duration_ms 每帧毫秒），聊天窗口会自动循环播放。失败时如实返回错误码；同一 client_operation_id 重试不会重复生成或重复计费。生成成功后保存失败会自动重试保存而不重新生成。',
    parameters: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' as const, description: '画面描述（你要画什么）' },
        client_operation_id: { type: 'string' as const, description: '本次生成的操作标识（重试沿用同一值）' },
        title: { type: 'string' as const, description: '可选作品标题' },
        format: { type: 'string' as const, enum: ['png', 'jpeg', 'webp', 'gif'] as const, description: '输出格式；动图必须显式 gif（不写默认静态图）' },
        size: { type: 'string' as const, description: '可选尺寸，形如 1024x1024' },
        frame_count: { type: 'integer' as const, description: '仅 gif：帧数 2..16' },
        frame_duration_ms: { type: 'integer' as const, description: '仅 gif：每帧毫秒（如 200）' },
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

async function runImageGenerate(deps: ImageGenModuleDeps, input: { prompt: string; client_operation_id: string; title?: string; format?: string; size?: string; frame_count?: number; frame_duration_ms?: number }, ctx: { roomId: string; turnId: string | null; requestId: string; toolCallId?: string | null }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  if (!deps.imagegen) return { ok: false, output: { error_code: 'IMAGEGEN_UNCONFIGURED', detail: '图片生成未配置（服务端 Key 缺席）——能力如实不可用，不切换其他供应商' } };
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { ok: false, output: { error_code: 'IMAGEGEN_PROMPT_INVALID', detail: 'prompt 必填' } };
  if (typeof input.client_operation_id !== 'string' || !input.client_operation_id) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: 'client_operation_id 必填（重试沿用同一值）' } };
  const r = await deps.imagegen.generateAndStore({
    prompt: input.prompt,
    opKey: imageGenOpKey(ctx, input.client_operation_id),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, 200) : null,
    format: typeof input.format === 'string' ? input.format : undefined,
    size: typeof input.size === 'string' ? input.size : undefined,
    frameCount: typeof input.frame_count === 'number' ? input.frame_count : undefined,
    frameDurationMs: typeof input.frame_duration_ms === 'number' ? input.frame_duration_ms : undefined,
  });
  if (!r.ok) return { ok: false, output: { error_code: r.code, detail: r.detail, ...(r.retryable ? { retryable: true } : {}) } };
  return { ok: true, output: { generated: true, asset_ref: `est:${r.asset_id}`, asset_id: r.asset_id, creation_id: r.creation_id, mime_type: r.mime, ...(r.revised_prompt ? { revised_prompt: r.revised_prompt } : {}) } };
}
