// capabilities/executor.ts（P02.2）：通用执行外壳。
// 从既有 HostToolExecutor.execute/executeInner 的真实顺序提取，不重新发明错误语义：
// 取消检查 → 通话 memory_only 门（per-capability 元数据 + 宿主可信通话状态，D39）
// → 冻结 schema 校验 → 背景工具准入（照搬 admitBackgroundTool 时机与合同）
// → handler → 唯一模型投影（成功 toModel / 失败 modelFailure，各恰一次）。
// 事件（turn.tool start/result/error）仍由旧外层 execute() 以原身份发布——P02 不改变事件 payload。
// 绝不在新路径失败时回退旧 handler（D23/P02.6）。
import type { Db } from '../db/connection.ts';
import { ContractError } from '../runtime/or-contract.ts';
import { modelFailure } from '../runtime/model-results.ts';
import type { CapabilityOutcome, ToolExecContext, ToolExecResult } from './contracts.ts';
import type { CapabilityDescriptor } from './registry.ts';

export type CapabilityExecutorHost = {
  db: Db;
  /** 可信通话状态（宿主持有查询，如 voice_calls active）；不是模型输入。 */
  isVoiceCallActive(roomId: string): boolean;
};

/** 执行一个已注册能力。调用方（HostToolExecutor.executeInner）已按现行路由把
 *  "名称属于已迁集合"的调用交给本函数，且不再进入旧业务分支。 */
export async function executeRegisteredCapability<I, O>(
  descriptor: CapabilityDescriptor<I, O>,
  rawArgs: Record<string, unknown>,
  ctx: ToolExecContext,
  frozenSpec: import('./contracts.ts').HostToolSpec | undefined,
  host: CapabilityExecutorHost,
): Promise<ToolExecResult> {
  if (ctx.signal?.aborted) return { ok: false, output: { error_code: 'CANCELLED' } };
  // A04/D39：通话 memory_only——同一模式判定用于执行前最后边界（catalog 过滤/define/invoke 解析
  // 由旧外层与 model bridge 保持现行行为）。仅约束模型发起的调用（ctx.turnId 非空）。
  if (ctx.turnId && host.isVoiceCallActive(ctx.roomId) && !descriptor.memoryOnlyAllowed) {
    return { ok: false, output: { error_code: 'TOOL_UNAVAILABLE_IN_CALL', detail: '通话期间非记忆业务工具已关闭（memory_only）；挂断后恢复' } };
  }
  // 审计 A051：参数完整校验后才执行（§8.2）——schema 拒绝不产生副作用。
  // 正本=请求窗口冻结 spec；模型调用恒有窗（discovery 提供）。无窗的宿主内部直调
  // 沿旧行为等价回退=条目定义（与当前目录同一 JSON；validateToolArgs 旧回退同源）。
  const spec = frozenSpec ?? descriptor.definition;
  const checked = descriptor.parse(rawArgs, spec);
  if (!checked.ok) return { ok: false, output: { error_code: checked.code, error: checked.detail } };
  // 宿主内部标识随校验后的参数透传（等价于旧 rawToolCallIdRef 单一读取；P04+ 全面去全局）
  const toolCallId = typeof rawArgs.__tool_call_id === 'string' ? rawArgs.__tool_call_id : null;
  if (toolCallId !== null) (checked.value as Record<string, unknown>).__tool_call_id = toolCallId;
  // 背景工具准入记账（照搬 admitBackgroundTool：背景 run 缺准入=合同错误；非背景不查价——D40）
  if (ctx.backgroundRunId && !ctx.beforeBackgroundTool) throw new ContractError('BACKGROUND_TOOL_ADMISSION_MISSING');
  if (ctx.beforeBackgroundTool) ctx.beforeBackgroundTool(descriptor.quote(host.db));
  let outcome: CapabilityOutcome<O>;
  try {
    outcome = await descriptor.run(checked.value, ctx);
  } catch (err) {
    // handler 异常沿现行语义如实上抛（旧外层发 error 事件后 rethrow；不吞成结果）
    throw err;
  }
  if (outcome.ok) {
    return {
      ok: true,
      output: descriptor.toModel(outcome.value, checked.value),
      ...(outcome.seenAdditions !== undefined ? { seenAdditions: outcome.seenAdditions } : {}),
      ...(outcome.imageRefs !== undefined ? { imageRefs: outcome.imageRefs } : {}),
    };
  }
  return { ok: false, output: modelFailure(outcome.error) };
}
