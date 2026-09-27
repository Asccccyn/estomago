// 合成 SDK 流夹具（packages/test-fixtures）：只在测试/ESTOMAGO_TEST_MODE 下使用，
// 驱动宿主流水线验证；内容为虚构文本，不是真实聊天/身份正文，不进正式库。
import type { RawStreamEvent } from '../../contracts/src/sdk-events.ts';

export type ScenarioName = 'consistent' | 'conflict' | 'redacted' | 'route' | 'slow' | 'no_thinking';

const THINKING_A = '（合成夹具）她在整理今天的时间线，准备先回应早上的话题。';
const THINKING_B = '（合成夹具）确认没有待办被遗漏，然后收尾。';
const THINKING_FULL = THINKING_A + THINKING_B;

const TEXT_PART1 = '这是第一段合成回复。\n\n';
const TEXT_PART2 = '这是第二段合成回复，包含第二行\n换行仍在同一条消息里。';

export function fixtureScenario(name: ScenarioName, _prompt: string): RawStreamEvent[] {
  switch (name) {
    case 'consistent':
      return [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_1', model: 'fixture-model' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_A } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'FIXTURE_SIGNATURE_MUST_NOT_LEAK' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_B } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TEXT_PART1 } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TEXT_PART2 } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        { type: 'stream_event', event: { type: 'message_stop' } },
        {
          type: 'assistant',
          message: { id: 'msg_fixture_1', content: [{ type: 'thinking', thinking: THINKING_FULL }, { type: 'text', text: TEXT_PART1 + TEXT_PART2 }] },
        },
        { type: 'result', subtype: 'success', usage: { input_tokens: 120, output_tokens: 48 } },
      ];
    case 'conflict':
      return [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_c' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '接收到的片段与完整块不一致' } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '冲突场景正文' } } },
        { type: 'stream_event', event: { type: 'message_stop' } },
        {
          type: 'assistant',
          message: { id: 'msg_fixture_c', content: [{ type: 'thinking', thinking: '完整块给出的是另一份文本，不是前缀' }] },
        },
        { type: 'result', subtype: 'success', usage: { input_tokens: 90 } },
      ];
    case 'redacted':
      return [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_r' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '删隐场景正文' } } },
        { type: 'result', subtype: 'success', usage: { input_tokens: 70 } },
      ];
    case 'no_thinking':
      return [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_n' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '无思考场景正文' } } },
        { type: 'result', subtype: 'success', usage: { input_tokens: 50 } },
      ];
    case 'route':
      return [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_route' } } },
        { type: 'error', error: 'route_signal: model_switch_requested candidate=fixture-other-model' },
      ];
    case 'slow': {
      const events: RawStreamEvent[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fixture_slow' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      ];
      for (let i = 0; i < 400; i++) {
        events.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `慢流片段${i}；` } } });
      }
      events.push({ type: 'result', subtype: 'success', usage: { input_tokens: 10 } });
      return events;
    }
    default:
      throw new Error(`未知夹具场景: ${name}`);
  }
}

export const FIXTURE_TEXTS = { THINKING_FULL, TEXT_PART1, TEXT_PART2 };
