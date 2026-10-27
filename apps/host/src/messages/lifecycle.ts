// messages/lifecycle.ts（P05.2/P05.4）：消息生命周期叶合同。
// 通用事实 + 同步 inTx / afterCommit 两段契约（04 §E）：inTransaction 必须 SQL-only、
// 使用调用方既有事务连接、不调用 HTTP/模型、不返回 Promise；afterCommit 只唤醒
// 已持久登记的工作（可重复；业务作业自身幂等——幂等重放补缺失作业但不当新真实活动）。
// 本文件是叶：不导入具体模块（浮现/活动锚点在 application/message-lifecycle 装配）。
export type MessageLifecycleFact =
  | {
      kind: 'accepted';
      conversationId: string; messageId: string; revision: number; sequence: number;
      /** 可信正文（空正文语音消息=发布时快照的可信转写，见 effective-text.ts）；contentHash 仍是修订正本 hash。 */
      content: string; contentHash: string; occurredAt: string | null;
      /** 本次是否真实首次发布（幂等重放/路由重提交=false——补缺失作业但不当新真实活动）。 */
      firstAcceptance: boolean;
      /** false=输入已保存但对应回复在派发前已取消（如电话准备阶段挂断）：消费者不得为它登记会派发/计费的作业。 */
      dispatchable: boolean;
    }
  | { kind: 'revised'; conversationId: string; messageId: string; supersededRevision: number; revision: number }
  | { kind: 'published'; conversationId: string; messageId: string; revision: number; publishedAt: string };

export type MessageLifecycleHooks = {
  /** 同步事实消费：调用方事务连接内 SQL-only（禁 await/HTTP/嵌套事务）。 */
  inTransaction(fact: Readonly<MessageLifecycleFact>): void;
  /** 事务提交后唤醒已持久登记的工作（conversationId 便于按域唤醒；可重复调用）。 */
  afterCommit(conversationId: string): void;
};

