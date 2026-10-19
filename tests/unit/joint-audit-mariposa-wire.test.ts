import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

test('JA-W01: malformed HTTP success is unknown, never successful empty data', async () => {
  const original = globalThis.fetch;
  try {
    for (const body of ['{', '{}', 'null', '[]', '{"ok":true}', '{"ok":true,"data":[]}']) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      const client = new MariposaClient({ baseUrl: 'http://offline.invalid' });
      await assert.rejects(() => client.surfacePrepare({ operation_id: 'same-op' }), /RESPONSE_SHAPE_INVALID/);
    }
    globalThis.fetch = async () => new Response('{"ok":true,"data":{"status":"empty"}}');
    assert.deepEqual(await new MariposaClient({ baseUrl: 'http://offline.invalid' }).surfacePrepare({}), { ok: true, result: { status: 'empty' } });
    globalThis.fetch = async () => new Response('{"ok":false,"error":{"code":"FORBIDDEN"}}', { status: 403 });
    assert.deepEqual(await new MariposaClient({ baseUrl: 'http://offline.invalid' }).surfacePrepare({}), { ok: false, code: 'FORBIDDEN', httpStatus: 403 });
  } finally { globalThis.fetch = original; }
});
