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
      description: '按中文语义找图片候选。scope=chat（默认）在本会话已发布图片里找；scope=stickers 只从表情包分类成员里找（要发表情时用这个）；scope=photos 从相册找收藏照片、截图和新入册的画；scope=creations 从仍归作品库的历史图片或作品图标找（语义检索只覆盖位图；查看可运行作品用 content_creations_read）。各集合 scope 的候选是该分类全部成员。返回候选 asset 引用或 no_match。候选只回答"哪张图可能相关"——图里具体是什么仍用已见图片判断（media_view），不能用检索标签替代看图；不确定就说不确定。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: '中文或任意语言的自然描述' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: '候选数，默认 3' },
          scope: { type: 'string', enum: ['chat', 'stickers', 'photos', 'creations'], description: '候选范围：chat=本会话已发布图片（默认）；stickers=仅表情包分类成员；photos=照片、截图和入册画作；creations=作品库的历史图片或作品图标' },
        },
        required: ['query'], additionalProperties: false,
      },
    }
  };

export const MEDIAVIEW_DEFINITION: HostToolSpec = {
  type:'function',function:{name:'media_view',description:'查看一个已有合法图片引用对应的图片。引用来自 media_search 的已发布聊天图片，或 content_albums_read 的可读相册条目。结果须实际附图片块；URL、ID 或文字说明不等于已看到图片。',parameters:{type:'object',properties:{asset_ref:{type:'string',pattern:'^est:[A-Za-z0-9_-]{1,128}$',description:'按读取结果原样传回 asset_ref'}},required:['asset_ref'],additionalProperties:false}},
};

export type MediaModuleDeps = {
  db?: import('../../db/connection.ts').Db;
  contentClient?: import('../../integrations/content/client.ts').ContentClient | null;
  media?: import('../../media/assets.ts').MediaService | null;
  mediaIndex?: import('../../media/index/service.ts').MediaIndexService | null;
};

export function registerMediaCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: MediaModuleDeps): MediaToolsService {
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
    run: (input: { query: string; limit?: number; scope?: 'chat' | 'stickers' | 'photos' | 'creations' }, ctx) => service.mediaSearch(input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({owner:'media',id:'media_view',baselineOrder:52,definition:MEDIAVIEW_DEFINITION,memoryOnlyAllowed:false,free:true,label:'看图',
    run:(input:{asset_ref:string},ctx)=>service.mediaView(input,ctx),toModel:value=>value,
  }));
  return service;
}
