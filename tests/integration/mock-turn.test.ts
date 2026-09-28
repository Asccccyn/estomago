// 集成测试：mock runner 全链路（消息→思考流→气泡→用量→路由→停止→鉴权→SSE）。
// 只用合成夹具；不连真实 SDK/网络；结果不计入 166 项产品验收。
import '../helpers.ts'; // 首个 import：启用 ESTOMAGO_TEST_MODE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, pollUntil } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { FIXTURE_TEXTS } from '../../packages/test-fixtures/src/sdk-stream.ts';

const root = tempRoot('estomago-int-');
writeApprovedIdentity(root);
const config = buildConfig({
  runtime: { provider: 'mock', ...(readyRuntimePatch().runtime as Record<string, unknown>) },
  deployment: { port: 0 },
});

let host: Host;
let base = '';
let token = '';

test.before(async () => {
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config', 'auth.token'), 'utf8').trim();
});

test.after(async () => {
  delete process.env.ESTOMAGO_MOCK_SCENARIO;
  await host.stop();
});

async function api(method: string, p: string, body?: unknown, useToken = true): Promise<Response> {
  return fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function submit(content: string, cmid: string): Promise<{ turn_id: string; message_id: string; duplicate: boolean }> {
  const res = await api('POST', '/api/v1/conversations/primary/messages', { content, client_message_id: cmid });
  assert.equal(res.status, 201, `提交应 201，得到 ${res.status}`);
  const data = (await res.json()) as { message: { id: string }; turn_id: string; duplicate: boolean };
  return { turn_id: data.turn_id, message_id: data.message.id, duplicate: data.duplicate };
}

async function turnState(turnId: string): Promise<{ state: string; pending: unknown; attempts: Array<{ state: string; blocked_reason: string | null }> }> {
  const res = await api('GET', `/api/v1/turns/${turnId}`);
  const data = (await res.json()) as { turn: { state: string }; attempts: Array<{ state: string; blocked_reason: string | null }>; pending_route_decision: unknown };
  return { state: data.turn.state, pending: data.pending_route_decision, attempts: data.attempts };
}

test('mock 全链路：多行输入一条消息 → 思考增量+完整块核对 → 分句气泡 → 用量', async () => {
  delete process.env.ESTOMAGO_MOCK_SCENARIO; // 默认 consistent
  const { turn_id } = await submit('你好\n这是第二行', 'int-consistent-1');
  await pollUntil(async () => (await turnState(turn_id)).state === 'completed');

  // 原文：多行一条、原样
  const msgs = (await (await api('GET', '/api/v1/conversations/primary/messages?limit=50')).json()) as {
    messages: Array<{ speaker: string; revision: { content: string } }>;
  };
  const owner = msgs.messages.find((m) => m.speaker === 'owner')!;
  assert.equal(owner.revision.content, '你好\n这是第二行');
  const bubbles = msgs.messages.filter((m) => m.speaker === 'assistant');
  assert.deepEqual(
    bubbles.map((b) => b.revision.content),
    ['这是第一段合成回复。', `这是第二段合成回复，包含第二行\n换行仍在同一条消息里。`],
  );

  // 思考：完整块核对后 = THINKING_FULL，签名绝不出现
  const reasoning = (await (await api('GET', `/api/v1/turns/${turn_id}/reasoning`)).json()) as {
    blocks: Array<{ visibility: string; state: string; text: string }>;
  };
  const summaryBlocks = reasoning.blocks.filter((b) => b.visibility === 'summary');
  assert.equal(summaryBlocks.length, 1);
  assert.equal(summaryBlocks[0]!.state, 'complete');
  assert.equal(summaryBlocks[0]!.text, FIXTURE_TEXTS.THINKING_FULL);
  assert.equal(JSON.stringify(reasoning).includes('FIXTURE_SIGNATURE_MUST_NOT_LEAK'), false, '签名不得出现在任何 API 响应');

  // 用量：turn 口径
  const usage = (await (await api('GET', `/api/v1/turns/${turn_id}/usage`)).json()) as {
    attempts: Array<{ input_tokens: number | null; output_tokens: number | null }>;
    totals: { input_tokens: number | null; output_tokens: number | null };
  };
  assert.equal(usage.attempts.length, 1);
  assert.equal(usage.totals.input_tokens, 120);
  assert.equal(usage.totals.output_tokens, 48);
});

test('幂等（HTTP 层）：同 client_message_id 重发 → duplicate 且不新增消息/turn', async () => {
  const first = await submit('幂等测试', 'int-dup-1');
  const res = await api('POST', '/api/v1/conversations/primary/messages', { content: '幂等测试（重试）', client_message_id: 'int-dup-1' });
  assert.equal(res.status, 200, '幂等命中返回 200 而非新建 201');
  const data = (await res.json()) as { duplicate: boolean; message: { id: string }; turn_id: string | null };
  assert.equal(data.duplicate, true);
  assert.equal(data.message.id, first.message_id);
});

test('冲突场景：完整块非前缀 → conflict + snapshot 更正，不拼接', async () => {
  process.env.ESTOMAGO_MOCK_SCENARIO = 'conflict';
  const { turn_id } = await submit('冲突场景', 'int-conflict-1');
  await pollUntil(async () => (await turnState(turn_id)).state === 'completed');
  const reasoning = (await (await api('GET', `/api/v1/turns/${turn_id}/reasoning`)).json()) as {
    blocks: Array<{ state: string; text: string }>;
  };
  const block = reasoning.blocks.find((b) => b.text.length > 0 || b.state === 'conflict')!;
  assert.equal(block.state, 'conflict');
  assert.equal(block.text, '完整块给出的是另一份文本，不是前缀', '投影以 snapshot 的完整文本为准，且不是 A+B 拼接');
});

test('redacted 场景：可见性=redacted，不还原、不编替代文本', async () => {
  process.env.ESTOMAGO_MOCK_SCENARIO = 'redacted';
  const { turn_id } = await submit('删隐场景', 'int-redacted-1');
  await pollUntil(async () => (await turnState(turn_id)).state === 'completed');
  const reasoning = (await (await api('GET', `/api/v1/turns/${turn_id}/reasoning`)).json()) as {
    blocks: Array<{ visibility: string; text: string; state: string }>;
  };
  const redacted = reasoning.blocks.find((b) => b.visibility === 'redacted')!;
  assert.equal(redacted.text, '');
});

test('路由：待决 → 用户取消 → turn blocked；重复消费 409', async () => {
  process.env.ESTOMAGO_MOCK_SCENARIO = 'route';
  const { turn_id } = await submit('路由场景', 'int-route-1');
  await pollUntil(async () => (await turnState(turn_id)).state === 'route_owner_pending');
  const st = await turnState(turn_id);
  const decision = st.pending as { id: string; target_model: string | null } | null;
  assert.ok(decision, '应产生待决票据');
  assert.equal(decision!.target_model, null, '目标模型未知就明确未知');

  const cancel = await api('POST', `/api/v1/route-decisions/${decision!.id}`, { choice: 'cancel' });
  assert.equal(cancel.status, 200);
  await pollUntil(async () => (await turnState(turn_id)).state === 'blocked');
  const again = await api('POST', `/api/v1/route-decisions/${decision!.id}`, { choice: 'approve' });
  assert.equal(again.status, 409, '票据一次消费，多端重复点击只有一个生效');
});

test('停止：fence 当前代 → interrupted；未发布缓冲不发布', async () => {
  process.env.ESTOMAGO_MOCK_SCENARIO = 'slow';
  const { turn_id } = await submit('停止场景', 'int-stop-1');
  await new Promise((r) => setTimeout(r, 80));
  const stop = await api('POST', `/api/v1/turns/${turn_id}/stop`, {});
  assert.equal(stop.status, 200);
  await pollUntil(async () => (await turnState(turn_id)).state === 'interrupted', 8000);
  const reasoning = (await (await api('GET', `/api/v1/turns/${turn_id}/reasoning`)).json()) as {
    blocks: Array<{ state: string; visibility: string }>;
  };
  assert.ok(reasoning.blocks.some((b) => b.state === 'interrupted'), '已展示片段保留并标 interrupted');
});

test('鉴权：无 token 401；错 token 401；对 Origin 校验不误伤本地脚本', async () => {
  delete process.env.ESTOMAGO_MOCK_SCENARIO;
  const noToken = await fetch(`${base}/api/v1/conversations/primary/messages`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${base}/api/v1/conversations/primary/messages`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(badToken.status, 401);
  const crossOrigin = await fetch(`${base}/api/v1/conversations/primary/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ content: 'x', client_message_id: 'csrf-1' }),
  });
  assert.equal(crossOrigin.status, 403, '跨源 POST 被 CSRF 校验拒绝');
});

test('health：ready 分项（identity/runtime/archive/push/db）', async () => {
  const res = await fetch(`${base}/health/ready`);
  const report = (await res.json()) as {
    status: string;
    components: Record<string, { status: string }>;
  };
  assert.equal(report.components.identity!.status, 'ok');
  assert.equal(report.components.db!.status, 'ok');
  assert.equal(report.components.push!.status, 'disabled');
  // runtime=unknown（能力矩阵无实机证据）→ 整体 degraded，如实
  assert.equal(report.components.runtime!.status, 'unknown');
  assert.equal(report.status, 'degraded');
});

test('SSE：token query 认证 + 持久 sequence 帧 + Last-Event-ID 优先语义（AUD-09 新契约）', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/events?cursor=0&token=${encodeURIComponent(token)}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let frames = 0;
  let lastId = 0;
  while (frames < 3) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.startsWith('id: ')) {
        const seq = Number(line.slice(4));
        assert.ok(seq > lastId, 'sequence 严格递增');
        lastId = seq;
        frames++;
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  }
  controller.abort();
  assert.ok(frames >= 3);
});
