// modules/content/module.ts（P04.7）：content 域 4 项能力登记。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { ContentToolsService } from './service.ts';

/** content_post_create 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONTENTPOSTCREATE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'content_post_create',
      description: '以char身份在私密朋友圈发布帖子。presentation=post（普通动态）或 letter（信式排版——同一数据模型仅展示不同）。正文非空或至少一项附件。',
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
      description: '保存char写好的 SVG/HTML 小作品为持久资产（返回 asset_id）。format=svg 固定对应 image/svg+xml，format=html 固定对应 text/html。不执行作品代码——仅安全保存字节。用途限定纪念图标/作品。',
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

export type ContentModuleDeps = {
  contentClient?: import('../../integrations/content/client.ts').ContentClient | null;
  media?: import('../../media/assets.ts').MediaService | null;
};

export function registerContentCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ContentModuleDeps): void {
  const service = new ContentToolsService(deps);
  registry.register(toolCapability({
    id: 'content_post_create', baselineOrder: 16, definition: CONTENTPOSTCREATE_DEFINITION, memoryOnlyAllowed: false, label: '发作品',
    run: (input: Record<string, unknown>, ctx) => service.contentPostCreate(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'content_comment_create', baselineOrder: 17, definition: CONTENTCOMMENTCREATE_DEFINITION, memoryOnlyAllowed: false, label: '评论作品',
    run: (input: Record<string, unknown>, ctx) => service.contentCommentCreate(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'content_posts_list', baselineOrder: 18, definition: CONTENTPOSTSLIST_DEFINITION, memoryOnlyAllowed: false, label: '看作品列表',
    run: (input: Record<string, unknown>, ctx) => service.contentPostsList(input as never, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'creation_save_artifact', baselineOrder: 19, definition: CREATIONSAVEARTIFACT_DEFINITION, memoryOnlyAllowed: false, label: '保存小作品',
    run: (input: Record<string, unknown>, ctx) => service.creationSaveArtifact(input as never, ctx),
    toModel: (value) => value,
  }));
}
