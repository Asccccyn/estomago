import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult, RunnerSelection } from './runner.ts';
import { runSdkHostQuery, type SdkQueryFactory, type SdkSessionAnchor } from './sdk-host-query.ts';

const require_ = createRequire(import.meta.url);

export function installedSdkVersion(): string | null {
  try {
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
    return (JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version: string }).version;
  } catch { return null; }
}

export async function tryLoadClaudeSdkRunner(config: Config): Promise<RunnerSelection> {
  const installed = installedSdkVersion();
  if (installed === null) return { status: 'blocked', reasons: ['SDK_PACKAGE_NOT_INSTALLED'] };
  const reasons: string[] = [];
  if (!config.runtime.sdk_version || config.runtime.sdk_version !== installed) reasons.push('SDK_VERSION_NOT_VERIFIED');
  if (!config.runtime.auth_and_billing_verified) reasons.push('SDK_SUBSCRIPTION_AUTH_REQUIRED');
  if (!config.runtime.subscription_proxy_url) reasons.push('SDK_PROXY_REQUIRED');
  if (reasons.length) return { status: 'blocked', reasons };
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return { status: 'ok', runner: new ClaudeSdkRunner(query) };
  } catch { return { status: 'blocked', reasons: ['SDK_IMPORT_FAILED'] }; }
}

export class ClaudeSdkRunner implements AgentRunner {
  readonly kind = 'claude-agent-sdk' as const;
  readonly interruptSupport = 'claimed' as const;
  private query: SdkQueryFactory;
  private sessions = new Map<string, SdkSessionAnchor>();
  constructor(query: SdkQueryFactory) { this.query = query; }

  invalidateSession(windowId: string): void { this.sessions.delete(windowId); }

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    if ('host' in req && req.host) return runSdkHostQuery(this.query, { ...req, host: req.host }, this.sessions);
    // The old prompt-only path had neither the host tool bridge nor subscription
    // admission. Keeping it would create a second, unaudited SDK entry point.
    return { outcome: 'error', errorClassified: null, errorCode: 'SDK_HOST_CONTEXT_REQUIRED',
      errorMessage: 'SDK 请求必须来自 est 的上下文与工具执行链', sessionId: null, requestId: null };
  }
}
