// Mariposa 客户端（ESTOMAGO 侧）——契约依据 docs/specs/MARIPOSA_LIFECYCLE_v1.0/contracts/。
//  - transport 注入：离线测试用假 transport；真实 HTTP 形状由 Mariposa 侧落地后在此单一接缝对齐
//    （端到端在 Mariposa 侧接口上线前保持 BLOCKED，不以 mock 全绿冒充联调通过）。
//  - 凭据：credential_ref 只是环境变量名；值在默认 transport 请求头构造处读取，绝不进日志/DB/事件。
//  - 错误码沿用生命周期包 §"必须表达的错误类别"；未识别 code 不吞成成功。
import { sha256Hex } from '../../util/id.ts';

export type MariposaCallResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; httpStatus: number };

export type MariposaTransport = (capability: string, payload: Record<string, unknown>) => Promise<MariposaCallResult>;

// 稳定错误类别（契约 §错误）：retryable=false 的领域冲突/权限问题标 dead，不由宿主盲重试
export const MARIPOSA_ERROR_CODES = [
  'IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT', 'FORBIDDEN', 'SOURCE_NOT_READY',
  'SOURCE_REVISION_CONFLICT', 'SOURCE_HASH_MISMATCH', 'SOURCE_RANGE_NOT_PATH',
  'SOURCE_RANGE_OFFSET', 'SOURCE_SELECTION_TOO_LARGE', 'EPISODE_ALREADY_CLOSED',
  'INVALID_TRANSITION', 'REVIEW_STALE', 'REVIEW_NOT_ACTIVE',
] as const;
export type MariposaErrorCode = (typeof MARIPOSA_ERROR_CODES)[number];

export function isKnownErrorCode(code: string): code is MariposaErrorCode {
  return (MARIPOSA_ERROR_CODES as readonly string[]).includes(code);
}

/** SOURCE_NOT_READY = 依赖缺失可重试（同流有序等待，不跳过）；其余已知领域错误 = dead */
export function classifyError(code: string): 'retry_later' | 'dead' {
  return code === 'SOURCE_NOT_READY' ? 'retry_later' : 'dead';
}

// —— source.ingest 契约形状（§4/接口说明）——
export type IngestMessage = {
  origin_message_id: string;
  revision: number;
  previous_revision: number | null;
  conversation_sequence: number;
  predecessor: { origin_message_id: string; revision: number } | null;
  sender: 'user' | 'assistant';
  published_kind: string;
  occurred_at: string | null;
  received_at: string | null;
  published_at: string | null;
  text: string;
  assets: string[];
  content_hash: string;
};

export type IngestRequest = {
  operation_id: string;
  stream_id: string;
  origin_instance: 'estomago';
  origin_conversation_id: string;
  messages: IngestMessage[];
};

export type IngestAckMessage = {
  origin_message_id: string;
  revision: number;
  source_conversation_id: string | null;
  source_message_id: string | null;
  content_hash: string | null;
};

export type IngestAck = {
  operation_id: string;
  committed_at: string | null;
  messages: IngestAckMessage[];
  batch_ref: string | null;
  integrity: string | null;
};

// —— memory.hold 契约形状（§5）：既有字段不动，宿主自动化路径必须带 operation_id ——
export type HoldSourceSelection = {
  conversation_id: string;
  members: Array<{ source_message_id: string; content_hash: string }>;
  start_char_offset?: number;
  end_char_offset?: number;
};

export type HoldReceipt = {
  operation_id: string;
  memory_id: string;
  version: number;
  binding_ids: string[];
  committed_at: string | null;
};

function defaultTransport(baseUrl: string, credentialEnv: string | null): MariposaTransport {
  return async (capability, payload) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credentialEnv) {
      const v = process.env[credentialEnv];
      if (typeof v === 'string' && v.length > 0) headers.authorization = `Bearer ${v}`;
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/capability/${capability}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, result: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    return { ok: false, code: typeof body.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`, httpStatus: res.status };
  };
}

export class MariposaClient {
  private transport: MariposaTransport;

  constructor(opts: { baseUrl?: string; credentialEnv?: string | null; transport?: MariposaTransport }) {
    this.transport = opts.transport ?? defaultTransport(opts.baseUrl ?? '', opts.credentialEnv ?? null);
  }

  async sourceIngest(req: IngestRequest): Promise<MariposaCallResult & { ack?: IngestAck }> {
    const r = await this.transport('source.ingest', req as unknown as Record<string, unknown>);
    if (!r.ok) return r;
    return { ok: true, result: r.result, ack: parseAck(r.result) };
  }

  /** 同 op 已提交的重放查询（ACK 丢失恢复路径，§4.3/§5） */
  async sourceIngestStatus(operationId: string): Promise<MariposaCallResult & { ack?: IngestAck }> {
    const r = await this.transport('source.ingest.status', { operation_id: operationId });
    if (!r.ok) return r;
    return { ok: true, result: r.result, ack: parseAck(r.result) };
  }

  async memoryHold(args: {
    operationId: string;
    holdPayload: Record<string, unknown>; // 既有业务字段（分类/正文/心情/plan_ids…）原样传递，宿主不改写
    sourceSelections?: HoldSourceSelection[] | null;
  }): Promise<MariposaCallResult & { receipt?: HoldReceipt }> {
    const payload: Record<string, unknown> = {
      operation_id: args.operationId,
      ...args.holdPayload,
      ...(args.sourceSelections ? { source_selections: args.sourceSelections } : {}),
    };
    const r = await this.transport('memory.hold', payload);
    if (!r.ok) return r;
    const r0 = r.result as Partial<HoldReceipt>;
    if (typeof r0.operation_id !== 'string' || typeof r0.memory_id !== 'string' || typeof r0.version !== 'number') {
      return { ok: false, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 };
    }
    return { ok: true, result: r.result, receipt: { operation_id: r0.operation_id, memory_id: r0.memory_id, version: r0.version, binding_ids: Array.isArray(r0.binding_ids) ? r0.binding_ids.filter((x): x is string => typeof x === 'string') : [], committed_at: typeof r0.committed_at === 'string' ? r0.committed_at : null } };
  }

  /** 已提交操作的回执查询：无记录只代表"尚无提交证据"，不是没写过（§5） */
  async holdStatus(operationId: string): Promise<MariposaCallResult & { receipt?: HoldReceipt }> {
    const r = await this.transport('memory.hold.status', { operation_id: operationId });
    if (!r.ok) return r;
    const r0 = r.result as Partial<HoldReceipt> & { found?: boolean };
    if (r0.found === false) return { ok: true, result: r.result };
    if (typeof r0.operation_id !== 'string' || typeof r0.memory_id !== 'string' || typeof r0.version !== 'number') {
      return { ok: false, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 };
    }
    return { ok: true, result: r.result, receipt: { operation_id: r0.operation_id, memory_id: r0.memory_id, version: r0.version, binding_ids: Array.isArray(r0.binding_ids) ? r0.binding_ids.filter((x): x is string => typeof x === 'string') : [], committed_at: typeof r0.committed_at === 'string' ? r0.committed_at : null } };
  }
}

function parseAck(result: Record<string, unknown>): IngestAck | undefined {
  const r0 = result as Partial<IngestAck> & { messages?: unknown };
  if (typeof r0.operation_id !== 'string') return undefined;
  const messages = Array.isArray(r0.messages)
    ? r0.messages.flatMap((m) => {
        const x = m as Partial<IngestAckMessage>;
        if (typeof x.origin_message_id !== 'string' || typeof x.revision !== 'number') return [];
        return [{
          origin_message_id: x.origin_message_id,
          revision: x.revision,
          source_conversation_id: typeof x.source_conversation_id === 'string' ? x.source_conversation_id : null,
          source_message_id: typeof x.source_message_id === 'string' ? x.source_message_id : null,
          content_hash: typeof x.content_hash === 'string' ? x.content_hash : null,
        }];
      })
    : [];
  return {
    operation_id: r0.operation_id,
    committed_at: typeof r0.committed_at === 'string' ? r0.committed_at : null,
    messages,
    batch_ref: typeof r0.batch_ref === 'string' ? r0.batch_ref : null,
    integrity: typeof r0.integrity === 'string' ? r0.integrity : null,
  };
}

/** 稳定 operation_id：同一批 (消息,修订) 集合重试/崩溃恢复后不变——服务端按 op 重放同 ACK（§4.3） */
export function ingestOperationId(originConversationId: string, keys: Array<{ messageId: string; revision: number }>): string {
  const canonical = keys.map((k) => `${k.messageId}@${k.revision}`).sort().join(',');
  return `es-ingest-${sha256Hex(`${originConversationId}|${canonical}`).slice(0, 40)}`;
}
