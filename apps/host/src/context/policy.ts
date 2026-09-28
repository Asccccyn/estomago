// §3/§30：Context Policy 占位——策略未批准前一切策略依赖能力返回 CONTEXT_POLICY_NOT_APPROVED，
// 绝不静默使用默认值。policy_version = null（等周家明 Context Policy v1）。
export interface ContextPolicy {
  version: string;
  sameWindow: { residentSources: unknown };
  rotation: { triggers: unknown; safePointRules: unknown };
  recentDialogue: { budgetTokens: number; semanticBoundary: unknown };
  bootstrap: { order: unknown };
  recall: { budgetTokens: number; triggers: unknown };
  handoff: { contents: unknown };
  tokenBudget: { modelCapacity: number | null; softLimit: number | null; hardLimit: number | null; reserved: { output: number | null; tools: number | null; recall: number | null; handoff: number | null } };
  compactFallback: { preCompact: unknown };
}

export const CONTEXT_POLICY_VERSION: string | null = null; // AWAITING_POLICY（不得伪造 v1）

export class ContextPolicyNotApprovedError extends Error {
  readonly code = 'CONTEXT_POLICY_NOT_APPROVED';
  readonly capability: string;
  constructor(capability: string) {
    super(`CONTEXT_POLICY_NOT_APPROVED: ${capability} 依赖未批准的 Context Policy（等待周家明 v1）`);
    this.capability = capability;
  }
}

export function requirePolicy(capability: string): ContextPolicy {
  throw new ContextPolicyNotApprovedError(capability);
}
