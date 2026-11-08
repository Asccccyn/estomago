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
    description: '用图片生成模型画一张图并保存为作品（自动进入作品集）。失败时如实返回错误码；同一 client_operation_id 重试不会重复生成或重复计费。生成成功后保存失败会自动重试保存而不重新生成。',
    parameters: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' as const, description: '画面描述（你要画什么）' },
        client_operation_id: { type: 'string' as const, description: '本次生成的操作标识（重试沿用同一值）' },
        title: { type: 'string' as const, description: '可选作品标题' },
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

async function runImageGenerate(deps: ImageGenModuleDeps, input: { prompt: string; client_operation_id: string; title?: string }, ctx: { roomId: string; turnId: string | null; requestId: string; toolCallId?: string | null }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  if (!deps.imagegen) return { ok: false, output: { error_code: 'IMAGEGEN_UNCONFIGURED', detail: '图片生成未配置（服务端 Key 缺席）——能力如实不可用，不切换其他供应商' } };
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { ok: false, output: { error_code: 'IMAGEGEN_PROMPT_INVALID', detail: 'prompt 必填' } };
  if (typeof input.client_operation_id !== 'string' || !input.client_operation_id) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: 'client_operation_id 必填（重试沿用同一值）' } };
  const r = await deps.imagegen.generateAndStore({
    prompt: input.prompt,
    opKey: imageGenOpKey(ctx, input.client_operation_id),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, 200) : null,
  });
  if (!r.ok) return { ok: false, output: { error_code: r.code, detail: r.detail, ...(r.retryable ? { retryable: true } : {}) } };
  return { ok: true, output: { generated: true, asset_ref: `est:${r.asset_id}`, asset_id: r.asset_id, creation_id: r.creation_id, mime_type: r.mime, ...(r.revised_prompt ? { revised_prompt: r.revised_prompt } : {}) } };
}
