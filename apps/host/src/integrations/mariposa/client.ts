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

export type BootstrapSection = 'memory_days' | 'plans' | 'plan_content' | 'i' | 'memory_item';
/** Text offsets are Unicode code points, not JavaScript UTF-16 indices. */
export type MoodTextCursor = { memory_id: string; field: 'mood_text'; offset: number };
export type BootstrapPageMetadata = {
  snapshot_id: string;
  section: BootstrapSection;
  content_role: 'bootstrap_memory_package';
  instruction_authority: 'none';
  next_cursor: Record<string, unknown> | null;
};

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
  // WP-04（JFA-C06/C07）：超限是"可恢复-减半重切"信号不是 dead——服务端
  // 度量与服务端门同源，客户端按更保守批界重切后重试（批次有界重试上限
  // 仍生效，不会无限循环）
  if (code === 'SOURCE_SELECTION_TOO_LARGE') return 'retry_later';
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('RESPONSE_SHAPE_INVALID');
      if (body.ok === false) {
        return { ok: false, code: typeof body.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`, httpStatus: res.status };
      }
      if (body.ok !== true || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
        // A 2xx with no verifiable receipt has unknown outcome. The existing
        // transport-unknown recovery retains the operation ID for writes.
        throw new Error('RESPONSE_SHAPE_INVALID');
      }
      return { ok: true, result: body.data };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    // D22（审计 3655d60）：5xx 不论响应体是否带结构化错误码，都按传输层状态分类为 HTTP_5xx——
    // 调用方（hold/archive）将 5xx 归"结果不明 unknown"并有界核实，不当确定失败。
    if (res.status >= 500) return { ok: false, code: `HTTP_${res.status}`, httpStatus: res.status };
    return { ok: false, code: typeof body?.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`, httpStatus: res.status };
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
  private readonly configured: () => boolean;

  constructor(opts: { baseUrl?: string; credentialEnv?: string | null; transport?: MariposaTransport }) {
    this.transport = opts.transport ?? defaultTransport(opts.baseUrl ?? '', opts.credentialEnv ?? null);
    this.configured = () => Boolean(opts.transport || (opts.baseUrl && opts.credentialEnv && process.env[opts.credentialEnv]));
  }

  /** Configuration evidence only; no network request and no credential disclosure. */
  isConfigured(): boolean { return this.configured(); }

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
    eventSourceRanges?: HoldSourceSelection[] | null;
  }): Promise<MariposaCallResult & { receipt?: HoldReceipt }> {
    const payload: Record<string, unknown> = {
      operation_id: args.operationId,
      ...args.holdPayload,
      ...(args.sourceSelections ? { source_selections: args.sourceSelections } : {}),
      ...(args.eventSourceRanges ? { event_source_ranges: args.eventSourceRanges } : {}),
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

  /** 2026-10-18 她裁定：修改入口（就地改+我们的话新增/修改）——话语只存
   *  原文，说话人由服务端按出处推导。expected_version CAS 先 memoryGet 取。 */
  async memoryGet(memoryId: string): Promise<MariposaCallResult> {
    return this.transport('memory.get', { memory_id: memoryId });
  }

  async memoryUpdate(args: Record<string, unknown>): Promise<MariposaCallResult> {
    return this.transport('memory.update', args);
  }

  /** estomago 开窗包：心情文字及其他现行段可携带续页游标。
   *  同一装配只续取原 snapshot，不将内容当成指令。 */
  async bootstrapGet(signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('bootstrap.get', { profile: 'estomago' }, signal);
  }

  /** Revalidate a loaded snapshot and current permission without fetching content. */
  async bootstrapValidate(snapshotId: string, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('bootstrap.get', { profile:'estomago', loaded_snapshot_id:snapshotId }, signal);
  }

  /** 原样透传服务端游标；宿主消费方负责有界续取与完整性校验。 */
  async bootstrapNext(snapshotId: string, cursor: Record<string, unknown>, section: BootstrapSection, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('bootstrap.next', { snapshot_id: snapshotId, cursor, section }, signal);
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
   *  换角度，不是另起 start。request_ref 用服务端给的 continue 引用。
   *  F-01（跨仓预审 2026-10-25）：continue 引用承担两份合同——
   *  query_plan.request_ref 是幂等逻辑身份（M transport reqref: 键），
   *  顶层 continue_request_ref 才是新 burst 许可（M budget.try_new_burst）；
   *  顶层 conversation_scope 供 M require_owned_session 归属核验
   *  （session 绑定 scope 时省略=SCOPE_REQUIRED）。 */
  async recallRefine(args: { sessionId: string; continueRef: string; query: string; channels: string[]; eventDate?: { from: string; to: string }; conversationScope?: string }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.refine', {
      session_id: args.sessionId,
      continue_request_ref: args.continueRef,
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
      query_plan: {
        original_request: args.query,
        semantic_query: args.query,
        // 找话第一批（林石见复核）：refine 必须显式携带查询目标——
        // M 的 validate_query_plan 对省略 channels 缺省 ['event']，
        // 静默缺省会把找话续查变成查事件；类型层强制非可选
        channels: args.channels,
        request_ref: args.continueRef,
        ...(args.eventDate ? { explicit_constraints: { event_date: { from: args.eventDate.from, to: args.eventDate.to } } } : {}),
      },
    });
  }

  /** 否定反馈（2026-10-24 她裁·reject 接入）：会话内结构性排除候选——
   *  M 侧 session_local 标记（P1-01 收据原子），后续 refine 检索确定性
   *  排除之；不修改全局记忆。candidateRef/resourceRef 二选一（M 侧支持
   *  只给 resource_ref 反查会话候选）。operation_id 幂等，重试安全。 */
  async recallReject(args: { sessionId: string; candidateRef?: string; resourceRef?: string; operationId: string; conversationScope?: string }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.reject', {
      session_id: args.sessionId,
      ...(args.candidateRef ? { candidate_ref: args.candidateRef } : {}),
      ...(args.resourceRef ? { resource_ref: args.resourceRef } : {}),
      reject_target: 'candidate',
      operation_id: args.operationId,
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
    });
  }

  /** 找话第二批（2026-10-10）：Round2 原文深搜——M 的独立入口
   *  （S13 门服务端核验：reason 闭集+Round1 完成回执+政策纪元一致）。
   *  operationId 由宿主派生（同 tool_call 重试同幂等身份）。 */
  async recallRound2(args: { sessionId: string; reason: string; operationId: string; conversationScope?: string }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.round2', {
      session_id: args.sessionId,
      reason: args.reason,
      operation_id: args.operationId,
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
    });
  }

  /** I/计划只读批（2026-10-10）：M 的 i 系与 plan 系读面透传。 */
  async iGet(): Promise<MariposaCallResult> {
    return this.transport('i.get', {});
  }
  async iItemsList(): Promise<MariposaCallResult> {
    return this.transport('i.items.list', {});
  }
  async iItemGet(itemId: string): Promise<MariposaCallResult> {
    return this.transport('i.item.get', { item_id: itemId });
  }
  async iItemHistory(itemId: string): Promise<MariposaCallResult> {
    return this.transport('i.item.history', { item_id: itemId });
  }
  async iVersionsRead(): Promise<MariposaCallResult> {
    return this.transport('i.versions.read', {});
  }
  async planList(states?: string[]): Promise<MariposaCallResult> {
    const args: Record<string, unknown> = {};
    if (Array.isArray(states) && states.length > 0) args.states = states;
    return this.transport('plan.list', args);
  }
  async planGet(planId: string): Promise<MariposaCallResult> {
    return this.transport('plan.get', { plan_id: planId });
  }

  /** I/计划写入批（2026-10-10）：M 的 i.item.create/revise/restore 与
   *  plan.create/update/complete/cancel（complete/cancel 为薄实现入口）。
   *  M 侧按 jiaming 主体权限与 CAS（expected_revision/version）核验。 */
  async iItemCreate(args: { content: string; changeReason?: string; relations?: unknown[] }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { content: args.content };
    if (args.changeReason) payload.change_reason = args.changeReason;
    if (Array.isArray(args.relations)) payload.relations = args.relations;
    return this.transport('i.item.create', payload);
  }
  async iItemRevise(args: { itemId: string; content: string; expectedRevision: number; changeReason?: string; informedByRevision?: number; relations?: unknown[] }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { item_id: args.itemId, content: args.content, expected_revision: args.expectedRevision };
    if (args.changeReason) payload.change_reason = args.changeReason;
    if (typeof args.informedByRevision === 'number') payload.informed_by_revision = args.informedByRevision;
    if (Array.isArray(args.relations)) payload.relations = args.relations;
    return this.transport('i.item.revise', payload);
  }
  async iItemRestore(args: { itemId: string; restoreRevision: number; expectedRevision: number; changeReason?: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { item_id: args.itemId, restore_revision: args.restoreRevision, expected_revision: args.expectedRevision };
    if (args.changeReason) payload.change_reason = args.changeReason;
    return this.transport('i.item.restore', payload);
  }
  async planCreate(args: { title: string; content?: string; state?: string; startsAt?: string; dueAt?: string; operationId: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { title: args.title, operation_id: args.operationId };
    if (typeof args.content === 'string') payload.content = args.content;
    if (typeof args.state === 'string') payload.state = args.state;
    if (typeof args.startsAt === 'string') payload.starts_at = args.startsAt;
    if (typeof args.dueAt === 'string') payload.due_at = args.dueAt;
    return this.transport('plan.create', payload);
  }
  async planUpdate(args: { planId: string; expectedVersion: number; title?: string; content?: string; state?: string; startsAt?: string; dueAt?: string; operationId: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { plan_id: args.planId, expected_version: args.expectedVersion, operation_id: args.operationId };
    if (typeof args.title === 'string') payload.title = args.title;
    if (typeof args.content === 'string') payload.content = args.content;
    if (typeof args.state === 'string') payload.state = args.state;
    if (typeof args.startsAt === 'string') payload.starts_at = args.startsAt;
    if (typeof args.dueAt === 'string') payload.due_at = args.dueAt;
    return this.transport('plan.update', payload);
  }
  async planSetState(cap: 'plan.complete' | 'plan.cancel', planId: string, expectedVersion: number): Promise<MariposaCallResult> {
    return this.transport(cap, { plan_id: planId, expected_version: expectedVersion });
  }

  /** 明确打开/回忆/留链批（2026-10-10）：M 的 memory.open→view.confirm
   *  →recollections.append（keep_wide 附带留标记）→keeps 链透传。
   *  语义铁律：召回/回读返回正文 ≠ 明确打开——回温与"留"只经本链。 */
  async memoryOpen(memoryId: string, modelView = false): Promise<MariposaCallResult> {
    return this.transport('memory.open', { memory_id: memoryId, ...(modelView ? { view: 'model' } : {}) });
  }
  async viewConfirm(memoryId: string, receiptId: string): Promise<MariposaCallResult> {
    return this.transport('memory.view.confirm', { memory_id: memoryId, receipt_id: receiptId });
  }
  async recollectionsAppend(args: { memoryId: string; receiptId: string; text: string; keepWide?: boolean }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { memory_id: args.memoryId, receipt_id: args.receiptId, text: args.text };
    if (args.keepWide === true) payload.keep_wide = true;
    return this.transport('memory.recollections.append', payload);
  }
  async recollectionsRevise(recollectionId: string, text: string): Promise<MariposaCallResult> {
    return this.transport('memory.recollections.revise', { recollection_id: recollectionId, text });
  }
  async recollectionsList(memoryId: string, includeHistory?: boolean): Promise<MariposaCallResult> {
    return this.transport('memory.recollections.list', { memory_id: memoryId, ...(includeHistory === true ? { include_history: true } : {}) });
  }
  async keepsList(memoryId: string): Promise<MariposaCallResult> {
    return this.transport('memory.keeps.list', { memory_id: memoryId });
  }
  async keepRevoke(markId: string): Promise<MariposaCallResult> {
    return this.transport('memory.keep.revoke', { mark_id: markId });
  }

  /** 纠错+删除审批批（2026-10-10 她排期"继续"）：关系/话语来源/原文
   *  绑定三族纠错 + 关系链接/列表 + 删除审批（decide=jiaming 独占）。 */
  async relationsCorrect(args: { relationId: string; correctionAction: string; operationId: string; replacement?: Record<string, unknown>; note?: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { relation_id: args.relationId, correction_action: args.correctionAction, operation_id: args.operationId };
    if (args.replacement) payload.replacement = args.replacement;
    if (args.note) payload.note = args.note;
    return this.transport('memory.relations.correct', payload);
  }
  async relationsLink(args: { fromMemory: string; toMemory: string; relationType: string; customLabel?: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { from_memory: args.fromMemory, to_memory: args.toMemory, relation_type: args.relationType };
    if (args.customLabel) payload.custom_label = args.customLabel;
    return this.transport('memory.relations.link', payload);
  }
  async relationsList(memoryId: string): Promise<MariposaCallResult> {
    return this.transport('memory.relations.list', { memory_id: memoryId });
  }
  async wordSourceCorrect(args: { wordId: string; correctionAction: string; operationId: string; expectedSourceVersion: number; expectedSourceRef?: string | null; replacement?: Record<string, unknown> }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { word_id: args.wordId, correction_action: args.correctionAction, operation_id: args.operationId, expected_source_version: args.expectedSourceVersion };
    if (args.expectedSourceRef !== undefined) payload.expected_source_ref = args.expectedSourceRef;
    if (args.replacement) payload.replacement = args.replacement;
    return this.transport('memory.our_words.source.correct', payload);
  }
  async sourceBindingCorrect(args: { bindingId: string; correctionAction: string; operationId: string; replacement?: Record<string, unknown>; note?: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { binding_id: args.bindingId, correction_action: args.correctionAction, operation_id: args.operationId };
    if (args.replacement) payload.replacement = args.replacement;
    if (args.note) payload.note = args.note;
    return this.transport('source.binding.correct', payload);
  }
  async correctionsList(args: { endpoint?: string; instanceId?: string; domain?: string; limit?: number }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = {};
    if (args.endpoint) payload.endpoint = args.endpoint;
    if (args.instanceId) payload.instance_id = args.instanceId;
    if (args.domain) payload.domain = args.domain;
    if (typeof args.limit === 'number') payload.limit = args.limit;
    return this.transport('relations.corrections.list', payload);
  }
  async deletionDecide(args: { requestId: string; decision: 'approve' | 'reject'; rejectionReason?: string; operationId: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = { request_id: args.requestId, decision: args.decision, operation_id: args.operationId };
    if (args.rejectionReason) payload.rejection_reason = args.rejectionReason;
    return this.transport('memory.deletion.decide', payload);
  }
  async deletionGet(requestId: string): Promise<MariposaCallResult> {
    return this.transport('memory.deletion.get', { request_id: requestId });
  }
  async deletionList(args: { status?: string; memoryId?: string }): Promise<MariposaCallResult> {
    const payload: Record<string, unknown> = {};
    if (args.status) payload.status = args.status;
    if (args.memoryId) payload.memory_id = args.memoryId;
    return this.transport('memory.deletion.list', payload);
  }

  /** G-J-01（2026-10-06）：召回启动（模型按需查询）。request_ref 由调用方
   *  派生（幂等身份）；返回含 recall_session_id/candidates/continuation。 */
  async recallStart(args: { requestRef: string; query: string; conversationScope?: string; lexicalTerms?: string[]; channels?: string[]; eventDate?: { from: string; to: string } }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.start', {
      query_plan: {
        original_request: args.query,
        // R02（复审 2026-10-07）：自然语言问题显式进语义通道——服务端
        // 只认显式 semantic_query 不回填；此前词项为空时整句被当 exact
        // phrase 匹配，自然语言问题必然 0 命中
        semantic_query: args.query,
        // 找话第一批（2026-10-10 她排期/林石见复核）：查询目标显式
        // 透传（['words']=专项找我们的话）；缺省=['event'] 保持旧行为
        channels: args.channels && args.channels.length > 0 ? args.channels : ['event'],
        ...(args.lexicalTerms && args.lexicalTerms.length > 0 ? { lexical_terms: args.lexicalTerms } : {}),
        // 2026-10-17（她报障修复）：明确日期段直取桶池（memory_date 收窄）——
        // 语义近邻对"日期主导"查询不可靠（9.25-9.27 曾 0 命中而桶实际存在）
        ...(args.eventDate ? { explicit_constraints: { event_date: { from: args.eventDate.from, to: args.eventDate.to } } } : {}),
      },
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
      request_ref: args.requestRef,
    });
  }

  /** WP2（MANUAL_HANDOFF_JUDGE_SWITCH_V1，2026-10-08）：关闭判断模式的
   *  冻结结果集续页——只消费既有 result_set（零检索/零判断/零 COUNT）；
   *  不修改查询（refine 才改查询）。政策切换后服务端返回
   *  RECALL_POLICY_CHANGED，如实上抛。 */
  async recallPage(args: { resultSetId: string; sessionId?: string; cursor?: string; conversationScope?: string }): Promise<MariposaCallResult> {
    return this.transport('memory.recall.page', {
      result_set_id: args.resultSetId,
      ...(args.sessionId ? { session_id: args.sessionId } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.conversationScope ? { conversation_scope: args.conversationScope } : {}),
    });
  }

  // ===== 自动记忆浮现（EST_MARIPOSA_AUTO_SURFACING_V1，2026-10-19）=====
  // 专用 surfacing binding（surfacing_credential_ref）只放行这四个能力；
  // 不回退聊天凭据，不借归档凭据。

  async surfacePrepare(payload: Record<string, unknown>, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('memory.surfacing.prepare', payload, signal);
  }

  async surfaceValidate(payload: Record<string, unknown>, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('memory.surfacing.validate', payload, signal);
  }

  async surfaceCheck(payload: Record<string, unknown>, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('memory.surfacing.check', payload, signal);
  }

  async surfaceDetailRead(payload: Record<string, unknown>, signal?: AbortSignal): Promise<MariposaCallResult> {
    return this.transport('memory.detail.read', payload, signal);
  }

  /** 心情词表只读（词表正本；审计 1005B：调用方应动态拉取不各自硬编码）。
   *  形状：{categories: string[], version?, rules?, frozen_ruling?}。
   *  需要绑定白名单含 memory.mood.vocab（estómago builtin 已含）。 */
  async moodVocab(): Promise<MariposaCallResult & { categories?: string[]; version?: string }> {
    const r = await this.transport('memory.mood.vocab', {});    if (!r.ok) return r;
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
