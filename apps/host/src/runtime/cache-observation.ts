// ESTOMAGO_CHAT_EXEC_V1 §04.5（WP2）：缓存证据链——保温目标/估计到期的唯一计算来源。
// 计时依据 = **经缓存读写证据确认**的那次请求的 dispatch_started_at（transport 前落账）；
// 单纯 200、收到回复、请求失败、cache 字段缺失，都不构成计时基准（CACHE-03）。
// 证据可从 usage_observations × provider_requests 派生——不另建第二份缓存状态正本。
// 意外未命中走 §2.2 五条件门（evaluateCacheMiss），路由节点不可见时只说"未命中预期缓存"。
import type { Db } from '../db/connection.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import { evaluateCacheMiss, type SystemAlertService } from '../observability/system-alerts.ts';
import { toolsFingerprint } from './context-fingerprint.ts';
import { modelToolsAfterBindingRetirement, storedToolset } from './tool-discovery.ts';

export const CACHE_TTL_MS = 3_600_000; // 与 openrouter.cache_ttl='1h' 同一合同（不在此另设配置）

export type CacheEvidence = {
  requestId: string;
  windowId: string;
  /** 计时起点：该证据请求的 dispatch_started_at；旧行缺派发时间时回退 sent_at/observed_at 并标 legacy */
  startedAt: string;
  legacy: boolean;
  model: string | null;
  readTokens: number;
  writeTokens: number;
};

function mainToolProfile(db: Db, windowId: string): string | null {
  const set = storedToolset(db, windowId);
  return set?.protocol === 'direct' ? toolsFingerprint(modelToolsAfterBindingRetirement(set.tools)) : null;
}

/** 最近一次有非零缓存读写证据的请求（usage complete；按派发开始时间取最新）。无证据=null（≠0，≠命中）。 */
export function lastCacheEvidence(db: Db, windowId: string): CacheEvidence | null {
  const toolsHash = mainToolProfile(db, windowId);
  const row = db.prepare(
    `SELECT u.request_id AS request_id, pr.window_id AS window_id, u.model AS model,
            u.cache_read_input_tokens AS read_t, u.cache_creation_input_tokens AS write_t,
            pr.dispatch_started_at AS dispatch_at, pr.sent_at AS sent_at, u.observed_at AS observed_at
     FROM usage_observations u
     JOIN provider_requests pr ON pr.id = u.request_id
     WHERE pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
       AND (? IS NULL OR json_extract(pr.context_fingerprint_json, '$.tools_hash') = ?)
       AND ((u.cache_read_input_tokens IS NOT NULL AND u.cache_read_input_tokens > 0)
         OR (u.cache_creation_input_tokens IS NOT NULL AND u.cache_creation_input_tokens > 0))
     ORDER BY COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) DESC
     LIMIT 1`,
  ).get(windowId, toolsHash, toolsHash) as { request_id: string; window_id: string; model: string | null; read_t: number | null; write_t: number | null; dispatch_at: string | null; sent_at: string | null; observed_at: string } | undefined;
  if (!row) return null;
  const startedAt = row.dispatch_at ?? row.sent_at ?? row.observed_at;
  return {
    requestId: row.request_id,
    windowId: row.window_id,
    startedAt,
    legacy: row.dispatch_at === null, // 旧数据无派发时间：不虚构，标记来源
    model: row.model,
    readTokens: row.read_t ?? 0,
    writeTokens: row.write_t ?? 0,
  };
}

/** 保温目标 = 证据请求开始 + 50min（policy 常量；不是 TTL——TTL 仍 1h）。无证据=null。 */
export function keepwarmTargetAtMs(evidence: CacheEvidence | null): number | null {
  const t = Date.parse(evidence?.startedAt ?? '');
  return Number.isFinite(t) ? t + POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms : null;
}

function transportFamilyOf(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source.startsWith('sdk')) return 'sdk';
  if (source === 'or_stream') return 'openrouter';
  if (source === 'ds_stream') return 'deepseek';
  return source;
}

function hasExplicitOneHourCacheControl(payloadWireJson: string | null): boolean {
  if (!payloadWireJson) return false;
  try {
    const parsed = JSON.parse(payloadWireJson) as {
      cache_control?: { type?: unknown; ttl?: unknown };
      messages?: Array<{
        cache_control?: { type?: unknown; ttl?: unknown };
        content?: unknown;
      }>;
    } | null;
    if (!parsed || typeof parsed !== 'object') return false;
    const is1h = (cc: unknown): boolean => Boolean(
      cc && typeof cc === 'object' && (cc as { type?: unknown }).type === 'ephemeral' && (cc as { ttl?: unknown }).ttl === '1h',
    );
    if (is1h(parsed.cache_control)) return true;
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (is1h(m?.cache_control)) return true;
        if (Array.isArray(m?.content)) {
          for (const block of m.content) {
            if (is1h((block as { cache_control?: unknown })?.cache_control)) return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function parseCacheCreationSplit(rawUsageJson: string | null): { ephemeral5m: number | null; ephemeral1h: number | null } {
  if (!rawUsageJson) return { ephemeral5m: null, ephemeral1h: null };
  try {
    const parsed = JSON.parse(rawUsageJson) as {
      cache_creation_split?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
    } | null;
    const split = parsed?.cache_creation_split;
    return {
      ephemeral5m: typeof split?.ephemeral_5m_input_tokens === 'number' ? split.ephemeral_5m_input_tokens : null,
      ephemeral1h: typeof split?.ephemeral_1h_input_tokens === 'number' ? split.ephemeral_1h_input_tokens : null,
    };
  } catch {
    return { ephemeral5m: null, ephemeral1h: null };
  }
}

/** Strict per-request proof for satisfied_by_request cache-postponement (2026-11-25 ruling):
 *  Postponing an ordinary heartbeat due to another completed request (e.g. a quiet autonomous wake)
 *  is ONLY permitted when the request proves it protected the SAME main chat's 1-hour cache:
 *    1. Same window + matching main tool profile (`tools_hash`) + completed with complete usage.
 *    2. Same model AND same transport family as the prior main-chat/heartbeat baseline on this window.
 *    3. Protected prefix scale: non-zero cache read (`readTokens > 0`) and protected prefix
 *       (`readTokens + writeTokens >= baselineProtected` and `readTokens >= 70%` of baseline).
 *    4. Explicit 1-hour TTL coverage (API wire payload carries `cache_control: { type: 'ephemeral', ttl: '1h' }`
 *       and is not 5m-only; SDK usage reports `ephemeral_1h_input_tokens > 0` and is not 5m-only).
 *  When evidence is insufficient, return false so scheduling follows standard v2.1 timing. */
export function provesMainChatOneHourCacheProtection(db: Db, input: {
  windowId: string;
  candidateRequestId: string;
}): boolean {
  const toolsHash = mainToolProfile(db, input.windowId);
  type ObsRow = {
    request_id: string;
    purpose: string | null;
    model: string | null;
    source: string | null;
    read_t: number | null;
    write_t: number | null;
    raw_usage_json: string | null;
    payload_wire_json: string | null;
    tools_hash: string | null;
    started_at: string;
  };
  const candidate = db.prepare(`
    SELECT u.request_id AS request_id, pr.purpose AS purpose, u.model AS model, u.source AS source,
           u.cache_read_input_tokens AS read_t, u.cache_creation_input_tokens AS write_t,
           u.raw_usage_json AS raw_usage_json, pr.payload_wire_json AS payload_wire_json,
           json_extract(pr.context_fingerprint_json, '$.tools_hash') AS tools_hash,
           COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) AS started_at
    FROM usage_observations u
    JOIN provider_requests pr ON pr.id = u.request_id
    WHERE pr.id = ? AND pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
      AND (? IS NULL OR json_extract(pr.context_fingerprint_json, '$.tools_hash') = ?)
    LIMIT 1
  `).get(input.candidateRequestId, input.windowId, toolsHash, toolsHash) as ObsRow | undefined;
  if (!candidate) return false;

  const candRead = candidate.read_t ?? 0;
  const candWrite = candidate.write_t ?? 0;
  if (candRead <= 0) return false; // Must actually read existing main-chat cache (no cold miss).

  const baseline = db.prepare(`
    SELECT u.request_id AS request_id, pr.purpose AS purpose, u.model AS model, u.source AS source,
           u.cache_read_input_tokens AS read_t, u.cache_creation_input_tokens AS write_t,
           u.raw_usage_json AS raw_usage_json, pr.payload_wire_json AS payload_wire_json,
           json_extract(pr.context_fingerprint_json, '$.tools_hash') AS tools_hash,
           COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) AS started_at
    FROM usage_observations u
    JOIN provider_requests pr ON pr.id = u.request_id
    WHERE pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
      AND pr.purpose IN ('chat', 'cache_keepalive')
      AND pr.id != ?
      AND COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) <= ?
      AND (? IS NULL OR json_extract(pr.context_fingerprint_json, '$.tools_hash') = ?)
      AND ((u.cache_read_input_tokens IS NOT NULL AND u.cache_read_input_tokens > 0)
        OR (u.cache_creation_input_tokens IS NOT NULL AND u.cache_creation_input_tokens > 0))
    ORDER BY COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) DESC
    LIMIT 1
  `).get(input.windowId, candidate.request_id, candidate.started_at, toolsHash, toolsHash) as ObsRow | undefined;
  if (!baseline) return false;

  // 1. Same model, same transport family, same tools_hash (when present).
  if (!candidate.model || !baseline.model || candidate.model !== baseline.model) return false;
  const candTransport = transportFamilyOf(candidate.source);
  const baseTransport = transportFamilyOf(baseline.source);
  if (!candTransport || !baseTransport || candTransport !== baseTransport) return false;
  if (candidate.tools_hash && baseline.tools_hash && candidate.tools_hash !== baseline.tools_hash) return false;

  // 2. Protected prefix scale matches the main chat (not a tiny unrelated prompt).
  const baseProtected = (baseline.read_t ?? 0) + (baseline.write_t ?? 0);
  const candProtected = candRead + candWrite;
  if (baseProtected <= 0) return false;
  if (candProtected < baseProtected) return false;
  if (candRead < Math.floor(baseProtected * 0.7)) return false;

  // 3. Explicit 1-hour TTL coverage proof (never accept 5m-only or unverified TTL).
  const split = parseCacheCreationSplit(candidate.raw_usage_json);
  const proven5mOnly = split.ephemeral5m !== null && split.ephemeral5m > 0 && !(split.ephemeral1h !== null && split.ephemeral1h > 0);
  if (proven5mOnly) return false;

  if (candTransport === 'openrouter') {
    return hasExplicitOneHourCacheControl(candidate.payload_wire_json);
  }
  if (candTransport === 'sdk') {
    return split.ephemeral1h !== null && split.ephemeral1h > 0;
  }
  return false;
}

/** 缓存估计到期 = 证据请求开始 + 1h。始终是估计——路由黏性/上游空闲过期独立存在，不承诺物理命中。 */
export function estimatedCacheExpiryAtMs(evidence: CacheEvidence | null): number | null {
  const t = Date.parse(evidence?.startedAt ?? '');
  return Number.isFinite(t) ? t + CACHE_TTL_MS : null;
}

/** 指定请求**之前**的最近证据（评估"本次 read=0 是否意外"的温态前提；不含本次自身）。 */
function priorEvidenceBefore(db: Db, windowId: string, beforeRequestIds: string[], beforeStartedAt: string): CacheEvidence | null {
  const toolsHash = mainToolProfile(db, windowId);
  const row = db.prepare(
    `SELECT u.request_id AS request_id, pr.window_id AS window_id, u.model AS model,
            u.cache_read_input_tokens AS read_t, u.cache_creation_input_tokens AS write_t,
            pr.dispatch_started_at AS dispatch_at, pr.sent_at AS sent_at, u.observed_at AS observed_at
     FROM usage_observations u
     JOIN provider_requests pr ON pr.id = u.request_id
     WHERE pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
       AND (? IS NULL OR json_extract(pr.context_fingerprint_json, '$.tools_hash') = ?)
       AND ((u.cache_read_input_tokens IS NOT NULL AND u.cache_read_input_tokens > 0)
         OR (u.cache_creation_input_tokens IS NOT NULL AND u.cache_creation_input_tokens > 0))
       AND COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) < ?
       AND u.request_id != ?
     ORDER BY COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) DESC
     LIMIT 1`,
  ).get(windowId, toolsHash, toolsHash, beforeStartedAt, beforeRequestIds[0] ?? '') as { request_id: string; window_id: string; model: string | null; read_t: number | null; write_t: number | null; dispatch_at: string | null; sent_at: string | null; observed_at: string } | undefined;
  if (!row) return null;
  return {
    requestId: row.request_id, windowId: row.window_id,
    startedAt: row.dispatch_at ?? row.sent_at ?? row.observed_at, legacy: row.dispatch_at === null,
    model: row.model, readTokens: row.read_t ?? 0, writeTokens: row.write_t ?? 0,
  };
}

// Anthropic 可缓存前缀的最小长度量级（公开文档 1024 token 起）；用于"提示不足最小可缓存长度"排除。
// 未知输入（null）= 不评——不猜。
const MIN_CACHEABLE_TOKENS = 1024;

/**
 * usage 落账后的缓存观测钩子：
 *  - 字段缺失（read=null）→ 不评估不刷新（CACHE-03：null 不是 0）；
 *  - 温态五条件全齐且完整 usage 明确 read=0 → CACHE_UNEXPECTED_MISS（warning，幂等）；
 *  - 命中/写入证据本身不在这里落新状态（可派生，无第二正本）。
 */
export function observeCacheUsage(alerts: SystemAlertService, input: {
  db: Db; windowId: string; requestId: string | null; model: string | null;
  readTokens: number | null; writeTokens: number | null; inputTotal: number | null;
  dispatchStartedAt: string | null;
  usageCompleteness?: string;
}): void {
  if (input.usageCompleteness !== undefined && input.usageCompleteness !== 'complete') return;
  if (input.readTokens === null && input.writeTokens === null) return; // 字段缺失=unknown
  if (input.requestId === null || input.dispatchStartedAt === null) return; // 无派发起点=不猜温态
  if (input.readTokens !== null && input.readTokens > 0) return; // 命中（部分或全）不是 miss
  const prior = priorEvidenceBefore(input.db, input.windowId, [input.requestId], input.dispatchStartedAt);
  const gate = evaluateCacheMiss({
    cache_read_tokens: input.readTokens, // 此处必然 0 或 null→已被上方挡掉
    same_model_and_upstream: prior !== null && (prior.model ?? null) === (input.model ?? null),
    same_cacheable_prefix_version: prior !== null, // 同窗且发送前 append-only 断言已过=前缀版本一致
    has_prior_reliable_read_write: prior !== null,
    within_expected_ttl: prior !== null && Date.parse(input.dispatchStartedAt) - Date.parse(prior.startedAt) < CACHE_TTL_MS,
    known_cold_start: prior === null,
    prefix_at_least_min_cacheable: input.inputTotal !== null && input.inputTotal >= MIN_CACHEABLE_TOKENS,
  });
  if (gate.trigger) {
    alerts.observe({
      code: 'CACHE_UNEXPECTED_MISS', scopeKind: 'conversation', scopeId: input.windowId,
      dedupeKey: `cache-miss:${input.windowId}:${input.requestId}`,
      observationId: `cache-miss:${input.requestId}`,
      safeSummary: { title: '未命中预期缓存', detail: '温缓存预期下完整用量显示读取为 0（路由节点不可见，不断言供应商故障）', count: 1, reason: gate.reason },
      related: { requestId: input.requestId },
    });
  }
}
