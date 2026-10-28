import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config/schema.ts';
import { selectRunner, type AgentRunner, type RunnerRunRequest, type RunnerRunResult, type RunnerSelection } from './runner.ts';
import { RuntimeSettingsService } from './runtime-settings.ts';
import { subscriptionRejected, subscriptionResetTime } from './sdk-subscription.ts';
import { ClaudeSdkRunner } from './runner-claude-sdk.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

export type AccessPolicy = 'configured' | 'subscription-first';

/** One host, two separately initialized model transports. Only an official SDK
 * subscription rejection grants the OR lane while subscription-first is selected. */
export class SubscriptionAccessRunner implements AgentRunner {
  readonly interruptSupport = 'claimed' as const;
  private sdk: RunnerSelection | null = null;
  private lastLimit: SDKRateLimitInfo | undefined;
  private actualEntry: AgentRunner['kind'] | null = null;
  private lastError: string | null = null;
  private turnPolicy = new AsyncLocalStorage<AccessPolicy>();
  readonly config: Config;
  readonly settings: RuntimeSettingsService;
  private factory: (config: Config) => Promise<RunnerSelection>;
  private now: () => number;
  constructor(
    config: Config,
    settings: RuntimeSettingsService,
    factory: (config: Config) => Promise<RunnerSelection> = selectRunner,
    now: () => number = Date.now,
  ) {
    this.config = config; this.settings = settings; this.factory = factory; this.now = now;
    const saved = settings.get('sdk_subscription_limit');
    if (saved) this.lastLimit = JSON.parse(saved) as SDKRateLimitInfo;
  }

  policy(): AccessPolicy { return this.turnPolicy.getStore() ?? this.settings.accessPolicy(this.config.runtime.access_policy); }
  atSafeTurn<T>(work: () => Promise<T>): Promise<T> { return this.turnPolicy.run(this.settings.accessPolicy(this.config.runtime.access_policy), work); }
  get kind(): AgentRunner['kind'] {
    return this.policy() === 'subscription-first' ? 'claude-agent-sdk' : this.config.runtime.provider as AgentRunner['kind'];
  }
  useOpenRouter(): boolean {
    const reset = subscriptionResetTime(this.lastLimit);
    return this.policy() === 'subscription-first' && subscriptionRejected(this.lastLimit) && reset !== null && reset > this.now();
  }
  canFallback(result: RunnerRunResult): boolean {
    return this.policy() === 'subscription-first' && result.errorCode === 'SDK_SUBSCRIPTION_EXHAUSTED'
      && subscriptionRejected(result.subscriptionLimit) && result.activityStarted === false;
  }
  status() {
    const reset = subscriptionResetTime(this.lastLimit);
    return { policy: this.policy(), actual_entry: this.actualEntry, last_error: this.lastError,
      next_entry: this.useOpenRouter() ? 'openrouter' : this.kind,
      subscription: { status: this.lastLimit?.status ?? 'unverified', limit_type: this.lastLimit?.rateLimitType ?? null,
        resets_at: reset === null ? null : new Date(reset).toISOString(),
        reset_state: reset === null ? 'unverified' : reset > this.now() ? 'waiting' : 'due_for_sdk_check',
        extra_usage: this.lastLimit?.isUsingOverage || this.lastLimit?.overageInUse ? 'active' : this.lastError === 'SDK_EXTRA_USAGE_ENABLED' ? 'enabled' : 'unverified' } };
  }

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    const sdkRequest = req.driver !== 'openrouter' && req.driver !== 'deepseek';
    const provider = sdkRequest ? 'claude-agent-sdk' : req.driver;
    if (provider === 'openrouter' && this.policy() === 'subscription-first' && !subscriptionRejected(this.lastLimit)) {
      return this.blocked('SDK_FALLBACK_NOT_AUTHORIZED');
    }
    let selection: RunnerSelection;
    if (sdkRequest) {
      this.sdk ??= await this.factory({ ...this.config, runtime: { ...this.config.runtime, provider } });
      selection = this.sdk;
    } else {
      // Reads OR credentials only after host routing admission. No API credentials
      // are ever added to the SDK options or its child-process environment.
      selection = await this.factory({ ...this.config, runtime: { ...this.config.runtime, provider } });
    }
    if (selection.status === 'blocked') return this.blocked(selection.reasons[0]?.split('：')[0] ?? 'RUNTIME_NOT_READY');
    const result = await selection.runner.run(req);
    this.lastError = result.errorCode;
    if ((result.attempts ?? 0) > 0 || result.outcome === 'completed' || result.activityStarted) this.actualEntry = provider;
    if (result.subscriptionLimit) {
      this.lastLimit = result.subscriptionLimit;
      this.settings.set('sdk_subscription_limit', JSON.stringify(this.lastLimit));
    } else if (sdkRequest && result.outcome === 'completed') {
      this.lastLimit = undefined;
      this.settings.set('sdk_subscription_limit', null);
    }
    return result;
  }

  invalidateSdkSession(windowId: string): void {
    if (this.sdk?.status === 'ok' && this.sdk.runner instanceof ClaudeSdkRunner) this.sdk.runner.invalidateSession(windowId);
  }
  private blocked(code: string): RunnerRunResult {
    this.lastError = code;
    return { outcome: 'error', errorClassified: null, errorCode: code, errorMessage: code, sessionId: null, requestId: null, activityStarted: false, attempts: 0 };
  }
}
