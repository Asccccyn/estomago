// modules/wishstar/module.ts（P04.6）：许愿星 13 项能力登记（逐项显式；无前缀通配）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import contract from '../../integrations/wishstar/contracts/public-fields.json' with {type:'json'};
import { projectWishstarToolResult } from './projection.ts';
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { WishstarService, WISHSTAR_READ_ACTIONS } from './service.ts';

/** wishstar_write_star 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARWRITESTAR_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_write_star',
      description: '往许愿星（你们的许愿星系统）写一颗星。visible=写进"我们的瓶子"（两人可见）；hidden=先藏进自己的私人瓶子（打开前只有你看得见）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: contract.limits.content, description: '星星内容（想许的愿/想记的话）' },
          visibility: { type: 'string', enum: ['visible', 'hidden'], description: 'visible=我们的瓶子；hidden=自己的私人瓶' },
          mood_type: { type: 'string', maxLength: contract.limits.mood, description: '可选：星星的心情境况' },
          mood_text: { type: 'string', maxLength: contract.limits.mood, description: '可选：写星时的一句话心情' },
          note: { type: 'string', maxLength: contract.limits.note, description: '可选：附注' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一颗' },
        },
        required: ['text', 'visibility', 'idempotency_key'], additionalProperties: false,
      },
    }
  };

/** wishstar_hidden_stars 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARHIDDENSTARS_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_hidden_stars',
      description: '看自己私人瓶子里的星（只有你可见的那些）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

/** wishstar_special_dates 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARSPECIALDATES_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_special_dates',
      description: '查看你们的纪念日和自定义特殊日期（含 id——发起拆星仪式要用 special_date_id 绑定具体日期）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

/** wishstar_start_session 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARSTARTSESSION_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_start_session',
      description: '邀请宿主用户开启一轮共同拆星（纪念日仪式）。必须带 special_date_id；纪念日只能在当天发起，双方额度按当天 0 点冻结；确认前不打开任何星。',
      parameters: {
        type: 'object',
        properties: {
          special_date_id: { type: 'string', minLength: 1, maxLength: 64, description: '绑定的特殊日期 id（wishstar_read(what=dates) 的 id）' },
        },
        required: ['special_date_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_confirm_session 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARCONFIRMSESSION_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_confirm_session',
      description: '确认参与拆星仪式（对方发起后你这边确认；双方确认后才能开始拆星）。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_take_star 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARTAKESTAR_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_take_star',
      description: '在拆星仪式中拆开下一颗星（双方轮流）。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_finish_session 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARFINISHSESSION_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_finish_session',
      description: '完成本轮拆星仪式。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_request_star 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARREQUESTSTAR_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_request_star',
      description: '请求宿主用户打开一颗她藏起来的星（她回应前你看不到内容）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

/** wishstar_respond_request 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARRESPONDREQUEST_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_respond_request',
      description: '回应对方的开星请求：give=打开（可指定给哪一颗，缺省服务端选）；not_now=这次先不给。',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', minLength: 1, maxLength: 64,description:'wishstar_read(what=requests) 的 incoming 项 id，或可信请求回执；不可猜测' },
          decision: { type: 'string', enum: ['give', 'not_now'] },
          star_id: { type: 'string', maxLength: 64, description: '可选：give 时指定给哪一颗' },
        },
        required: ['request_id', 'decision'], additionalProperties: false,
      },
    }
  };

/** wishstar_offer_star 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTAROFFERSTAR_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_offer_star',
      description: '把自己的一颗星递给宿主用户（可捎一句话）。',
      parameters: {
        type: 'object',
        properties: {
          star_id: { type: 'string', minLength: 1, maxLength: 64,description:'自己的星 id，可来自写星回执或 wishstar_read(what=hidden)' },
          message: { type: 'string', maxLength: contract.limits.message, description: '可选：递星时捎的一句话' },
        },
        required: ['star_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_list_offers 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARLISTOFFERS_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_list_offers',
      description: '看收到的星（她递给你的、待收下的）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

/** wishstar_accept_offer 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARACCEPTOFFER_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_accept_offer',
      description: '收下她递来的一颗星。',
      parameters: {
        type: 'object',
        properties: { offer_id: { type: 'string', minLength: 1, maxLength: 64,description:'wishstar_read(what=offers) 的 incoming 项 id' } },
        required: ['offer_id'], additionalProperties: false,
      },
    }
  };

/** wishstar_notifications 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARNOTIFICATIONS_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_notifications',
      description: '看许愿星的通知（谁写了星/递了星/发起仪式等动态）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

export const WISHSTARREAD_DEFINITION: HostToolSpec = {
  type:'function',function:{name:'wishstar_read',description:'读取自己的私人星、纪念日、待收星、开星请求或通知。hidden=自己的私人星，dates=特殊日期（发起仪式所需 id），offers=递星列表（收星所需 id），requests=开星请求（回应所需 id），notifications=通知；读取不打开对方的星。',parameters:{type:'object',properties:{what:{type:'string',enum:Object.keys(WISHSTAR_READ_ACTIONS)}},required:['what'],additionalProperties:false}},
};

export type WishstarModuleDeps = {
  wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null;
  replyTarget?: ConstructorParameters<typeof WishstarService>[0]['replyTarget'];
};

export function registerWishstarCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: WishstarModuleDeps): void {
  const service = new WishstarService(deps);
  registry.register(toolCapability({
    owner: 'wishstar', id: 'wishstar_reply_star', group: 'D', baselineOrder: 62,
    heartbeatAction: 'star_reply',
    memoryOnlyAllowed: false, label: '回应抽到的许愿星',
    definition: { type: 'function', function: {
      name: 'wishstar_reply_star',
      description: '回应本轮心跳已交付的共享星。使用揭牌回执的 reply_ref，直接写文字回应到原星；不是聊天发言。',
      parameters: { type: 'object', properties: {
        reply_ref: { type: 'string', minLength: 1, maxLength: 256, description: '本轮星牌 heartbeat_card.reply_ref' },
        text: { type: 'string', minLength: 1, maxLength: 1000 },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '同键重试同一条回应' },
      }, required: ['reply_ref', 'text', 'idempotency_key'], additionalProperties: false },
    } },
    run: (input: Record<string, unknown>, ctx) => service.replyStar(input, ctx),
    toModel: value => projectWishstarToolResult('wishstar_reply_star', value as Record<string, unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_write_star', baselineOrder: 35, definition: () => WISHSTARWRITESTAR_DEFINITION, memoryOnlyAllowed: false, label: '往许愿星写了一颗星',
    heartbeatAction: 'star_write',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_write_star', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_write_star',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_hidden_stars', legacyOnly: true, replacedBy: 'wishstar_read', baselineOrder: 36, definition: () => WISHSTARHIDDENSTARS_DEFINITION, memoryOnlyAllowed: false, label: '看自己的私人瓶子',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_hidden_stars', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_hidden_stars',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_special_dates', legacyOnly: true, replacedBy: 'wishstar_read', baselineOrder: 37, definition: () => WISHSTARSPECIALDATES_DEFINITION, memoryOnlyAllowed: false, label: '查特殊日期',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_special_dates', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_special_dates',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_start_session', baselineOrder: 38, definition: () => WISHSTARSTARTSESSION_DEFINITION, memoryOnlyAllowed: false, label: '发起拆星仪式',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_start_session', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_start_session',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_confirm_session', baselineOrder: 39, definition: () => WISHSTARCONFIRMSESSION_DEFINITION, memoryOnlyAllowed: false, label: '确认拆星仪式',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_confirm_session', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_confirm_session',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_take_star', baselineOrder: 40, definition: () => WISHSTARTAKESTAR_DEFINITION, memoryOnlyAllowed: false, label: '拆开一颗星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_take_star', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_take_star',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_finish_session', baselineOrder: 41, definition: () => WISHSTARFINISHSESSION_DEFINITION, memoryOnlyAllowed: false, label: '完成拆星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_finish_session', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_finish_session',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_request_star', baselineOrder: 42, definition: () => WISHSTARREQUESTSTAR_DEFINITION, memoryOnlyAllowed: false, label: '请求开对方的星',
    heartbeatAction: 'star_request',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_request_star', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_request_star',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_respond_request', baselineOrder: 43, definition: () => WISHSTARRESPONDREQUEST_DEFINITION, memoryOnlyAllowed: false, label: '回应开星请求',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_respond_request', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_respond_request',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_offer_star', baselineOrder: 44, definition: () => WISHSTAROFFERSTAR_DEFINITION, memoryOnlyAllowed: false, label: '递一颗星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_offer_star', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_offer_star',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_list_offers', legacyOnly: true, replacedBy: 'wishstar_read', baselineOrder: 45, definition: () => WISHSTARLISTOFFERS_DEFINITION, memoryOnlyAllowed: false, label: '看收到的星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_list_offers', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_list_offers',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_accept_offer', baselineOrder: 46, definition: () => WISHSTARACCEPTOFFER_DEFINITION, memoryOnlyAllowed: false, label: '收下递来的星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_accept_offer', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_accept_offer',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({
    owner: 'wishstar',
    id: 'wishstar_notifications', legacyOnly: true, replacedBy: 'wishstar_read', baselineOrder: 47, definition: () => WISHSTARNOTIFICATIONS_DEFINITION, memoryOnlyAllowed: false, label: '看许愿星通知',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_notifications', input, ctx),
    toModel: (value) => projectWishstarToolResult('wishstar_notifications',value as Record<string,unknown>),
  }));
  registry.register(toolCapability({owner:'wishstar',id:'wishstar_read',baselineOrder:36,definition:WISHSTARREAD_DEFINITION,memoryOnlyAllowed:false,label:'读许愿星',
    quote:(db,input)=>quoteBackgroundTool(db,input?.what==='requests'?'wishstar_read':WISHSTAR_READ_ACTIONS[input!.what as keyof typeof WISHSTAR_READ_ACTIONS]),
    run:(input:Record<string,unknown>,ctx)=>service.wishstarTool(WISHSTAR_READ_ACTIONS[input.what as keyof typeof WISHSTAR_READ_ACTIONS],{},ctx),
    toModel:(value,input)=>projectWishstarToolResult(WISHSTAR_READ_ACTIONS[input.what as keyof typeof WISHSTAR_READ_ACTIONS],value as Record<string,unknown>),
  }));

}
