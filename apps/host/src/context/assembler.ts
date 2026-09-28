// §3：ContextAssembler —— 只做结构/来源/顺序/权限/预算槽位/证据/排除项。
// 策略未批准：recent_dialogue / memory_recall / handoff / 预算数值一律 CONTEXT_POLICY_NOT_APPROVED（不填默认值）。
// 确定性来源（time_context / user_input）按现行运行时规则装配。
import type { ModelContextSegment, ReasoningProjection } from './types.ts';
import { CONTEXT_POLICY_VERSION, ContextPolicyNotApprovedError } from './policy.ts';

export type AssembleInput = {
  conversationId: string;
  windowId: string | null;
  turnId: string;
  inputMessageId: string | null;
  policyVersion?: string | null;
  timeContextJson: string;                 // 宿主每轮构造的程序事实
  userInput: { revision: number; content: string }; // 本轮有效输入
};

export type AssembleResult = {
  segments: ModelContextSegment[];
  evidence: { input_revision: number; time_context_present: boolean };
  budget: { policy_controlled: boolean; slots: Record<string, number | null> };
  excluded_sources: string[];
  policy_version: string | null;
};

// 唯一构造入口：allowlist builder（§2）——reasoning 无通道进入
export function assembleContext(input: AssembleInput, deps: { loadRecentDialogue?: unknown; loadRecall?: unknown; loadHandoff?: unknown }): AssembleResult {
  if (input.policyVersion !== undefined && input.policyVersion !== null && input.policyVersion !== CONTEXT_POLICY_VERSION) {
    throw new ContextPolicyNotApprovedError(`policy_version=${input.policyVersion} 未获批`);
  }
  const segments: ModelContextSegment[] = [];
  let seq = 0;
  const push = (source: import('./types.ts').ModelContextSource, text: string, slot: string, ev: string | null) => {
    segments.push({ source, sequence: ++seq, text, budget_slot: slot, evidence_ref: ev });
  };
  push('time_context', input.timeContextJson, 'time', null);
  push('user_input', input.userInput.content, 'input', `message:${input.inputMessageId ?? 'none'}#r${input.userInput.revision}`);
  // 策略依赖来源：明确排除 + NOT_APPROVED（不猜默认值）
  const excluded = ['recent_dialogue', 'memory_recall', 'handoff'];
  if (deps.loadRecentDialogue || deps.loadRecall || deps.loadHandoff) {
    throw new ContextPolicyNotApprovedError('recent_dialogue/memory_recall/handoff 装配依赖 Context Policy');
  }
  return {
    segments,
    evidence: { input_revision: input.userInput.revision, time_context_present: true },
    budget: { policy_controlled: true, slots: { output: null, tools: null, recall: null, handoff: null, soft_limit: null, hard_limit: null } },
    excluded_sources: excluded,
    policy_version: CONTEXT_POLICY_VERSION,
  };
}

// 观察层→上下文层的"转换函数"在类型系统上不存在（§2）；本函数仅用于 canary 断言其不可构造
export function assertNotConvertible(projection: ReasoningProjection): never {
  throw new Error(`CONTEXT_ISOLATION: ReasoningProjection(block=${projection.block_id}) 不能进入 ModelContext（硬规则 §1）`);
}
