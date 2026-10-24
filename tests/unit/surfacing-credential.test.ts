// 浮现授权链（她 2026-10-24 裁定·实机验收⑥"授权确实生效"的最小行为证据）：
// surfacing 走专用受限凭据（surfacing_credential_ref），经真实 HTTP 表面
// （/api/capability/X，defaultTransport 路径——注入 transport 的离线桩不经此处）
// 发出的 Authorization 必须来自专用 env，不回退聊天/归档凭据；凭据缺失时
// 不伪造 Authorization。生产装配见 app-context：surfaceMariposaClient 的
// credentialEnv=memory_surfacing.surfacing_credential_ref。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

test('surface 专用凭据经真实 HTTP 面：Authorization=专用 token，不回退聊天凭据；缺失不伪造', async () => {
  const seen: Array<{ authorization: string | undefined; capability: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, capability: req.url ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { memory_id: '00001' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    process.env.ESTOMAGO_SURFACE_TEST_TOKEN = 'surface-restricted-secret';
    process.env.ESTOMAGO_CHAT_TEST_TOKEN = 'chat-main-secret';
    const surfaceClient = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_SURFACE_TEST_TOKEN' });
    const r1 = await surfaceClient.memoryGet('00001');
    assert.equal(r1.ok, true);
    assert.equal(seen[0]!.authorization, 'Bearer surface-restricted-secret', '浮现请求带专用凭据');
    assert.ok(seen[0]!.capability.includes('memory.get'), '走真实 /api/capability 面');
    // 隔离对照：聊天凭据客户端同面调用带的是聊天 token（证明 env 来源决定凭据，不串）
    const chatClient = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_CHAT_TEST_TOKEN' });
    await chatClient.memoryGet('00001');
    assert.equal(seen[1]!.authorization, 'Bearer chat-main-secret');
    // 凭据缺失（credentialEnv 指向未设 env）：不伪造 Authorization、不回退其他凭据
    const noSecretClient = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_SURFACE_MISSING_TOKEN' });
    await noSecretClient.memoryGet('00001');
    assert.equal(seen[2]!.authorization, undefined, '凭据缺失=无 Authorization，不回退不伪造');
  } finally {
    delete process.env.ESTOMAGO_SURFACE_TEST_TOKEN;
    delete process.env.ESTOMAGO_CHAT_TEST_TOKEN;
    server.close();
  }
});
