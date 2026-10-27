// 联合审计 A04/B3-D（2026-10-27）联合回归：真实 Host + HTTP 入口的一轮深听电话——
// 正式话轮完成 → DELETE 挂断（尽力 hangup-request + est 收口 + 关联 wake）→
// Siren turn-audio 拉取回复音频 → est 助手消息持久绑定（links+附件行）→
// records 反查（前端面）与观察行如实。外部边界替身：Siren HTTP、主模型 SSE、M 附属
// 同步（est 的 ArchiveSync/attachmentsClient 边界由单测+M 仓测试覆盖，此处不重复）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { request } from 'node:http';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

test('A04 联合链：通话回复音频→确切助手消息→记录反查；挂断回执不冒充媒体已停', { timeout: 20000 }, async () => {
  const root = tempRoot('a04-link-');
  writeApprovedIdentity(root);
  const originalFetch = globalThis.fetch;
  process.env.AUDIT_DS_TOKEN = 'synthetic-only';
  process.env.AUDIT_SIREN_TOKEN = 'synthetic-only';
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  const calls = { modelRequests: 0, turnAudio: 0, hangupRequests: 0, replyFetches: 0 };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { url?: string })?.url ?? input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === 'http://127.0.0.1:47901/v1/calls' && method === 'POST') {
      return Response.json({ call_id: 'a04-call', ws_url: 'ws://127.0.0.1:9/ws/a04', token: 'synthetic-call' });
    }
    if (url === 'http://127.0.0.1:47901/v1/voice-assets/audit_audio/audio') {
      return new Response(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), { headers: { 'content-type': 'audio/webm' } });
    }
    if (url === 'http://127.0.0.1:47901/v1/voice-assets/sir-reply/audio') {
      calls.replyFetches++;
      return new Response(Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]), { headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url === 'http://127.0.0.1:47901/v1/calls/a04-call/turn-audio') {
      calls.turnAudio++;
      return Response.json({
        schema_version: 1, call_id: 'a04-call',
        turns: [{ turn_id: 'a04-turn', turn_index: 1, outcome: 'completed', user_audio: { asset_id: 'sir-user', duration_ms: 900 },
          reply_audio: { asset_id: 'sir-reply', duration_ms: 1500, completeness: 'complete' },
          sent_audio_ms: 1500, filler_audio_ms: 0, playback: { basis: 'client_drained' } }],
      });
    }
    if (url === 'http://127.0.0.1:47901/v1/calls/a04-call/hangup-request' && method === 'POST') {
      calls.hangupRequests++;
      return Response.json({ accepted: true });
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      calls.modelRequests++;
      const body = 'data: ' + JSON.stringify({ id: 'a04', choices: [{ delta: { content: '我在呢，慢慢说。' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n';
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const patch = readyRuntimePatch();
  const config = buildConfig({ ...patch,
    runtime: { ...patch.runtime as object, provider: 'deepseek' },
    deepseek: { model: 'deepseek-flash', api_key_env: 'AUDIT_DS_TOKEN', retry_max_attempts_after_initial: 0 },
    integrations: { siren: { base_url: 'http://127.0.0.1:47901', credential_ref: 'AUDIT_SIREN_TOKEN' } },
  });
  let host: Host | null = null;
  const httpJson = <T>(host: Host, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number | undefined; json: T }> =>
    new Promise((resolve, reject) => {
      const r = request(`http://127.0.0.1:${host.port}${path}`, { method, headers }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.once('end', () => resolve({ status: res.statusCode, json: (b ? JSON.parse(b) : null) as T }));
      });
      r.on('error', reject);
      if (body !== undefined) r.end(JSON.stringify(body)); else r.end();
    });

  try {
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
    await host.start();
    const owner = { authorization: 'Bearer ' + fs.readFileSync(host.auth.tokenFilePath(), 'utf8').trim() };
    const created = await httpJson<{ call_id: string }>(host, '/api/v1/calls', 'POST', { conversation_id: 'primary', analysis_mode: 'deep_listen' }, { ...owner, 'content-type': 'application/json' });
    assert.equal(created.status, 200);

    // 真实语音入口完成一轮（NDJSON 流收口）
    const streamBody = JSON.stringify({ conversation_id: 'primary', call_id: 'a04-call', turn_id: 'a04-turn', modality: 'voice_call', text: '今天有点累。', audio_ref: 'siren:audit_audio' });
    const stream = await new Promise<string>((resolve, reject) => {
      const r = request(`http://127.0.0.1:${host!.port}/v1/chat/stream`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-ingress', 'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(streamBody) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.once('end', () => resolve(b));
      });
      r.on('error', reject);
      r.end(streamBody);
    });
    assert.ok(stream.includes('"type":"done"'), `流应正常收口: ${stream.slice(0, 200)}`);
    await host.supervisor.waitIdle();
    assert.equal(calls.modelRequests, 1, '一轮=一次模型请求');

    // B3-D：挂断命令=est 收口 + 尽力 Siren 终止控制 + 关联 wake
    const ended = await httpJson<{ state: string; media_close: string }>(host, '/api/v1/calls/a04-call', 'DELETE', undefined, owner);
    assert.equal(ended.status, 200);
    assert.equal(ended.json.state, 'ended');
    assert.equal(ended.json.media_close, 'hangup_requested', '挂断经既有 Siren 终止控制（A11）');
    assert.equal(calls.hangupRequests, 1);

    // 关联 worker 收敛：links 行 + 附件行 + assistant 观察（deep_listen）
    const deadline = Date.now() + 5000;
    let link: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      link = host.db.prepare("SELECT * FROM voice_reply_links WHERE call_id='a04-call' AND turn_key='a04-turn'").get() as Record<string, unknown> | undefined;
      if (link && link['link_state'] === 'linked' && link['est_asset_id']) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(link, '回复链接已建立');
    assert.equal(link!['link_state'], 'linked');
    assert.equal(link!['siren_asset_id'], 'sir-reply');
    assert.ok(link!['est_asset_id'], '回复字节导入 est 媒体（幂等操作键）');
    assert.equal(link!['completeness'], 'complete');
    const playback = JSON.parse(String(link!['playback_json'])) as { basis: string };
    assert.equal(playback.basis, 'client_drained', '播放事实来自 Siren 正本（不推断已播）');

    const assistant = host.db.prepare("SELECT m.id FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' AND m.turn_id=(SELECT est_turn_id FROM voice_stream_turns WHERE call_id='a04-call' AND turn_key='a04-turn')").get() as { id: string };
    assert.ok(assistant, '本轮助手消息存在');
    const att = host.db.prepare("SELECT asset_id FROM message_attachments WHERE message_id=? AND presentation='voice'").get(assistant.id) as { asset_id: string };
    assert.equal(att.asset_id, link!['est_asset_id'], '回复音频精确绑定该助手消息');
    // oído 未接入（本测试不配 oído）：deep_listen 观察如实不登记——没有分析能力的假登记才是伪造
    const obsCount = (host.db.prepare("SELECT COUNT(*) n FROM voice_observations WHERE message_id=?").get(assistant.id) as { n: number }).n;
    assert.equal(obsCount, 0, 'oído 未接入不登记观察（如 absence，不伪造分析）');

    // 前端 records 反查：助手侧音频来自绑定（est 引用），带播放事实
    const records = await httpJson<{ records: Array<{ call_id: string; turns: Array<{ turn_id: string; audio: Record<string, unknown>; playback: Record<string, unknown> }> }> }>(host, '/api/v1/calls/records', 'GET', undefined, owner);
    assert.equal(records.status, 200);
    const rec = records.json.records.find((r) => r.call_id === 'a04-call');
    assert.ok(rec, 'records 含本通话');
    const turnRec = rec!.turns.find((t) => t.turn_id === 'a04-turn');
    assert.ok(turnRec);
    const replyAudio = turnRec!.audio['reply'] as { asset_ref?: string } | undefined;
    assert.ok(replyAudio, 'records 展示回复音频');
    assert.ok(String(replyAudio!['asset_ref']).startsWith('est:') || String(replyAudio!['asset_ref']).startsWith('siren:'), '稳定资产引用');
    // 历史读取不重复合成：整个流程只有 1 次模型请求、回复字节只取 1 次
    assert.equal(calls.modelRequests, 1);
    assert.equal(calls.replyFetches, 1, '回复字节幂等导入（不重取）');
    console.log(JSON.stringify({ case: 'a04_joint_link_flow', linked: true, media_close: ended.json.media_close }));
  } finally {
    if (host) await host.stop();
    globalThis.fetch = originalFetch;
    for (const key of ['AUDIT_DS_TOKEN', 'AUDIT_SIREN_TOKEN', 'ESTOMAGO_VOICE_INGRESS_TOKEN']) delete process.env[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
