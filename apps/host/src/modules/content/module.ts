// modules/content/module.ts（P04.7）：content 域 4 项能力登记。
import { CONTENT_ALBUMS } from '../../../../../packages/contracts/src/content.ts';
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { ContentToolsService } from './service.ts';

/** content_post_create 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONTENTPOSTCREATE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_post_create',
      description: '以你的身份在私密朋友圈发布帖子。presentation=post（普通动态）或 letter（信式排版——同一数据模型仅展示不同）。正文非空或至少一项附件。',
      parameters: {
        type: 'object',
        properties: {
          presentation: { type: 'string', enum: ['post', 'letter'] },
          title: { type: 'string', maxLength: 200 },
          body: { type: 'string', maxLength: 40000 },
          asset_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['body', 'idempotency_key'], additionalProperties: false,
      },
    }
  };

/** content_comment_create 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONTENTCOMMENTCREATE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_comment_create',
      description: '对私密朋友圈帖子添加评论。',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string', minLength: 1, maxLength: 128 },
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['post_id', 'body', 'idempotency_key'], additionalProperties: false,
      },
    }
  };

/** content_posts_list 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONTENTPOSTSLIST_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_posts_list',
      description: '列出私密朋友圈帖子（分页）。',
      parameters: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'number' },
          presentation: { type: 'string', enum: ['post', 'letter'] },
        },
        additionalProperties: false,
      },
    }
  };

/** creation_save_artifact 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CREATIONSAVEARTIFACT_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'creation_save_artifact',
      description: '保存你写好的 SVG/HTML 小作品为持久资产（返回 asset_id）。format=svg 固定对应 image/svg+xml，format=html 固定对应 text/html。不执行作品代码——仅安全保存字节。用途限定纪念图标/作品。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['svg', 'html'] },
          content: { type: 'string', minLength: 1, maxLength: 262144 },
          client_operation_id: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['format', 'content', 'client_operation_id'], additionalProperties: false,
      },
    }
  };

export const CONTENTALBUMSREAD_DEFINITION: HostToolSpec = {
  type:'function',function:{name:'content_albums_read',description:'浏览当前身份可读的相册和条目。不带 album 列相册；带 album 分页读条目，可按说明文字或完整来源引用过滤。条目仅给图片引用，用 media_view 实际看图。',parameters:{type:'object',properties:{
    album:{type:'string',enum:CONTENT_ALBUMS.map(a=>a.album),description:'相册列表中的 album'},
    cursor:{type:'string',minLength:1,description:'同相册同查询上一页 next_cursor'},
    limit:{type:'integer',minimum:1,maximum:100,description:'每页数量，默认 20'},
    q:{type:'string',description:'按标题/说明文字查询，不依赖向量索引'},
    source_service:{type:'string',minLength:1},source_kind:{type:'string',minLength:1},source_id:{type:'string',minLength:1,description:'可选完整来源三元组，与 source_service/source_kind 同时提供'},
  },additionalProperties:false,dependencies:{cursor:['album'],q:['album'],source_service:['album','source_kind','source_id'],source_kind:['album','source_service','source_id'],source_id:['album','source_service','source_kind']}}},
};

/** R5（复审 2026-11-08）：相册写工具——收藏/归类/携带模式一体。
 *  M07（包1 2026-11-15，宿主用户裁定）：修改留言是修改不是新增（可修改/编辑/删除）——
 *  省略=保留原值、空串=清空，同资产新键=更新既有条目不占携带名额。 */
export const CONTENTALBUMENTRYWRITE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_album_entry_write',
      description: '把一张图片收入相册，或修改已收藏的条目（收藏/归类/携带一体）。kind=important_photos 收藏重要照片（可附当时的原话 caption 与你的说明 meaning），kind=stickers 归入表情包。carry_mode 仅 important_photos 有效（none=仅收藏；next_once=下次滚窗带一次；always=每次滚窗都带）。更新已有条目：caption/meaning 显式给出才更新（空串=删除留言），省略=保留原值；修改留言不算新增一张、不占携带名额；显式 carry_mode=none=撤销携带（不删除收藏）。同 idempotency_key 重试幂等返回原结果。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: CONTENT_ALBUMS.filter(a => a.album !== 'chat_screenshots').map(a => a.album), description: '目标相册' },
          asset_id: { type: 'string', minLength: 1, maxLength: 128, description: '图片资产 id（先经媒体服务持久保存，如聊天图片/生成图）' },
          caption: { type: 'string', maxLength: 2000, description: '原话留言；更新已有条目时给出新值则替换、空串=删除留言、省略=保留原值' },
          meaning: { type: 'string', maxLength: 2000, description: '你对这张图的说明；更新语义同 caption（空串=清空、省略=保留）' },
          carry_mode: { type: 'string', enum: ['none', 'next_once', 'always'], description: '滚窗携带模式；新建省略=none 仅收藏，更新省略=保留原值' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '操作幂等键；重试沿用同一值' },
        },
        required: ['kind', 'asset_id', 'idempotency_key'], additionalProperties: false,
      },
    }
  };

/** M06（包1 2026-11-15）：作品集读取入口——分页发现全部作品（含 SVG/HTML），
 *  不依赖"记得生成回执"。图片作品给 asset_ref；代码作品给 preview_ref。 */
export const CONTENTCREATIONSREAD_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_creations_read',
      description: '浏览作品集（分页）。含生成图与 SVG/HTML 代码作品：图片作品返回 asset_ref（用 media_view 看图、chat_send_attachment 发送）；SVG/HTML 返回 preview_ref 沙箱预览入口（模型不直接看图，发送用 chat_send_attachment presentation=work）。这是跨窗口重新找到已保存作品的读取入口。',
      parameters: {
        type: 'object',
        properties: {
          cursor: { type: 'string', minLength: 1, description: '上一页返回的 next_cursor' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 20' },
        },
        additionalProperties: false,
      },
    }
  };

export type ContentModuleDeps = {
  contentClient?: import('../../integrations/content/client.ts').ContentClient | null;
  media?: import('../../media/assets.ts').MediaService | null;
  contentOps?: import('../../integrations/content/coordinator.ts').ContentOperationCoordinator | null;
};

export function registerContentCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ContentModuleDeps): void {
  const service = new ContentToolsService(deps);
  registry.register(toolCapability({
    owner: 'content',
    id: 'content_post_create', baselineOrder: 16, definition: () => CONTENTPOSTCREATE_DEFINITION, memoryOnlyAllowed: false, label: '发作品',
    run: (input: Record<string, unknown>, ctx) => service.contentPostCreate(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'content',
    id: 'content_comment_create', baselineOrder: 17, definition: () => CONTENTCOMMENTCREATE_DEFINITION, memoryOnlyAllowed: false, label: '评论作品',
    run: (input: Record<string, unknown>, ctx) => service.contentCommentCreate(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'content',
    id: 'content_posts_list', baselineOrder: 18, definition: () => CONTENTPOSTSLIST_DEFINITION, memoryOnlyAllowed: false, label: '看作品列表',
    run: (input: Record<string, unknown>, ctx) => service.contentPostsList(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'content',
    id: 'creation_save_artifact', group: 'D', baselineOrder: 19, free: true, definition: () => CREATIONSAVEARTIFACT_DEFINITION, memoryOnlyAllowed: false, label: '保存小作品',
    run: (input: Record<string, unknown>, ctx) => service.creationSaveArtifact(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({owner:'content',id:'content_albums_read',baselineOrder:51,definition:CONTENTALBUMSREAD_DEFINITION,memoryOnlyAllowed:false,free:true,label:'浏览相册',
    run:(input:Record<string,unknown>,ctx)=>service.contentAlbumsRead(input,ctx),toModel:value=>value,
  }));
  registry.register(toolCapability({owner:'content',id:'content_album_entry_write',baselineOrder:52,definition:CONTENTALBUMENTRYWRITE_DEFINITION,memoryOnlyAllowed:false,free:true,label:'收藏入相册',
    run:(input:Record<string,unknown>,ctx)=>service.contentAlbumEntryWrite(input as never,ctx),toModel:value=>value,
  }));
  registry.register(toolCapability({owner:'content',id:'content_creations_read',baselineOrder:53,definition:CONTENTCREATIONSREAD_DEFINITION,memoryOnlyAllowed:false,free:true,label:'浏览作品集',
    run:(input:Record<string,unknown>,ctx)=>service.contentCreationsRead(input as never,ctx),toModel:value=>value,
  }));

}
