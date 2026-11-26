// The external SDK boundary's observed stream-json replay acknowledgements.
// Host history construction, tool execution and persistence stay real in tests.
export async function* scriptedSdkInput(input: any, sessionId: string,
  current: (message: any, history: any[]) => void): AsyncGenerator<any, boolean> {
  const history: any[] = [];
  for await (const frame of input.prompt) {
    if (frame.type === 'assistant' || frame.shouldQuery === false) {
      history.push(frame);
      yield { ...frame, session_id: sessionId, ...(frame.type === 'user' ? { isReplay: true } : {}) };
      if (frame.type === 'user') yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId };
      continue;
    }
    current(frame, history);
    return true;
  }
  return false;
}
