// capabilities/contracts.ts（P01.1）：能力叶类型合同。
// 从 runtime/host-tools.ts / runtime/background-tool-cost.ts 原样搬迁，字段逐一对照
//（spec 04 §A：复制现有类型时保留实际字段，不为贴合示例删语义）。
// 依赖方向：本文件只依赖叶类型/内建类型；不从 host-tools、模块实现或具体 adapter 导入。
// runtime 与 modules 都可以 import 本文件；本文件不反向依赖任何一方。

export type HostToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type SeenRef = { id: string; revision: number; char_start?: number; char_end?: number };
// char_start/char_end（码点半开区间，缺省=整条已见）——WP4（2026-10-08）：
// conversation_read 的片段级已见。引用核对（resolveQuotes）对带范围的条目
// 只放行落在已读范围内的匹配；整条装配（对话轨迹）不带范围=全文已见。

export type ToolExecContext = {
  signal?: AbortSignal; // Host-owned cancellation, never a model parameter.
  roomId: string;
  backgroundRunId?: string | null; // EXEC_V1 §04.6.2：后台回合上下文（background_complete/noop 记账用）
  windowId: string;
  turnId: string | null;
  purpose: 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
  activeReviewId: string | null;
  seenSequence: number; // 本次请求实际看见的聊天输入高水位（书签位置依据，§3.1）
  seenMessages: ReadonlyArray<SeenRef>; // D13：发起请求**实际装载**的 (消息,修订) 清文——引用核对只认这份视野，不从库高水位推断
  requestId: string; // 发起 hold 的模型请求标识
  // R07（审计 FE-12）：工具生命周期统一身份——同一 tool_call_id 贯穿
  // start/result/error 三阶段；round=本轮工具批次序号（模型请求轮）；
  // generationId=provider 生成标识（首字节前可空，如实空不虚构）。
  toolCallId?: string | null;
  attemptId?: string | null;
  round?: number | null;
  generationId?: string | null;
  // Trusted host callback only: invoked after tool discovery/schema checks and
  // before the resolved handler. Neither the quote nor this callback is a model
  // argument; tool_invoke admits the actual capability once, not its wrapper.
  beforeBackgroundTool?: (quote: BackgroundToolQuote) => void;
};

export type ToolExecResult = { ok: boolean; output: Record<string, unknown>; seenAdditions?: ReadonlyArray<SeenRef>; /** RE-05：随工具结果可携带的内部图引用（est asset_id）——宿主在发送边界按型号图像能力决定是否物化为原生图块；不进模型 JSON 正文 */ imageRefs?: string[] };

// Host-only billing metadata. It is never added to tool schemas or model output.
// （原 runtime/background-tool-cost.ts 的同名叶类型；报价/免费证据的判定逻辑仍在该文件。）
export type BackgroundToolQuote = { toolName: string; maxCostMicroUsd: number; verifiedFree: boolean };

// P02：能力条目的内部产出（参考合同 contracts/reference-contracts.ts DomainOutcome）。
// 内部结果与模型投影分离：value/raw 不直接作为工具 output 泄露，由条目 toModel 做唯一投影。
export type CapabilityOutcome<O> =
  | { ok: true; value: O; seenAdditions?: ReadonlyArray<SeenRef>; imageRefs?: string[] }
  | { ok: false; error: Record<string, unknown> };

// P03.6：程序事实窄端口（04 §G）——只接受并持久化/安排同一执行链，返回接受回执；
// 不等待后继回合完成，不把整个 Supervisor 交给模块。当前单队列仍是唯一执行者。
export type ProgramFactsPort = {
  submitProgramFactTurn(conversationId: string, kind: string, factText: string, dedupeKey: string): unknown;
};
