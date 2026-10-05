// WP1 回归：SSE 帧解析与单请求聚合（移植自参考实现场景，合成数据；不发请求不执行工具）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrStreamAccumulator, SseFramer } from '../../apps/host/src/runtime/or-sse.ts';
import { ContractError } from '../../apps/host/src/runtime/or-contract.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

test('SSE：UTF-8 多字节跨网络块重组；注释心跳跳过；多行 data 合并', () => {
  const acc = new OrStreamAccumulator();
  const full = sse({ id: 'gen-1', choices: [{ delta: { content: '晚安，user🌙' } }] }) + `: keep-alive\n\n` + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  const bytes = enc.encode(full);
  // 逐字节喂入——最细粒度跨块
  for (const b of bytes) acc.feed(new Uint8Array([b]));
  const f = acc.finish();
  assert.equal(f.status, 'completed');
  assert.equal(f.text, '晚安，user🌙');
  assert.equal(f.id, 'gen-1');
  // 多行 data：同一事件内两行 data 按 SSE 规范以 \n 合并为一个载荷（token 间空白合法 JSON）
  const seen: string[] = [];
  const fr = new SseFramer((d) => seen.push(d));
  fr.feed(enc.encode('data: {"a":\ndata: 1}\n\n'));
  fr.end();
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]!), { a: 1 });
});

test('聚合：文本 + 分片工具参数 + usage 终态帧', () => {
  const acc = new OrStreamAccumulator();
  acc.feed(enc.encode(sse({ id: 'gen-2', choices: [{ delta: { content: '好的' } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'mariposa', arguments: '{"a":' } }] } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));
  acc.feed(enc.encode(sse({ id: 'gen-2', usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 }, cost: 0.002 }, choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));
  acc.feed(enc.encode('data: [DONE]\n\n'));
  const f = acc.finish();
  assert.equal(f.status, 'completed');
  assert.equal(f.terminalEvents, 1, '重复 finish_reason 是记账帧不是第二次结束');
  assert.equal(f.text, '好的');
  assert.equal(f.toolCalls.length, 1);
  assert.equal(f.toolCalls[0]!.name, 'mariposa');
  assert.deepEqual(f.toolCalls[0]!.parsedArguments, { a: 1 });
  assert.equal(f.usage.completeness, 'complete');
  assert.equal(f.usage.cacheRead, 6);
});

test('聚合：reasoning opaque 片段按序保留，不进可见正文', () => {
  const acc = new OrStreamAccumulator();
  acc.feed(enc.encode(sse({ id: 'g', choices: [{ delta: { reasoning_details: [{ type: 'thinking', thinking: 'opaque-1' }] } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: { content: '正文' } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: { reasoning_details: [{ type: 'thinking', thinking: 'opaque-2' }] } }] })));
  acc.feed(enc.encode(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
  acc.feed(enc.encode('data: [DONE]\n\n'));
  const f = acc.finish();
  assert.equal(f.text, '正文');
  assert.equal(f.reasoningFrames.length, 2);
  assert.deepEqual(f.reasoningFrames, [[{ type: 'thinking', thinking: 'opaque-1' }], [{ type: 'thinking', thinking: 'opaque-2' }]]);
});

test('拒绝面：非法 JSON / 200 内 error / 重复 DONE / DONE 后数据 / generation id 变更 / 终态后内容', () => {
  const run = (frames: string): unknown => {
    const acc = new OrStreamAccumulator();
    try {
      acc.feed(enc.encode(frames)); // feed 阶段即可抛（非法 JSON/200 内 error 在到达时即协议错误）
    } catch (e) {
      return e;
    }
    try {
      return acc.finish();
    } catch (e) {
      return e;
    }
  };
  assert.ok(run('data: {not json}\n\n') instanceof ContractError);
  assert.ok(run(sse({ error: { message: 'x' } })) instanceof ContractError);
  assert.ok(run('data: [DONE]\n\ndata: [DONE]\n\n') instanceof ContractError);
  assert.ok(run(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' + sse({ choices: [{ delta: { content: 'late' } }] })) instanceof ContractError);
  assert.ok(run(sse({ id: 'a', choices: [{ delta: { content: 'x' } }] }) + sse({ id: 'b', choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n') instanceof ContractError);
  assert.ok(run(sse({ choices: [{ delta: { content: 'x' } }, { delta: {}, finish_reason: 'stop' }] }) + sse({ choices: [{ delta: { content: 'after' } }] }) + 'data: [DONE]\n\n') instanceof ContractError);
});

test('拒绝面：工具参数门（截断/非法 JSON/array/缺 id/重复 id/finish 不匹配）', () => {
  const toolStream = (args: string, finish: string, extra: string = '') => {
    const acc = new OrStreamAccumulator();
    acc.feed(enc.encode(sse({ id: 'g', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'n', arguments: args } }] } }] })));
    acc.feed(enc.encode(sse({ choices: [{ delta: {}, finish_reason: finish }] })));
    acc.feed(enc.encode('data: [DONE]\n\n' + extra));
    return acc.finish();
  };
  assert.throws(() => toolStream('{"a":', 'tool_calls'), /TOOL_JSON_INVALID/);
  assert.throws(() => toolStream('[1,2]', 'tool_calls'), /TOOL_JSON_NOT_OBJECT/);
  assert.throws(() => toolStream('{}', 'stop'), /TOOL_FINISH_MISMATCH/);
  const missingId = new OrStreamAccumulator();
  missingId.feed(enc.encode(sse({ id: 'g', choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'n', arguments: '{}' } }] } }] })));
  missingId.feed(enc.encode(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));
  missingId.feed(enc.encode('data: [DONE]\n\n'));
  assert.throws(() => missingId.finish(), /INCOMPLETE_TOOL_CALL/);
  const dupId = new OrStreamAccumulator();
  dupId.feed(enc.encode(sse({ id: 'g', choices: [{ delta: { tool_calls: [{ index: 0, id: 'same', type: 'function', function: { name: 'n', arguments: '{}' } }, { index: 1, id: 'same', type: 'function', function: { name: 'm', arguments: '{}' } }] } }] })));
  dupId.feed(enc.encode(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));
  dupId.feed(enc.encode('data: [DONE]\n\n'));
  assert.throws(() => dupId.finish(), /DUPLICATE_TOOL_ID/);
});

test('拒绝面：单事件超界有界失败；缺终态/缺 DONE 不冒充完成', () => {
  const big = new SseFramer(() => {}, { maxEventBytes: 64 });
  assert.throws(() => big.feed(enc.encode(`data: ${'x'.repeat(200)}\n\n`)), /SSE_EVENT_TOO_LARGE/);
  const noDone = new OrStreamAccumulator();
  noDone.feed(enc.encode(sse({ id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] })));
  assert.throws(() => noDone.finish(), /MISSING_FINAL_RESULT/);
  const truncated = new OrStreamAccumulator();
  truncated.feed(enc.encode('data: {"partial": '));
  assert.throws(() => truncated.finish(), /SSE_TRUNCATED_FRAME/);
});
