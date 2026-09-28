// composer 纯逻辑（浏览器与测试共用）—— v0.2.1 输入硬规则的单一事实源：
//  1. Enter 只换行（textarea 默认行为），发送只由独立发送键触发；无任何组合键发送捷径
//  2. IME 合成期间（composing=true）不发送（候选确认不能变成发送/多插一行）
//  3. 仅空白且无附件 → 不可发送；判定不修改正文（不 trim 重写）
//  4. 一次点击生成一个 client_message_id；重试复用同一 ID（服务端幂等兜底）
//  5. 多行正文是一条消息；换行属于正文结构，绝不拆分
export function canSend(text, opts = { hasAttachment: false, composing: false }) {
  if (opts.composing) return false;
  if (opts.hasAttachment) return true;
  return !isBlankContent(text);
}

export function isBlankContent(content) {
  return /^[\s\u00A0\uFEFF\u3000]*$/.test(content);
}

// 发送载荷：冻结当前 draft；只规范化换行为 LF（保留行序/空行），其余字符原样
export function buildOutgoingDraft(text, clientMessageId) {
  return {
    content: normalizeNewlines(text),
    client_message_id: clientMessageId,
    kind: 'text',
  };
}

export function normalizeNewlines(content) {
  return content.replace(/\r\n?/g, '\n');
}

// 生成幂等键；重试（网络失败/离线重发）必须复用传入的 pendingId
export function newClientMessageId(cryptoObj = globalThis.crypto) {
  return cryptoObj.randomUUID();
}

// 任何按键都不触发发送（含 Cmd/Ctrl/Shift+Enter）——首版无快捷键
export function shouldSendOnKeydown() {
  return false;
}

// §19（AUD-17）：DraftRevisionGuard —— 普通发送与 route edit 共用同一规则：
// 回执到达时，只有草稿修订仍等于提交时修订才允许清空；否则不得触碰用户当前草稿。
export function makeDraftGuard() {
  let revision = 0;
  return {
    touch() { revision += 1; return revision; },
    current() { return revision; },
    freeze() { return revision; },
    mayClear(submittedRevision) { return revision === submittedRevision; },
  };
}
