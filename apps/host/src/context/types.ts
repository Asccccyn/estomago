// §1/§2（硬规则）：Reasoning 是观察层，不是 Context 层。
// ModelContextSegment 只能由显式 allowlist builder 构造；ReasoningProjection 在类型/模块边界上
// 不可自动转换为 ModelContextSegment（无 toSegment/无联合）；"reasoning/thinking" 不在来源枚举中。
export type ModelContextSource =
  | 'identity'
  | 'rules'
  | 'current_i'
  | 'time_context'
  | 'user_input'
  | 'recent_dialogue'
  | 'memory_recall'
  | 'verified_tool_fact'
  | 'handoff';

// 合法来源封闭集合（供 contract test 断言：永不包含 reasoning/thinking）
export const MODEL_CONTEXT_SOURCES: readonly ModelContextSource[] = [
  'identity', 'rules', 'current_i', 'time_context', 'user_input',
  'recent_dialogue', 'memory_recall', 'verified_tool_fact', 'handoff',
];

export type ModelContextSegment = {
  source: ModelContextSource;
  sequence: number;           // 装配顺序
  text: string;               // 进入模型上下文的正文（唯一入口字段）
  budget_slot: string;        // 预算槽位
  evidence_ref: string | null;
};

// 观察层类型：可持久化/SSE/UI/审计/按 turn 查询；结构上不存在进入 Context 的通道
export type ReasoningProjection = {
  readonly layer: 'observation';
  block_id: string;
  turn_id: string;
  attempt_id: string;
  visibility: string;
  state: string;
  text: string;
};

export type ConversationMessage = {
  message_id: string;
  sequence: number;
  speaker: 'owner' | 'assistant' | 'system';
  revision: number;
  content: string;
};

export type VerifiedToolFact = {
  tool: string;
  result_hash: string;
  summary: string;
};

export type MemoryRecallItem = {
  source: 'mariposa';
  item_id: string;
  text: string;
  budget: number | null;
};

export type HandoffMaterial = {
  window_id: string;
  cutoff_sequence: number;
  facts: VerifiedToolFact[];
  unanswered: string[];
  // 注意：不含 reasoning（§1 硬规则；canary 校验）
};
