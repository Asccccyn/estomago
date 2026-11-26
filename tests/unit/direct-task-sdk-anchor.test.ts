import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSdkHostQuery, type SdkQueryFactory, type SdkSessionAnchor } from '../../apps/host/src/runtime/sdk-host-query.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import type { SdkRunRequest } from '../../apps/host/src/runtime/runner.ts';

type Request = SdkRunRequest & { host: NonNullable<SdkRunRequest['host']> };

test('SDK：带专属工具的任务独立重放，主聊天和心跳继续使用原会话锚', async () => {
  const sessions = new Map<string, SdkSessionAnchor>();
  const resumes: Array<string | undefined> = [];
  const originalTools = [{ type: 'function', function: { name: 'memory_hold', description: '合成工具', parameters: { type: 'object' } } }];
  const taskTools = [...originalTools, { type: 'function', function: { name: 'background_complete', description: '合成任务工具', parameters: { type: 'object' } } }];
  const run = (session: string, messages: OrMessage[], task = false, outcome: 'success' | 'error_during_execution' = 'success') => {
    const fake: SdkQueryFactory = ({ prompt, options }) => {
      resumes.push(options?.resume);
      assert.notEqual(typeof prompt, 'string');
      const input = (prompt as Exclude<typeof prompt, string>)[Symbol.asyncIterator]();
      const messagesOut = (async function* () {
        try {
          for (;;) {
            const next = await input.next();
            assert.equal(next.done, false);
            const frame = next.value as { type: string; shouldQuery?: boolean };
            if (frame.type === 'assistant') continue;
            if (frame.shouldQuery !== false) break;
            yield { type: 'result', subtype: 'success', session_id: session } as never;
          }
          if (outcome === 'success') {
            yield { type: 'assistant', session_id: session, message: { id: 'reply-' + session, content: [{ type: 'text', text: '合成返回' }] } } as never;
          }
          yield { type: 'result', subtype: outcome, is_error: outcome !== 'success', session_id: session } as never;
        } finally { await input.return?.(); }
      })();
      return Object.assign(messagesOut, { close() {} }) as ReturnType<SdkQueryFactory>;
    };
    const request = {
      prompt: '', options: { options: { systemPrompt: 'S', env: {} } }, resumeSessionId: null,
      abortController: new AbortController(), onEvent: () => {},
      host: {
        windowId: 'native-scope', purpose: task ? 'proactive_turn' : 'chat',
        isolatedSession: task,
        envelope: { model: 'claude-test-1', tools: task ? taskTools : originalTools, maxTokens: 64, messages },
        beforeModel: async () => {}, executeTool: async () => ({ ok: true, output: {} }),
      },
    } as Request;
    return runSdkHostQuery(fake, request, sessions, async () => null, (() => ({ pid: 1 })) as never);
  };

  const first = await run('main-session', [{ role: 'system', content: 'S' }, { role: 'user', content: '合成输入' }]);
  assert.equal(first.outcome, 'completed');
  const anchor = sessions.get('native-scope');
  assert.equal(anchor?.sessionId, 'main-session');
  const taskMessages = [...first.finalMessages!, { role: 'user', content: '合成任务输入' }];
  const task = await run('task-session', taskMessages, true);
  assert.equal(task.outcome, 'completed');
  assert.equal(task.resumeDiagnosis?.decision, 'isolated');
  assert.equal(sessions.get('native-scope'), anchor);
  const failedTask = await run('task-failed', taskMessages, true, 'error_during_execution');
  assert.equal(failedTask.outcome, 'error');
  assert.equal(sessions.get('native-scope'), anchor);
  const after = await run('main-session', [...task.finalMessages!, { role: 'user', content: '下一条合成输入' }]);
  assert.equal(after.outcome, 'completed');
  assert.equal(after.resumeDiagnosis?.decision, 'resume_hit');
  assert.deepEqual(resumes, [undefined, undefined, undefined, 'main-session']);
});
