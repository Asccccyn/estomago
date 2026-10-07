// Mariposa 客户端（ESTOMAGO 侧）——契约依据 docs/specs/MARIPOSA_LIFECYCLE_v1.0/contracts/。
//  - transport 注入：离线测试用假 transport；真实 HTTP 形状由 Mariposa 侧落地后在此单一接缝对齐
//    （端到端在 Mariposa 侧接口上线前保持 BLOCKED，不以 mock 全绿冒充联调通过）。
//  - 凭据：credential_ref 只是环境变量名；值在默认 transport 请求头构造处读取，绝不进日志/DB/事件。
//  - 错误码沿用生命周期包 §"必须表达的错误类别"；未识别 code 不吞成成功。
import { sha256Hex } from '../../util/id.ts';
import { validateAbsoluteIso } from '../../util/time.ts';

export type MariposaCallResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; httpStatus: number };

export type MariposaTransport = (capability: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<MariposaCallResult>;

// F-J-14（联合审计 2026-10-06）：移除手工维护的错误码清单（MARIPOSA_ERROR_CODES/
// isKnownErrorCode）——该副本含 3 个 mariposa 不存在的码（EPISODE_ALREADY_CLOSED/
// REVIEW_STALE/REVIEW_NOT_ACTIVE）、缺 ≥8 个真实码，且全仓零调用；重试语义已按
// httpStatus 分类（classifyError），未知码的 dead/unknown 兜底不受影响。真实码
// 正本=mariposa input_schemas/registry；跨仓契约漂移防护=tests/unit/
// joint-audit-b4-contract.test.ts（F-J-13）。

/** 可重试分类（审计 1005B 根因修复）：HTTP 语义优先，结构化码只做领域细分。
 *  此前只按 code 字符串匹配——mariposa 429 的结构化码是 RATE_LIMITED，
 *  永远不等于 'HTTP_429'（该分支不可达），一次限流就把归档批次连同全部
 *  消息行判成永久 dead（与 F15"429 可重试"的设计意图相反）。
 *  分类依据改为 httpStatus（MariposaCallResult 已携带，fetch 层天然知道）：
 *  429=限流、423=AUTH_LOCKED 门禁锁（指数退避后可解）、502/503/504=上游
 *  瞬时故障一律 retry_later——不管服务端结构化码叫什么名字。code 参数
 *  保留领域细分（SOURCE_NOT_READY 等无状态码语义的依赖缺失）与无状态
 *  合成码（TRANSPORT_*）兜底。 */
export function classifyError(code: string, httpStatus?: number): 'retry_later' | 'dead' {
  if (httpStatus !== undefined) {
    if (httpStatus === 429 || httpStatus === 423
        || httpStatus === 500 || httpStatus === 502
        || httpStatus === 503 || httpStatus === 504) return 'retry_later';
  }
  if (code === 'SOURCE_NOT_READY' || code === 'AUTH_LOCKED') return 'retry_later';
  if (code === 'HTTP_429' || code === 'HTTP_500' || code === 'HTTP_502' || code === 'HTTP_503' || code === 'HTTP_504') return 'retry_later';
  return 'dead';
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
  // 真实 HTTP 表面（2026-10-05 与 mariposa 实施对齐，c9a2af8/43444cb）：
  //  /api/capability/X（无 v1 前缀）、请求 {arguments:{...}} 信封、成功响应
  //  {ok,data} 取 data、错误读 error.code。离线 fake transport 不经过此处；
  //  端到端仍待真实凭据与联调授权。
  return async (capability, payload, signal) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credentialEnv) {
      const v = process.env[credentialEnv];
      if (typeof v === 'string' && v.length > 0) headers.authorization = `Bearer ${v}`;
    }
    // R10（复审 2026-10-07）：取消信号传递到 socket——准备阶段可取消，
    // bootstrap 有受控截止时间
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/capability/${capability}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ arguments: payload }),
      ...(signal ? { signal } : {}),
    });
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: Record<string, unknown>;
        error?: { code?: string };
      };
      if (body.ok === false) {
        return { ok: false, code: typeof body.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`, httpStatus: res.status };
      }
      return { ok: true, result: (body.data ?? {}) as Record<string, unknown> };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    // D22（审计 3655d60）：5xx 不论响应体是否带结构化错误码，都按传输层状态分类为 HTTP_5xx——
    // 调用方（hold/archive）将 5xx 归"结果不明 unknown"并有界核实，不当确定失败。
    if (res.status >= 500) return { ok: false, code: `HTTP_${res.status}`, httpStatus: res.status };
    return { ok: false, code: typeof body.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`, httpStatus: res.status };
  };
}

/** D17（审计 3655d60）：hold 回执完整形状校验——非空 operation_id/memory_id、正整数 version、
 *  array 形状 binding_ids、合法绝对 ISO committed_at；不合格=RECEIPT_SHAPE_INVALID（上层归 unknown，
 *  不给弱回执签"已核实提交"）。 */
function parseHoldReceiptShape(r0: Partial<HoldReceipt>): HoldReceipt | null {
  if (typeof r0.operation_id !== 'string' || r0.operation_id.length === 0) return null;
  if (typeof r0.memory_id !== 'string' || r0.memory_id.length === 0) return null;
  if (typeof r0.version !== 'number' || !Number.isSafeInteger(r0.version) || r0.version < 1) return null;
  if (typeof r0.committed_at !== 'string' || !validateAbsoluteIso(r0.committed_at).ok) return null;
  if (r0.binding_ids !== undefined && !Array.isArray(r0.binding_ids)) return null;
  return {
    operation_id: r0.operation_id,
    memory_id: r0.memory_id,
    version: r0.version,
    binding_ids: Array.isArray(r0.binding_ids) ? r0.binding_ids.filter((x): x is string => typeof x === 'string') : [],
    committed_at: r0.committed_at,
  };
}

/** F-J-12（联合审计 2026-10-06）：按 mariposa 服务端规范化口径计字节——
 * 服务端对规范化 payload 做 json.dumps(ensure_ascii=False, sort_keys=True,
 * default=str)（Python 默认分隔符 ', '/': '）后 UTF-8 计数并与 1MiB 门比较。
 * 此前客户端按紧凑 JSON.stringify({arguments:req}) 计（紧凑分隔符+插入序+信封
 * 包装）：服务端度量典型偏大，临界批被 SOURCE_SELECTION_TOO_LARGE 判 dead。
 * 本函数不含 HTTP 信封包装（服务端门也不含）。与 Python 序列化的等价性由
 * tests/unit/joint-audit-b4-contract.test.ts 的跨语言黄金夹具互证。
 */
export function serverNormalizedBytes(payload: unknown): number {
  const pyJson = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
    if (typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pyJson(rec[k])).join(', ') + '}';
    }
    return JSON.stringify(String(v)); // default=str 兜底（estómago 字段均为 JSON 类型）
  };
  return Buffer.byteLength(pyJson(payload), 'utf8');
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

  /** 同 op 已提交的重放查询（ACK 丢失恢复路径，§4.3/§5）。
   *  mariposa 实施形状：{operation_id, completed, receipt}——回执在
   *  receipt 内层；completed=false 即尚无提交证据（不是失败）。 */
  async sourceIngestStatus(operationId: string): Promise<MariposaCallResult & { ack?: IngestAck }> {
    const r = await this.transport('source.ingest.status', { operation_id: operationId });
    if (!r.ok) return r;
    const s = r.result as { completed?: boolean; receipt?: Record<string, unknown> };
    if (s.completed === true && s.receipt) {
      return { ok: true, result: r.result, ack: parseAck(s.receipt) };
    }
    return { ok: true, result: r.result };
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
    const parsed = parseHoldReceiptShape(r.result as Partial<HoldReceipt>);
    if (!parsed) return { ok: false, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 };
    return { ok: true, result: r.result, receipt: parsed };
  }

  /** 已提交操作的回执查询：无记录只代表"尚无提交证据"，不是没写过（§5）。
   *  mariposa 实施形状：{operation_id, completed, receipt, memory_current}
   *  ——回执在 receipt 内层；completed=false 即尚无提交证据。 */
  async holdStatus(operationId: string): Promise<MariposaCallResult & { receipt?: HoldReceipt }> {
    const r = await this.transport('memory.hold.status', { operation_id: operationId });
    if (!r.ok) return r;
    const s = r.result as { completed?: boolean; receipt?: Record<string, unknown> };
    if (s.completed !== true || !s.receipt) return { ok: true, result: r.result };
    const parsed = parseHoldReceiptShape(s.receipt as Partial<HoldReceipt>);
    if (!parsed) return { ok: false, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 };
    return { ok: true, result: r.result, receipt: parsed };
  }

  /** D2（2026-10-06）：开窗资料（estomago profile——服务端默认不带心情
   *  自由文字，字段矩阵见 mariposa _memory_slim；分页 bootstrap.next 按
   *  snapshot 游标续取，宿主当前只消费首页摘要）。 */
  async bootstrapGet(signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('bootstrap.get', { profile: 'estomago' }, signal);
  }

  /** episode（她批 2026-10-07"做吧"）：scope 内分页读取事件状态。
   *  蓝图 §6.3：注入/查询取少量状态+证据引用，不给全库未完故事。 */
  async episodeList(args: { scopeId: string; states?: string[]; limit?: number; cursor?: Record<string, unknown> }): Promise<MariposaCallResult> {
    return this.transport('episode.list', {
      scope_id: args.scopeId,
      ...(args.states ? { states: args.states } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
  }

  /** episode.get：按 ID 读取事件当前状态与证据引用（无正文展开）。 */
  async episodeGet(episodeId: string): Promise<MariposaCallResult> {
    return this.transport('episode.get', { episode_id: episodeId });
  }

  /** episode.apply（R05 复审 2026-10-07）：五动作 start/continue/pause/
   *  close/correct。operation_id/scope_id 由宿主派生注入（模型不能自编）。
   *  args 已是宿主侧校验后的出站形状（snake_case）。 */
  async episodeApply(args: Record<string, unknown>): Promise<MariposaCallResult> {
    return this.transport('episode.apply', args);
  }

  /** R02（复审 2026-10-07）：同会话续查（refine）——回到原 session 收窄/
   *  换角度，不是另起 start。request_ref 用服务端给的 continue 引用。 */
  async recallRefine(args: { sessionId: string; continueRef: string; query: string }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.refine', {
      session_id: args.sessionId,
      query_plan: {
        original_request: args.query,
        semantic_query: args.query,
        channels: ['event'],
        request_ref: args.continueRef,
      },
    });
  }

  /** G-J-01（2026-10-06）：召回启动（模型按需查询）。request_ref 由调用方
   *  派生（幂等身份）；返回含 recall_session_id/candidates/continuation。 */
  async recallStart(args: { requestRef: string; query: string; conversationScope?: string; lexicalTerms?: string[] }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.start', {
      query_plan: {
        original_request: args.query,
        // R02（复审 2026-10-07）：自然语言问题显式进语义通道——服务端
        // 只认显式 semantic_query 不回填；此前词项为空时整句被当 exact
        // phrase 匹配，自然语言问题必然 0 命中
        semantic_query: args.query,
        channels: ['event'],
        ...(args.lexicalTerms && args.lexicalTerms.length > 0 ? { lexical_terms: args.lexicalTerms } : {}),
      },
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
      request_ref: args.requestRef,
    });
  }

  /** 心情词表只读（词表正本；审计 1005B：调用方应动态拉取不各自硬编码）。
   *  形状：{categories: string[], version?, rules?, frozen_ruling?}。
   *  需要绑定白名单含 memory.mood.vocab（estómago builtin 已含）。 */
  async moodVocab(): Promise<MariposaCallResult & { categories?: string[]; version?: string }> {
    const r = await this.transport('memory.mood.vocab', {});
    if (!r.ok) return r;
    const s = r.result as { categories?: unknown; version?: unknown };
    return {
      ok: true, result: r.result,
      categories: Array.isArray(s.categories) && s.categories.every((x) => typeof x === 'string') ? s.categories as string[] : undefined,
      version: typeof s.version === 'string' ? s.version : undefined,
    };
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
