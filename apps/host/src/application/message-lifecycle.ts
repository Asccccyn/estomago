// application/message-lifecycle.ts（P05.3）：消息生命周期消费者装配。
// 把浮现登记（prepare/撤销/重提交）、活动锚点（正式发布 L 记账）作为同一事实流的消费者
// 显式装配；使用消息服务既有同连接事务（inTx SQL-only、不 await、不 HTTP）。
// 归档 outbox 是消息服务自身的正本行为，不在此重复登记；不新建中央 event-inbox 表。
import type { MessageLifecycleFact, MessageLifecycleHooks } from '../messages/lifecycle.ts';
import type { SurfacingMessageHooks } from '../messages/service.ts';

export type MessageLifecycleConsumers = {
  /** 浮现域（ SurfacingService 结构面：登记/撤销/提交后唤醒）。 */
  surfacing: SurfacingMessageHooks | null;
  /** 活动锚点（wake-activity：正式发布的真实活动记账）。 */
  activity: { noteRealPublication(conversationId: string, messageId: string, revision: number, atIso: string): void } | null;
};

export function bindMessageLifecycle(consumers: MessageLifecycleConsumers): MessageLifecycleHooks {
  return {
    inTransaction(fact: Readonly<MessageLifecycleFact>): void {
      if (fact.kind === 'accepted') {
        // 浮现登记幂等（逻辑作业唯一键）——首收/幂等重放/路由重提交三种到达同门，
        // "补缺失作业但不当新真实活动"的现行语义在浮现域内保持（P05.4）。
        consumers.surfacing?.onUserMessageAccepted({
          conversationId: fact.conversationId, messageId: fact.messageId, revision: fact.revision,
          sequence: fact.sequence, content: fact.content, contentHash: fact.contentHash, occurredAt: fact.occurredAt,
        });
      } else if (fact.kind === 'revised') {
        // 编辑撤销：旧修订作业失效（未错过目标轮的可建新作业——浮现域判断）
        consumers.surfacing?.onUserMessageEdited({ conversationId: fact.conversationId, messageId: fact.messageId, supersededRevision: fact.supersededRevision });
      }
      // published：浮现不消费；活动锚点在发布动作内由消息服务原端口调用（noteRealPublication），
      // 保持 L 记账与发布同事务的现行次序——不改为事实流旁路（行为等价红线）。
    },
    afterCommit: (conversationId) => {
      void conversationId;
      consumers.surfacing?.afterCommit();
    },
  };
}
