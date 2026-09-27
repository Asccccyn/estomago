// 合成 SDK 流夹具（仅测试/ESTOMAGO_TEST_MODE；按 0.3.283 真实消息形状构造）。
// 场景覆盖 normalizer 全部边界：initial-text、多块、同 id 多个单块完整包、
// 冲突、redacted、omitted、无 result、route 迟到块、子代理、no-thinking、慢流。
import type { RawStreamEvent } from '../../contracts/src/sdk-events.ts';

export type ScenarioName =
  | 'consistent'
  | 'conflict'
  | 'redacted'
  | 'route'
  | 'slow'
  | 'no_thinking'
  | 'initial_text'
  | 'multi_complete'
  | 'subagent'
  | 'no_result'
  | 'omitted';

const THINKING_A = '（合成夹具）她在整理今天的时间线，准备先回应早上的话题。';
const THINKING_B = '（合成夹具）确认没有待办被遗漏，然后收尾。';
const THINKING_FULL = THINKING_A + THINKING_B;

const TEXT_PART1 = '这是第一段合成回复。\n\n';
const TEXT_PART2 = '这是第二段合成回复，包含第二行\n换行仍在同一条消息里。';

function se(event: RawStreamEvent['event'], session = 'sess_fixture_1'): RawStreamEvent {
  return { type: 'stream_event', event, session_id: session, parent_tool_use_id: null };
}
function assistant(id: string, blocks: NonNullable<import('../../contracts/src/sdk-events.ts').RawAssistantMessage['content']>, session = 'sess_fixture_1', parent: string | null = null, request_id: string | null = null): RawStreamEvent {
  return { type: 'assistant', message: { id, content: blocks }, session_id: session, parent_tool_use_id: parent, request_id };
}

export function fixtureScenario(name: ScenarioName, _prompt: string): RawStreamEvent[] {
  switch (name) {
    case 'consistent':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_1', model: 'fixture-model' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_A } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'FIXTURE_SIGNATURE_MUST_NOT_LEAK' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_B } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TEXT_PART1 } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TEXT_PART2 } }),
        se({ type: 'content_block_stop', index: 1 }),
        se({ type: 'message_stop' }),
        assistant('msg_fixture_1', [
          { type: 'thinking', thinking: THINKING_FULL },
          { type: 'text', text: TEXT_PART1 + TEXT_PART2 },
        ]),
        { type: 'result', subtype: 'success', usage: { input_tokens: 120, output_tokens: 48 }, session_id: 'sess_fixture_1' },
      ];
    case 'conflict':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_c' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '接收到的片段与完整块不一致' } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '冲突场景正文' } }),
        se({ type: 'message_stop' }),
        assistant('msg_fixture_c', [{ type: 'thinking', thinking: '完整块给出的是另一份文本，不是前缀' }]),
        { type: 'result', subtype: 'success', usage: { input_tokens: 90 }, session_id: 'sess_fixture_c' },
      ];
    case 'redacted':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_r' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '删隐场景正文' } }),
        { type: 'result', subtype: 'success', usage: { input_tokens: 70 }, session_id: 'sess_fixture_r' },
      ];
    case 'no_thinking':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_n' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '无思考场景正文' } }),
        { type: 'result', subtype: 'success', usage: { input_tokens: 50 }, session_id: 'sess_fixture_n' },
      ];
    case 'initial_text':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_init' } }),
        // content_block_start 自带初始正文（真实 API 允许）
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '起始自带正文' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '·后续增量' } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '正文起始自带' } }),
        se({ type: 'content_block_stop', index: 1 }),
        { type: 'result', subtype: 'success', usage: { input_tokens: 60 }, session_id: 'sess_fixture_init' },
      ];
    case 'multi_complete':
      // 真实形状：同一 message id 的多个单块完整包 + 一个多余未匹配包 + block index 非 0
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_m' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'FIRST-RECEIVED' } }),
        se({ type: 'content_block_start', index: 2, content_block: { type: 'thinking' } }),
        se({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'THIRD-RECEIVED' } }),
        assistant('msg_fixture_m', [{ type: 'thinking', thinking: 'FIRST-RECEIVED' }]),
        assistant('msg_fixture_m', [{ type: 'thinking', thinking: 'THIRD-RECEIVED' }]),
        // 多余的第三个完整包：无开放块可匹配 → unmatched，绝不覆盖 block0
        assistant('msg_fixture_m', [{ type: 'thinking', thinking: 'EXTRA-UNMATCHED' }]),
        { type: 'result', subtype: 'success', usage: { input_tokens: 80 }, session_id: 'sess_fixture_m' },
      ];
    case 'subagent':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_main' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '主会话正文' } }),
        se({ type: 'content_block_stop', index: 0 }),
        // 子代理输出（forwardSubagentText 开启时的真实形状）
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg_child' } },
          session_id: 'sess_fixture_child',
          parent_tool_use_id: 'toolu_child_1',
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          session_id: 'sess_fixture_child',
          parent_tool_use_id: 'toolu_child_1',
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'CHILD-AGENT-THINKING' } },
          session_id: 'sess_fixture_child',
          parent_tool_use_id: 'toolu_child_1',
        },
        assistant('msg_child', [{ type: 'thinking', thinking: 'CHILD-AGENT-THINKING' }], 'sess_fixture_child', 'toolu_child_1'),
        { type: 'result', subtype: 'success', usage: { input_tokens: 40 }, session_id: 'sess_fixture_main' },
      ];
    case 'omitted':
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_o' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }), // 空 thinking
        se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'FIXTURE_SIG' } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '空思考场景正文' } }),
        { type: 'result', subtype: 'success', usage: { input_tokens: 55 }, session_id: 'sess_fixture_o' },
      ];
    case 'route': {
      // 路由信号：错误 result 之后仍有一段迟到正文/思考（验证 fence 必须丢弃）
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_route' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '路由前思考' } }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '路由信号前正文' } }),
        { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess_fixture_route', error: 'route_signal: model_switch_requested candidate=fixture-other-model' },
        // 迟到增量：宿主 fence 必须丢弃
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'AFTER-ROUTE-SIGNAL 迟到气泡' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '迟到思考' } }),
      ];
    }
    case 'no_result':
      // 流结束但没有 result（断流/进程被杀）
      return [
        se({ type: 'message_start', message: { id: 'msg_fixture_nr' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '没有最终结果的正文' } }),
        se({ type: 'message_stop' }),
      ];
    case 'slow': {
      const events: RawStreamEvent[] = [
        se({ type: 'message_start', message: { id: 'msg_fixture_slow' } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      ];
      for (let i = 0; i < 400; i++) {
        events.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `慢流片段${i}；` } }));
      }
      events.push({ type: 'result', subtype: 'success', usage: { input_tokens: 10 }, session_id: 'sess_fixture_slow' });
      return events;
    }
    default:
      throw new Error(`未知夹具场景: ${name}`);
  }
}

export const FIXTURE_TEXTS = { THINKING_A, THINKING_B, THINKING_FULL, TEXT_PART1, TEXT_PART2 };
