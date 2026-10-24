// context/contributions.ts（P05.5/P05.6）：两种上下文贡献契约（叶）。
// window-open：身份/开窗资料/初始工具等既有有限快照（沿用旧窗缓存，不逐轮重建——BootstrapPort 取资料）。
// before-turn：自动浮现等绑定当前输入的贡献。宿主负责最终角色/插入位置/预算/provider 差异/
// hash/轨迹与权限重检；贡献者只提供业务正文与必要引用，不拿可变的整个历史数组。
// 完整生命周期（P05.5）：prepare→reuseFrozen→finalAdmit→markDispatched→markRetained→cancelForTurn，
// 一个不漏；同轮消息修订/编辑/停止/换窗使旧准备失效，已派发冻结块保留不改。
// supervisor 只消费本叶接口（不 import 浮现具体业务类型、不调远端 Mariposa）。
import type { AugmentInput, AugmentResult } from '../memory-surfacing/service.ts';

export type BeforeTurnBinding = {
  conversationId: string; windowId: string; turnId: string; attemptId: string;
  messageId: string; revision: number;
};

/** 现行方法名沿 04 §F（保留 reuseFrozen/augmentFor/finalAdmit/markDispatched/markRetained/
 *  cancelForTurn 实际语义；中性换名非本批范围）。输入/输出=浮现域既有 Augment 形状
 *  （宿主只消费结果块，不 import 浮现业务类型——实现方在装配处绑定）。 */
export interface BeforeTurnContributor {
  reuseFrozen(attemptId: string): AugmentResult | null;
  augmentFor(input: AugmentInput): Promise<AugmentResult | null>;
  finalAdmit?(value: AugmentResult, input: {
    conversationId: string; windowId: string; messageId: string; revision: number;
  }): Promise<AugmentResult | null>;
  markDispatched?(attemptId: string): void;
  markRetained(value: AugmentResult): void;
  cancelForTurn?(turnId: string): void;
}

export interface WindowOpenContributor {
  /** 沿既有开窗快照/分页/权限合同（BootstrapPort 取资料；不是每轮拉取）。 */
  snapshot(windowId: string, signal?: AbortSignal): Promise<string | null>;
}
