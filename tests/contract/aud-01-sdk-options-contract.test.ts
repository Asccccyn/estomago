// AUD-01 回归：SDK 传参契约——除 prompt 外全部在 options 内；abortController 是 AbortController；
// cwd/env/resume 就位。SDK 层级契约变化时本测试必须失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { buildSdkOptions } from '../../apps/host/src/runtime/build-options.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

test('query() 收到的参数：顶层仅 prompt+options；全部关键字段在 options 内（0.3.283 契约）', async () => {
  const root = (makeDb()).root;
  writeApprovedIdentity(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const { db } = makeDb(root);
  const gate = identity.evaluateGate(db);
  assert.equal(gate.state, 'READY');
  const built = buildSdkOptions({ config, gate, identityText: identity.readApprovedIdentityText(gate.manifest!), cwd: paths.workspacesDir });
  assert.equal(built.status, 'ok');

  const captured: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const runner = new ClaudeSdkRunner((p) => {
    captured.push(p as { prompt: string; options: Record<string, unknown> });
    return (async function* () { yield { type: 'result', subtype: 'success', usage: { input_tokens: 1 } }; })();
  });
  const res = await runner.run({
    prompt: '契约探针', options: built.assembled, resumeSessionId: 'sess_x',
    abortController: new AbortController(), onEvent: () => {},
  });
  assert.equal(res.outcome, 'completed');
  const p = captured[0]!;
  assert.deepEqual(Object.keys(p).sort(), ['options', 'prompt'], 'query 顶层只能有 prompt 与 options');
  const o = p.options;
  for (const key of ['model', 'systemPrompt', 'settingSources', 'tools', 'mcpServers', 'strictMcpConfig', 'includePartialMessages', 'thinking', 'cwd', 'settings', 'env', 'resume']) {
    assert.ok(key in o, `options.${key} 必须存在（AUD-01）`);
  }
  assert.equal(o.resume, 'sess_x', '同窗后续轮必须 resume（AUD-03）');
  assert.equal(o.cwd, paths.workspacesDir, 'cwd 必须是隔离 workspaces 目录');
  assert.ok(p.options?.abortController instanceof AbortController, 'abortController 必须是真 AbortController');
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.thinking, { type: 'adaptive', display: 'summarized' });
  // F07：effort 在顶层（如有配置）
  assert.equal((o.settings as Record<string, unknown>).autoMemoryEnabled, false);
  assert.equal((o.settings as Record<string, unknown>).disableClaudeAiConnectors, true);
  assert.equal((o.settings as Record<string, unknown>).switchModelsOnFlag, false);
  db.close();
});

test('无 resume 时 options 不含 resume 键（首轮新 session）', async () => {
  const root = (makeDb()).root;
  writeApprovedIdentity(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const identity = new IdentityService(config, paths);
  const { db } = makeDb(root);
  const gate = identity.evaluateGate(db);
  const built = buildSdkOptions({ config, gate, identityText: 'x', cwd: paths.workspacesDir });
  const captured: Array<Record<string, unknown>> = [];
  const runner = new ClaudeSdkRunner((p) => {
    captured.push(p as Record<string, unknown>);
    return (async function* () { yield { type: 'result', subtype: 'success' }; })();
  });
  await runner.run({ prompt: 'p', options: built.assembled!, resumeSessionId: null, abortController: new AbortController(), onEvent: () => {} });
  assert.equal('resume' in (captured[0]!.options as object), false);
  db.close();
});
