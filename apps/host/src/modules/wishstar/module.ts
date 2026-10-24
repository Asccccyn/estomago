// modules/wishstar/module.ts（P04.6）：许愿星 13 项能力登记（逐项显式；无前缀通配）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { WishstarService } from './service.ts';

/** wishstar_write_star 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WISHSTARWRITESTAR_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wishstar_write_star',
      description: '往许愿星（你们的许愿星系统）写一颗星。visible=写进"我们的瓶子"（两人可见）；hidden=先藏进自己的私人瓶子（打开前只有你看得见）。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 5000, description: '星星内容（想许的愿/想记的话）' },
          visibility: { type: 'string', enum: ['visible', 'hidden'], description: 'visible=我们的瓶子；hidden=自己的私人瓶' },
          mood_type: { type: 'string', maxLength: 20, description: '可选：星星的心情境况' },
          mood_text: { type: 'string', maxLength: 200, description: '可选：写星时的一句话心情' },
          note: { type: 'string', maxLength: 500, description: '可选：附注' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一颗' },
        },
        required: ['content', 'visibility', 'idempotency_key'], additionalProperties: false,
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
          special_date_id: { type: 'string', minLength: 1, maxLength: 64, description: '绑定的特殊日期 id（wishstar_special_dates 查）' },
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
          request_id: { type: 'string', minLength: 1, maxLength: 64 },
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
          star_id: { type: 'string', minLength: 1, maxLength: 64 },
          message: { type: 'string', maxLength: 300, description: '可选：递星时捎的一句话' },
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
        properties: { offer_id: { type: 'string', minLength: 1, maxLength: 64 } },
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

export type WishstarModuleDeps = {
  wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null;
};

export function registerWishstarCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: WishstarModuleDeps): void {
  const service = new WishstarService(deps);
  registry.register(toolCapability({
    id: 'wishstar_write_star', baselineOrder: 35, definition: WISHSTARWRITESTAR_DEFINITION, memoryOnlyAllowed: false, label: '往许愿星写了一颗星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_write_star', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_hidden_stars', baselineOrder: 36, definition: WISHSTARHIDDENSTARS_DEFINITION, memoryOnlyAllowed: false, label: '看自己的私人瓶子',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_hidden_stars', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_special_dates', baselineOrder: 37, definition: WISHSTARSPECIALDATES_DEFINITION, memoryOnlyAllowed: false, label: '查特殊日期',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_special_dates', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_start_session', baselineOrder: 38, definition: WISHSTARSTARTSESSION_DEFINITION, memoryOnlyAllowed: false, label: '发起拆星仪式',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_start_session', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_confirm_session', baselineOrder: 39, definition: WISHSTARCONFIRMSESSION_DEFINITION, memoryOnlyAllowed: false, label: '确认拆星仪式',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_confirm_session', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_take_star', baselineOrder: 40, definition: WISHSTARTAKESTAR_DEFINITION, memoryOnlyAllowed: false, label: '拆开一颗星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_take_star', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_finish_session', baselineOrder: 41, definition: WISHSTARFINISHSESSION_DEFINITION, memoryOnlyAllowed: false, label: '完成拆星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_finish_session', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_request_star', baselineOrder: 42, definition: WISHSTARREQUESTSTAR_DEFINITION, memoryOnlyAllowed: false, label: '请求开对方的星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_request_star', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_respond_request', baselineOrder: 43, definition: WISHSTARRESPONDREQUEST_DEFINITION, memoryOnlyAllowed: false, label: '回应开星请求',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_respond_request', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_offer_star', baselineOrder: 44, definition: WISHSTAROFFERSTAR_DEFINITION, memoryOnlyAllowed: false, label: '递一颗星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_offer_star', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_list_offers', baselineOrder: 45, definition: WISHSTARLISTOFFERS_DEFINITION, memoryOnlyAllowed: false, label: '看收到的星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_list_offers', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_accept_offer', baselineOrder: 46, definition: WISHSTARACCEPTOFFER_DEFINITION, memoryOnlyAllowed: false, label: '收下递来的星',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_accept_offer', input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'wishstar_notifications', baselineOrder: 47, definition: WISHSTARNOTIFICATIONS_DEFINITION, memoryOnlyAllowed: false, label: '看许愿星通知',
    run: (input: Record<string, unknown>, ctx) => service.wishstarTool('wishstar_notifications', input, ctx),
    toModel: (value) => value,
  }));
}
