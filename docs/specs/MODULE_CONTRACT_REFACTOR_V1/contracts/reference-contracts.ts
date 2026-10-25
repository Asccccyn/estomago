/**
 * 编译可检查的接口参考，不是可直接覆盖生产实现的补丁。
 * 现有类型字段以实际源码为准；保留seenMessages/imageRefs/原purpose。
 * 所有hostOnly字段仅宿主使用，不得被序列化到模型工具定义或输出。
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type Purpose = 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
export type SeenRef = { id: string; revision: number; char_start?: number; char_end?: number };
export type BackgroundQuote = { toolName: string; maxCostMicroUsd: number; verifiedFree: boolean };

/** 从既有宿主可信入口派生；不是模型参数。只读类型不能替代运行时授权。 */
export type ExecutionContext = {
  signal?: AbortSignal;
  roomId: string;
  backgroundRunId?: string | null;
  windowId: string;
  turnId: string | null;
  purpose: Purpose;
  activeReviewId: string | null;
  seenSequence: number;
  seenMessages: ReadonlyArray<SeenRef>;
  requestId: string;
  toolCallId?: string | null;
  attemptId?: string | null;
  round?: number | null;
  generationId?: string | null;
  beforeBackgroundTool?: (quote: BackgroundQuote) => void;
};
export type ExistingToolResult = {
  ok: boolean;
  output: Record<string, unknown>;
  seenAdditions?: ReadonlyArray<SeenRef>;
  imageRefs?: string[];
};
export type ParseResult<I> =
  | { ok: true; value: I }
  | { ok: false; code: string; detail?: string };
export type DomainOutcome<O> =
  | { ok: true; value: O; seenAdditions?: ReadonlyArray<SeenRef>; imageRefs?: string[] }
  | { ok: false; error: Record<string, unknown> };
export type CallAdmission<I> = {
  /** 每项实现复用现行可见性/授权规则，不是“注册即授权”。 */
  authorize(input: I, ctx: Readonly<ExecutionContext>): void | Promise<void>;
  /** 信任的现有证据/价格配置；不以get/read名称推断免费。 */
  quote(input: I, ctx: Readonly<ExecutionContext>): BackgroundQuote;
};
export interface Capability<I, O> {
  readonly id: string;
  readonly owner: string;
  readonly baselineOrder: number; // host-only，不进入ToolSpec
  definition(): ToolSpec;         // 仅新窗目录构建取当前定义；旧窗读冻结spec
  readonly policy: CallAdmission<I>;
  readonly memoryOnlyAllowed: boolean; // host-only；按现行已批准清单，不自动扩权
  parse(raw: Record<string, unknown>, frozenSpec: ToolSpec): ParseResult<I>;
  run(input: I, ctx: Readonly<ExecutionContext>): Promise<DomainOutcome<O>>;
  toModel(value: O, input: I): Record<string, unknown>;
}

/** 示例：组合只获得两个必要端口，而非任意名字的万能registry。 */
export interface PublishedAudioReader {
  readPublished(ref: string, ctx: Readonly<ExecutionContext>): Promise<{
    assetId: string; contentHash: string; mime: string;
    bytes: Uint8Array;
    transcript: { text: string; source: string } | null;
  }>;
}
export interface HearingAnalyzer {
  /** 具体实现必须保留原有授权、幂等、取消、可信价格与回执。 */
  analyzePublishedAudio(
    input: { audioRef: string; rangeMs?: [number, number] },
    ctx: Readonly<ExecutionContext>,
  ): Promise<DomainOutcome<Record<string, unknown>>>;
}
export type VoiceHearingPorts = {
  readonly source: PublishedAudioReader;
  readonly hearing: HearingAnalyzer;
};

/** 语义事实，不暴露可随意执行SQL的Db给所有订阅者。 */
export type MessageFact =
  | { kind: 'accepted'; conversationId: string; messageId: string; revision: number;
      sequence: number; contentHash: string; content: string; occurredAt: string | null;
      duplicate: boolean }
  | { kind: 'revised'; conversationId: string; messageId: string;
      supersededRevision: number; revision: number }
  | { kind: 'published'; conversationId: string; messageId: string;
      revision: number; publishedAt: string; duplicate: boolean };
export interface MessageLifecycleHooks {
  /** 必须同步SQL-only，闭包绑定已有同事务repo；禁止Promise/外部IO。 */
  inTransaction(fact: Readonly<MessageFact>): void;
  /** 只唤醒已有持久任务，不是唯一事实来源。 */
  afterCommit(conversationId: string): void;
}

export type TurnBinding = {
  conversationId: string; windowId: string; turnId: string; attemptId: string;
  messageId: string; revision: number;
};
/** internalHandle不能给模型；modelText保留原日期+正文+必要ref语义。 */
export type PreparedContribution = {
  binding: Readonly<TurnBinding>;
  modelText: string;
  internalHandle: unknown;
};
export interface BeforeTurnContributor {
  prepare(binding: Readonly<TurnBinding>, signal?: AbortSignal): Promise<PreparedContribution | null>;
  reuseFrozen(attemptId: string): PreparedContribution | null;
  finalAdmit(value: PreparedContribution, binding: Readonly<TurnBinding>): Promise<PreparedContribution | null>;
  markDispatched(attemptId: string): void;
  markRetained(value: PreparedContribution): void;
  cancelForTurn(turnId: string): void;
}
export interface WindowOpenContributor {
  /** 实现沿既有快照/分页/权限合同；不是每轮拉取。 */
  snapshot(windowId: string, signal?: AbortSignal): Promise<string | null>;
}
export interface ModuleLifecycle {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
export interface ProgramFactsPort {
  /** 接受/持久化/入同一队列后立即返回；禁止等待后继回合完成。 */
  submit(conversationId: string, kind: string, text: string, dedupeKey: string):
    { turnId: string } | { deduplicated: true };
}
