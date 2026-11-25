// application/message-lifecycle.ts（P05.3）：消息生命周期消费者装配。
// 把浮现登记（prepare/撤销/重提交）、活动锚点（正式发布 L 记账）作为同一事实流的消费者
// 显式装配；使用消息服务既有同连接事务（inTx SQL-only、不 await、不 HTTP）。
// 归档 outbox 是消息服务自身的正本行为，不在此重复登记；不新建中央 event-inbox 表。
import type { MessageLifecycleFact, MessageLifecycleHooks } from '../messages/lifecycle.ts';
import type { SurfacingService } from '../memory-surfacing/service.ts';
import { detectRestIntent } from '../runtime/conversation-rest.ts';
import type { SleepWindowConfig } from '../runtime/keepwarm-sleep.ts';
import type { ConversationActivityService, RestDecision } from '../runtime/wake-activity.ts';

const DEFAULT_SLEEP_WINDOW: SleepWindowConfig = { enabled: true, start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' };

export type MessageLifecycleConsumers = {
  /** 浮现作业随正式输入登记，由目标回合领取。 */
  surfacing: Pick<SurfacingService, 'onUserMessageAccepted' | 'onUserMessageEdited'> | null;
  /** 活动锚点（wake-activity：正式发布的真实活动记账）与休息决定（乔乔本人明确说睡/回来）。 */
  activity: {
    noteRealPublication(conversationId: string, messageId: string, revision: number, atIso: string): void;
    noteRestDecision?(conversationId: string, decision: RestDecision): boolean;
    noteOwnerMessageAccepted?: ConversationActivityService['noteOwnerMessageAccepted'];
  } | null;
  /** 异步 Sol 休息意图协调器（与记忆浮现独立；仅在需要语义判断的首次受理消息提交后唤醒）。 */
  restJudge?: {
    configured(): boolean;
    wake(conversationId: string): void;
  } | null;
  /** 心跳睡眠时段与控制版本读取（同事务内用于夜间四小时判定与控制版本绑定）。 */
  heartbeatContext?: {
    sleepWindow(): SleepWindowConfig;
    controlRevision(): number;
  } | null;
  /** 正式消息提交后同步刷新心跳预计目标（只在实际变化时写任务行）。 */
  onScheduleDirty?: (() => void) | null;
  /** GLM_VOICE_UNIFICATION P06：语音消息默认分析——接纳即登记观察 sidecar（pending），
   *  提交后唤醒后台一跳。SQL-only 登记（observations.ensureForMessage）；不依赖打开气泡。
   *  RV01（复审 20261106）：修订被取代/派发前取消（dispatchable=false）时终结该修订
   *  观察资格（abandoned）——取消在途 O 分析、迟到结果不再可消费。 */
  voiceObservations: {
    ensureForMessage(messageId: string, revision: number, conversationId: string): void;
    wake(conversationId: string): void;
    abandonRevision(messageId: string, revision: number): void;
  } | null;
};

export function bindMessageLifecycle(consumers: MessageLifecycleConsumers): MessageLifecycleHooks {
  // 装配形状守卫：误传裸 SurfacingService（而非 {surfacing, activity} 包装对象）时钩子会
  // 静默空转——在绑定时刻大声失败，而不是让浮现作业登记悄悄消失。
  const shape = consumers as { surfacing?: unknown; activity?: unknown; voiceObservations?: unknown; onUserMessageAccepted?: unknown };
  if (shape.surfacing === undefined && shape.activity === undefined && shape.voiceObservations === undefined) {
    throw new Error('LIFECYCLE_CONSUMERS_SHAPE_INVALID: 传 { surfacing, activity } 包装对象，不是裸 SurfacingService');
  }
  return {
    inTransaction(fact: Readonly<MessageLifecycleFact>): void {
      if (fact.kind === 'accepted' && fact.dispatchable) {
        // 浮现登记幂等（逻辑作业唯一键）——首收/幂等重放/路由重提交三种到达同门，
        // "补缺失作业但不当新真实活动"的现行语义在浮现域内保持（P05.4）。
        // 派发前已取消的输入（dispatchable=false）不登记：没有可交付的回复，不为它产生检索/JEV 费用。
        consumers.surfacing?.onUserMessageAccepted({
          conversationId: fact.conversationId, messageId: fact.messageId, revision: fact.revision,
          sequence: fact.sequence, content: fact.content, contentHash: fact.contentHash, occurredAt: fact.occurredAt,
        });
      } else if (fact.kind === 'revised') {
        // 编辑撤销：旧修订作业失效（未错过目标轮的可建新作业——浮现域判断）
        consumers.surfacing?.onUserMessageEdited({ conversationId: fact.conversationId, messageId: fact.messageId, supersededRevision: fact.supersededRevision });
      }
      // P06：语音附件消息接纳即登记观察 sidecar（pending；oído 未配置=unsupported 如实）。
      // RV2（复审 20261106 第二轮）：只在**接纳为正式输入**（accepted，含显式改后重发）
      // 时登记——revised 只作废旧修订的资格，不为一个可能永不派发的新修订开后台分析
      //（旧实现"编辑即登记"，没有对应首次模型输入的修订也被分析）。
      if (fact.kind === 'accepted') consumers.voiceObservations?.ensureForMessage(fact.messageId, fact.revision, fact.conversationId);
      // RV01（复审 20261106）：编辑取代旧修订＝旧修订观察资格终结；派发前已取消的输入
      // （dispatchable=false，如电话准备阶段挂断）接纳即终结——同一资格不悬空。
      if (fact.kind === 'revised') consumers.voiceObservations?.abandonRevision(fact.messageId, fact.supersededRevision);
      if (fact.kind === 'accepted' && !fact.dispatchable) consumers.voiceObservations?.abandonRevision(fact.messageId, fact.revision);
      // 首次正式接受的用户消息：在覆盖 last_real_activity_at 之前完成出现版本递增、
      // 连续次数归零、夜间四小时间隔判定，以及本地/Sol 休息意图登记。
      // 幂等重放、改后重发、编辑、模型回复和工具都不触发。
      if (fact.kind === 'accepted' && fact.firstAcceptance) {
        if (consumers.activity?.noteOwnerMessageAccepted) {
          consumers.activity.noteOwnerMessageAccepted({
            conversationId: fact.conversationId,
            messageId: fact.messageId,
            revision: fact.revision,
            content: fact.content,
            acceptedAtIso: fact.receivedAt ?? new Date().toISOString(),
            sleepWindow: consumers.heartbeatContext?.sleepWindow() ?? DEFAULT_SLEEP_WINDOW,
            controlRevision: consumers.heartbeatContext?.controlRevision() ?? 0,
            solConfigured: consumers.restJudge?.configured() === true,
          });
        } else if (consumers.activity?.noteRestDecision) {
          const intent = detectRestIntent(fact.content);
          if (intent) consumers.activity.noteRestDecision(fact.conversationId, {
            kind: intent, source: 'owner_message', messageId: fact.messageId, atIso: fact.receivedAt ?? new Date().toISOString(),
          });
        }
      }
      // published：浮现不消费；活动锚点在发布动作内由消息服务原端口调用（noteRealPublication），
      // 保持 L 记账与发布同事务的现行次序——不改为事实流旁路（行为等价红线）。
    },
    afterCommit: (conversationId) => {
      consumers.voiceObservations?.wake(conversationId);
      if (conversationId) consumers.restJudge?.wake(conversationId);
      consumers.onScheduleDirty?.();
    },
  };
}
