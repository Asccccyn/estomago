// §8.1：动态提醒模板——内容逐字来自 docs/specs/ESTOMAGO_OR_SELF_HOLD/prompts/pre-rotate-review.txt（冻结版）。
// 以 synthetic user 内容块注入轨迹尾部（宿主记录真实 origin，不进聊天原文，不是高权限授权）。
// Only capacity-triggered reviews use this template; manual rotation never does.
export function buildPreRotateReviewMessage(args: { reviewId: string; reason: 'capacity'; messageRefs: string }): string {
  return [
    '[宿主运行事件：换窗前记忆检查；不是用户发言]',
    `review_id: ${args.reviewId}`,
    `reason: ${args.reason}`,
    `context_epoch: <当前窗口>`,
    `focus_message_refs: ${args.messageRefs}`,
    '',
    '请考虑上述焦点范围里，还有没有你自己想写进Mariposa的事情。',
    '这些原话已经在当前输入中，不需要再复制一遍。可以零条、一条或多条；不用全量补齐，不必回头补记更早未hold的闲聊。你仍可自愿按既有权限记起更早的事。已经写过的不要重复。',
    '有要写的，调用既有hold与必要的来源能力，并以真实成功回执为准。没有则调用context_review_complete(review_id, no_new_hold)。写完本次选择的hold后，调用context_review_complete(review_id, holds_completed)。',
    '不要生成会话摘要，不要求所有事件闭合，不向聊天界面生成额外回复。本次完成表示可以安全换窗。',
  ].join('\n');
}
