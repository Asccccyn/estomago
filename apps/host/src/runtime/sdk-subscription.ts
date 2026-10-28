import type { AccountInfo, SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

const subscriptionLimits: ReadonlySet<SDKRateLimitInfo['rateLimitType']> = new Set([
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included',
]);

export function subscriptionRejected(info: SDKRateLimitInfo | undefined): boolean {
  return info?.status === 'rejected' && subscriptionLimits.has(info.rateLimitType);
}

/** Both the local identity and the server's plan response are required. A local
 * "verified" flag or an API-key response cannot stand in for a subscription. */
export function subscriptionAdmission(account: AccountInfo, usage: SDKControlGetUsageResponse | null): string | null {
  if (account.apiProvider !== 'firstParty' || !account.subscriptionType || !account.tokenSource || account.apiKeySource) {
    return 'SDK_SUBSCRIPTION_AUTH_REQUIRED';
  }
  if (!usage?.rate_limits_available || !usage.subscription_type || !usage.rate_limits?.extra_usage) return 'SDK_EXTRA_USAGE_UNVERIFIED';
  if (usage.rate_limits.extra_usage.is_enabled !== false) return 'SDK_EXTRA_USAGE_ENABLED';
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
