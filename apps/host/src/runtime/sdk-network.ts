import { spawn } from 'node:child_process';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** A proxy variable alone does not prevent a runtime from opening a direct
 * socket. The SDK's supported process factory keeps the official binary under
 * a macOS network restriction; only this loopback proxy port is reachable. */
export function proxyOnlySdkSpawn(proxyUrl: string | undefined): NonNullable<Options['spawnClaudeCodeProcess']> {
  if (process.platform !== 'darwin') throw Error('SDK_NETWORK_ISOLATION_UNAVAILABLE');
  if (!proxyUrl) throw Error('SDK_PROXY_REQUIRED');
  const url = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port) throw Error('SDK_LOOPBACK_PROXY_REQUIRED');
  const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${url.port}"))`;
  return options => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, options.command, ...options.args], {
      cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // SDK stderr can contain private context; consume it without forwarding it
    // into host logs. Exit status remains observable through the official Query.
    child.stderr.resume();
    return child;
  };
}
