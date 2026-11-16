// 包2 批A（2026-11-16）：DBG-01 供应商错误具体原因保留 + DBG-03 memory_update 模型入口。
// DBG-01 用真实 OpenRouterRunner + 脚本 transport（非 2xx 带 JSON 错误体）；DBG-03 用
// 最小装配的 MemoryToolsService + M 桩（边界行为：成功/版本冲突/结果未知/参数门）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import type { MariposaClient, MariposaCallResult } from '../../apps/host/src/integrations/mariposa/client.ts';

test('DBG-01: OR 非 2xx 读取响应体具体原因——errorMessage 带供应商 error.message，不再只有 HTTP {status}', async () => {
  const transport: OrTransport = async () => ({
    status: 502,
    headers: new Map<string, string>() as unknown as { get(name: string): string | null },
    body: Readable.from([Buffer.from(JSON.stringify({ error: { message: 'Upstream provider capacity exceeded (worker pool saturated)' } }))]),
  });
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const result = await runner.run({
    driver: 'openrouter', prompt: '',
    envelope: { model: 'anthropic/claude-opus-4.6', sessionId: 'dbg01-session', messages: [{ role: 'user', content: '合成' }], tools: [], boundaries: [], maxTokens: 64, reasoning: null } as never,
    options: {} as never,
    abortController: new AbortController(),
    onEvent: () => {},
  } as never);
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, 'OR_HTTP_502');
  assert.ok(result.errorMessage?.includes('HTTP 502'), result.errorMessage ?? '');
  assert.ok(result.errorMessage?.includes('Upstream provider capacity exceeded'), '供应商具体原因进入 errorMessage（旧实现只剩状态码）');
});

test('DBG-01: OR 非 2xx 纯文本/空正文——退回状态码语义，不误判断流', async () => {
  const textTransport: OrTransport = async () => ({
    status: 429,
    headers: new Map<string, string>() as unknown as { get(name: string): string | null },
    body: Readable.from([Buffer.from('rate limited, slow down')]),
  });
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, textTransport);
  const result = await runner.run({
    driver: 'openrouter', prompt: '',
    envelope: { model: 'anthropic/claude-opus-4.6', sessionId: 'dbg01-session', messages: [{ role: 'user', content: '合成' }], tools: [], boundaries: [], maxTokens: 64, reasoning: null } as never,
    options: {} as never,
    abortController: new AbortController(),
    onEvent: () => {},
  } as never);
  assert.equal(result.errorCode, 'OR_HTTP_429');
  assert.ok(result.errorMessage?.includes('rate limited'), '纯文本正文作为具体原因');
});

/** 最小 M 桩：只实现 memory_update 用到的面。 */
function stubClient(memoryUpdateImpl: (args: Record<string, unknown>) => Promise<MariposaCallResult>): MariposaClient {
  return {
    withSignal: () => stubClient(memoryUpdateImpl),
    memoryUpdate: memoryUpdateImpl,
  } as unknown as MariposaClient;
}

function makeService(client: MariposaClient): MemoryToolsService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-mu-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return new MemoryToolsService({ db, mariposa: client, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
}

const CTX = { roomId: 'primary', turnId: 't-mu', requestId: 'r-mu', toolCallId: 'c-mu' } as never;

test('DBG-03: memory_update 成功/版本冲突/结果未知/参数门', async () => {
  // ① 成功：回执带新版本
  const okSvc = makeService(stubClient(async () => ({ ok: true, result: { memory_id: 'mem_1', version: 3 } })));
  const ok = await okSvc.memoryUpdate({ memory_id: 'mem_1', expected_version: 2, text: '啾啾' }, CTX);
  assert.equal(ok.ok, true, JSON.stringify(ok.output));
  assert.equal(ok.output['updated'], true);
  assert.equal(ok.output['version'], 3);

  // ② 版本冲突：409 VERSION_CONFLICT → 如实给重读指引，不覆盖
  const conflictSvc = makeService(stubClient(async () => ({ ok: false, code: 'VERSION_CONFLICT', httpStatus: 409 })));
  const conflict = await conflictSvc.memoryUpdate({ memory_id: 'mem_1', expected_version: 1, text: 'x' }, CTX);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.output['error_code'], 'UPDATE_VERSION_CONFLICT');
  assert.ok(String(conflict.output['detail']).includes('memory_read_full'), '冲突回执给重读入口');
  assert.equal(conflict.output['memory_id'], 'mem_1');

  // ③ 传输结果未知：不盲重试指引
  const unknownSvc = makeService(stubClient(async () => { throw new Error('connection reset'); }));
  const unknown = await unknownSvc.memoryUpdate({ memory_id: 'mem_1', expected_version: 2 }, CTX);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.output['error_code'], 'UPDATE_OUTCOME_UNKNOWN');

  // ④ 参数门：缺 expected_version 直接拒绝（不外呼）
  let called = 0;
  const gateSvc = makeService(stubClient(async () => { called += 1; return { ok: true, result: {} }; }));
  const bad = await gateSvc.memoryUpdate({ memory_id: 'mem_1', text: 'x' }, CTX);
  assert.equal(bad.ok, false);
  assert.equal(bad.output['error_code'], 'TOOL_ARG_INVALID');
  assert.equal(called, 0, '参数门在本地拦截，未外呼');
});
