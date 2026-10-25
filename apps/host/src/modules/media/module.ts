// modules/media/module.ts（P04.9）：media 域 2 项能力登记。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { MediaToolsService } from './service.ts';

/** media_import 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const MEDIAIMPORT_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'media_import',
      description: '把一个外部图片 URL 持久导入为本站资产（返回 asset_id/实际类型/大小）。链接只是导入来源；导入后用 asset_id 发送或建立内容引用。仅 https 公网图片。',
      parameters: {
        type: 'object',
        properties: {
          source_url: { type: 'string', minLength: 8, maxLength: 2048 },
        },
        required: ['source_url'], additionalProperties: false,
      },
    }
  };

/** media_search 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const MEDIASEARCH_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'media_search',
      description: '按中文语义在她发过的图片里找候选（如"那张水獭的图"）。返回候选 asset 引用或 no_match。候选只回答"哪张图可能相关"——图里具体是什么仍用已见图片判断，不能用检索标签替代看图；不确定就说不确定。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: '中文或任意语言的自然描述' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: '候选数，默认 3' },
        },
        required: ['query'], additionalProperties: false,
      },
    }
  };

export type MediaModuleDeps = {
  media?: import('../../media/assets.ts').MediaService | null;
  mediaIndex?: import('../../media/index/service.ts').MediaIndexService | null;
};

export function registerMediaCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: MediaModuleDeps): void {
  const service = new MediaToolsService(deps);
  registry.register(toolCapability({
    owner: 'media',
    id: 'media_import', baselineOrder: 23, definition: () => MEDIAIMPORT_DEFINITION, memoryOnlyAllowed: false, label: '导入图片',
    run: (input: { source_url: string }, ctx) => service.mediaImport(input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'media',
    id: 'media_search', baselineOrder: 27, definition: () => MEDIASEARCH_DEFINITION, memoryOnlyAllowed: false, label: '找图',
    run: (input: { query: string; limit?: number }, ctx) => service.mediaSearch(input, ctx),
    toModel: (value) => value,
  }));
}
