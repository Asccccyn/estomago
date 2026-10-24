// messages/lifecycle.ts（P05.2/P05.4）：消息生命周期叶合同。
// 通用事实 + 同步 inTx / afterCommit 两段契约（04 §E）：inTransaction 必须 SQL-only、
// 使用调用方既有事务连接、不调用 HTTP/模型、不返回 Promise；afterCommit 只唤醒
// 已持久登记的工作（可重复；业务作业自身幂等——幂等重放补缺失作业但不当新真实活动）。
// 本文件是叶：不导入具体模块（浮现/活动锚点在 application/message-lifecycle 装配）。
import type { SurfacingMessageHooks } from './service.ts';

export type MessageLifecycleFact =
  | {
      kind: 'accepted';
      conversationId: string; messageId: string; revision: number; sequence: number;
      content: string; contentHash: string; occurredAt: string | null;
      /** 本次是否真实首次发布（幂等重放/路由重提交=false——补缺失作业但不当新真实活动）。 */
      firstAcceptance: boolean;
    }
  | { kind: 'revised'; conversationId: string; messageId: string; supersededRevision: number; revision: number }
  | { kind: 'published'; conversationId: string; messageId: string; revision: number; publishedAt: string };

export type MessageLifecycleHooks = {
  /** 同步事实消费：调用方事务连接内 SQL-only（禁 await/HTTP/嵌套事务）。 */
  inTransaction(fact: Readonly<MessageLifecycleFact>): void;
  /** 事务提交后唤醒已持久登记的工作（conversationId 便于按域唤醒；可重复调用）。 */
  afterCommit(conversationId: string): void;
};

/** 兼容过渡（P09 删）：旧 SurfacingMessageHooks 具体名 → 通用事实适配。
 *  映射保持现行行为：accepted 三种到达路径（首收/幂等重放/路由重提交）都走
 *  浮现既有的幂等登记（逻辑作业唯一键防重）；revised=旧 onUserMessageEdited。 */
export function lifecycleFromLegacySurfacing(legacy: SurfacingMessageHooks): MessageLifecycleHooks {
  return {
    inTransaction(fact) {
      if (fact.kind === 'accepted') {
        legacy.onUserMessageAccepted({
          conversationId: fact.conversationId, messageId: fact.messageId, revision: fact.revision,
          sequence: fact.sequence, content: fact.content, contentHash: fact.contentHash, occurredAt: fact.occurredAt,
        });
      } else if (fact.kind === 'revised') {
        legacy.onUserMessageEdited({ conversationId: fact.conversationId, messageId: fact.messageId, supersededRevision: fact.supersededRevision });
      }
      // published：浮现不消费（活动锚点在 application 装配的另一消费者）
    },
    afterCommit: (conversationId) => {
      void conversationId; // 旧签名无参；语义不变（唤醒全部已登记工作）
      legacy.afterCommit();
    },
  };
}

export function isLegacySurfacingHooks(h: unknown): h is SurfacingMessageHooks {
  return typeof h === 'object' && h !== null && 'onUserMessageAccepted' in h;
}
