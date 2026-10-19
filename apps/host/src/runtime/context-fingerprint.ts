import { fixedSystemCount } from './cache-plan.ts';
// 上下文指纹（docs/audits/estomago-cost-20261018 第二阶段）：每次模型派发把
// 可缓存结构以 hash 留证在 provider_requests.context_fingerprint_json。
//  - 只落 hash/位置/计数，构造上不可能携带正文或 token（AGENTS §4）。
//  - 相邻请求按 (model, session, tools_hash) 分组，对比 msgs_hash 与 usage 的
//    read/write 即可离线判定前缀是否稳定复用、断点是否漂移——此前审计要
//    逐笔解析 MB 级 payload_wire_json 才能得到这些结论（cost-20261018-01
//    的 112 笔事后指纹即按同一口径回算，作为本列的语义基线）。
//  - msgs_hash 对整个 messages 计算（envelope 内部投影，无 cache 标记）；
//    reasoning 是逐请求参数（RRA-017），不参与任何指纹字段。
import { sha256Hex } from '../util/id.ts';
import type { OrBoundary, OrMessage, OrTool } from './or-payload.ts';

export type ContextFingerprint = {
  /** 工具循环轮次（0=首发；同轮重试行 attempt_no>0 指纹相同） */
  round_no: number;
  tools_n: number;
  /** 工具定义整体（含顺序）——缓存前缀最前段，任何增删/改序都会变 */
  tools_hash: string;
  /** A 段（身份+规则+I+宿主固定段）= messages[0]；null=形状异常（非 system 开头） */
  system_a_hash: string | null;
  /** B 段（Mariposa 开窗资料）= messages[1]；null=本请求无 B 段 */
  boot_hash: string | null;
  sys_count: number;
  msgs_n: number;
  /** 整个 messages（含尾部当前输入）——同组相邻对比即验证"历史只追加" */
  msgs_hash: string;
  /** cache-plan 规划落点（A/B/G，≤3；Bedrock 显式尾点由 or-payload 恒定补齐，不入指纹） */
  boundaries: Array<{ m: number; c: number }>;
};

export function contextFingerprintOf(input: {
  round: number;
  tools: OrTool[];
  messages: OrMessage[];
  boundaries: OrBoundary[];
}): ContextFingerprint {
  const { round, tools, messages, boundaries } = input;
  const sysCount = messages.filter((m) => m.role === 'system').length;
  const hashOf = (v: unknown): string => sha256Hex(JSON.stringify(v)).slice(0, 12);
  return {
    round_no: round,
    tools_n: Array.isArray(tools) ? tools.length : 0,
    tools_hash: hashOf(tools ?? null),
    system_a_hash: messages[0]?.role === 'system' ? hashOf(messages[0]) : null,
    boot_hash: fixedSystemCount(messages) >= 2 ? hashOf(messages[1]!) : null,
    sys_count: sysCount,
    msgs_n: messages.length,
    msgs_hash: hashOf(messages),
    boundaries: boundaries.map((b) => ({ m: b.messageIndex, c: b.contentIndex })),
  };
}

export function contextFingerprintJson(input: Parameters<typeof contextFingerprintOf>[0]): string {
  return JSON.stringify(contextFingerprintOf(input));
}
