// composer 纯逻辑（浏览器与测试共用）——输入规则的单一事实源：
//  2026-10-19 她裁定（替代 10-17 规则）：聊天框和原位编辑框统一——
//  1. Enter / Shift+Enter 换行；按钮或 Cmd/Ctrl+Enter 发送一条消息
//  2. IME 合成期间（composing=true / keyCode 229）不发送（候选确认不能变成发送）
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

// 两种输入框统一：裸 Enter 保留 textarea 默认换行，Cmd/Ctrl+Enter 才提交。
// Shift/Alt 修饰键、按住不放的重复事件、IME 候选确认均不触发提交。
export function shouldSendOnKeydown(event) {
  if (!event || event.key !== "Enter") return false;
  if ((!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey || event.repeat) return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  if (event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return false;
  return true;
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

// EXEC_V1 §05.9（TOKEN-04）：预估回包应用守卫——只应用同时匹配
// draft_revision、model_snapshot 与附件指纹的响应；过期慢回包一律丢弃。
// 估计失败/丢弃绝不阻塞正常发送（发送走服务端容量与身份硬门）。
export function shouldApplyEstimate(response, current) {
  if (!response || typeof response !== 'object') return false;
  if (!current || typeof current !== 'object') return false;
  if (response.client_draft_revision !== current.draftRevision) return false;
  if (response.model_snapshot_id !== current.modelSnapshotId) return false;
  const respFp = response.attachment_fingerprint ?? null;
  const curFp = current.attachmentFingerprint ?? null;
  if (respFp !== curFp) return false;
  return true;
}
