import type { AccountInfo, SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

const subscriptionLimits: ReadonlySet<SDKRateLimitInfo['rateLimitType']> = new Set([
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included',
]);

export function subscriptionRejected(info: SDKRateLimitInfo | undefined): boolean {
  return info?.status === 'rejected' && subscriptionLimits.has(info.rateLimitType);
}

/** Authenticate the transport and check paid-overage admission independently
 * of the optional plan labels returned by the runtime. */
export function subscriptionAdmission(account: AccountInfo, usage: SDKControlGetUsageResponse | null): string | null {
  // 0.3.283 omits tokenSource for a normal local claude.ai subscription login.
  // Its display label defaults to "Claude API" when the plan is unknown. Neither
  // label is an authentication requirement or evidence of quota exhaustion.
  if (account.apiProvider !== 'firstParty' || account.apiKeySource || account.tokenSource === 'none') {
    return 'SDK_SUBSCRIPTION_AUTH_REQUIRED';
  }
  // The owner approved activation with unavailable quota data. Local auth and
  // billing confirmation still gate runner creation; unknown does not mean off.
  if (usage?.rate_limits?.extra_usage?.is_enabled === true) return 'SDK_EXTRA_USAGE_ENABLED';
  return null;
}

export function sdkUsesExtraUsage(info: SDKRateLimitInfo): boolean {
  return info.isUsingOverage === true || info.overageInUse === true;
}

export function subscriptionResetTime(info: SDKRateLimitInfo | undefined): number | null {
  // SDK 0.3.283 uses Unix seconds, unlike the ISO timestamps returned by /usage.
  return typeof info?.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0
    ? info.resetsAt * 1000 : null;
}
