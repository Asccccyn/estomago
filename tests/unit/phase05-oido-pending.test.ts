// Phase 0.5 整改验证（跨仓预审 F-07，2026-10-25）：正常深听在途（oído NOT_READY_YET →
// adapter OIDO_NOT_READY）在宿主 UI 响应边界透传为 HTTP 409——前端既有
// 合同即"409=pending 轮询"（App.tsx fetchOverview），不再被折叠成 422 显示"深听不可用"。
// 联合审计 A02（2026-10-27）：adapter 按 oído 错误体 code 映射（不再按状态码），
// 逐字谱 NO_CHAR_ALIGNMENT 等同为 409 的确定错误走 422，前端不再无限轮询。
// tools stub 只替代工具执行层（adapter 映射由 oido-pending-observation 真实驱动），
// 被测对象是真实 handleOidoUiRoutes 路由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { handleOidoUiRoutes } from '../../apps/host/src/server/routes/oido-ui.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

class FakeRes extends Writable {
  status = 0; body: unknown = null;
  _write(chunk: Buffer, _e: string, cb: (e?: Error | null) => void): void { cb(); }
  writeHead(status: number): void { this.status = status; }
  end(body?: unknown): void { if (typeof body === 'string') this.body = JSON.parse(body); this.destroyed = true; }
  destroyed = false;
}
const call = async (errorCode: string | null, target: 'view' | 'prosody' = 'view'): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = new FakeRes();
  const req = Readable.from([]) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
  req.headers = {}; req.method = 'GET';
  const route = target === 'prosody' ? 'GET /api/v1/oido/analyses/an_1/prosody' : 'GET /api/v1/oido/analyses/an_1';
  req.url = target === 'prosody' ? '/api/v1/oido/analyses/an_1/prosody' : '/api/v1/oido/analyses/an_1';
  const deps = {
    tools: {
      execute: async () => errorCode === null
        ? { ok: true, output: { analysis_id: 'an_1', state: 'ready' } }
        : { ok: false, output: { error_code: errorCode, error: 'oído 在途或失败' } },
    },
  } as never;
  await handleOidoUiRoutes(req as never, res as never, deps, route, new URL(`http://x${req.url}`));
  return { status: res.status, body: res.body as Record<string, unknown> };
};

test('F-07 oído 在途=409 pending；其他失败保持 422；成功 200', async () => {
  const pending = await call('OIDO_NOT_READY');
  assert.equal(pending.status, 409, '在途分析透传 409（前端合同：409=pending）');
  const failure = await call('OIDO_GET_422:ANALYSIS_FAILED');
  assert.equal(failure.status, 422, '真实失败仍如实 422');
  const ok = await call(null);
  assert.equal(ok.status, 200);
  // 复审收紧：逐字谱（prosody）分支真实驱动（此前仅静态）
  const pagePending = await call('OIDO_NOT_READY', 'prosody');
  assert.equal(pagePending.status, 409, '逐字谱在途透传 409');
  const pageNoAlignment = await call('OIDO_PAGE_409:NO_CHAR_ALIGNMENT', 'prosody');
  assert.equal(pageNoAlignment.status, 422, '无字级对齐是确定错误，不当在途');
  const pageOk = await call(null, 'prosody');
  assert.equal(pageOk.status, 200);
  console.log(JSON.stringify({ case: 'f07_oido_pending', pending_409: true, prosody_pending_409: true, failure_422: true, ok_200: true }));
});
