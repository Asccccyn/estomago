// estómago 前端 v0.2.2（AUD-04/07/09/17/30/34 修复）：
//  - turn 容器创建即挂载 timeline（绝不写 detached DOM）
//  - 草稿修订守卫：回执只清空"仍等于提交时版本"的草稿
//  - reasoning.snapshot 显式处理；按 turn 维护 dirty/inflight 刷新状态机，终帧不丢
//  - 刷新/换端回看：boot 拉取 messages + 每个 turn 的 reasoning
//  - sequence 纪律：只应用 sequence > lastAppliedSequence 的事件；重连靠 Last-Event-ID
//  - 路由"重新编辑"走真修订端点：原消息 revision+1，不新建 owner 消息
import { canSend, buildOutgoingDraft, newClientMessageId, shouldSendOnKeydown, makeDraftGuard } from './composer-logic.js';

const CONVERSATION = 'primary';
const $ = (id) => document.getElementById(id);

const draftGuard = makeDraftGuard(); // §19：普通发送与 route edit 共享同一草稿守卫

const state = {
  authorized: false,
  composing: false,
  pendingClientMessageId: null,
  pendingDraft: null,
  draftRevision: 0,          // AUD-17：每次用户输入 +1；发送时冻结
  submittedDraftRevision: null,
  pendingRouteEdit: null,     // { decisionId, messageId, original }
  messages: new Map(),        // message_id -> dto
  lastSequence: 0,            // AUD-09：只应用更新的 sequence
  turns: new Map(),           // turn_id -> {element, reasoningPanel, reasoningBody, dirty, inflight, usageEl}
  routePending: null,
  reasoningLabel: '思考',
  sse: null,
};

// —— 认证 ——
async function tryResume() {
  const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=500`, { credentials: 'same-origin' });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}
$('login-btn').hidden = false;
$('login-btn').onclick = () => { $('login-panel').hidden = !$('login-panel').hidden; };
$('token-submit').onclick = async () => {
  const token = $('token-input').value.trim();
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ token }),
  });
  if (res.ok) { $('login-panel').hidden = true; $('login-error').hidden = true; boot(); }
  else { $('login-error').textContent = 'token 不正确或服务器拒绝'; $('login-error').hidden = false; }
};

// —— composer：Enter 只换行；独立发送键；IME guard；幂等键 ——
const composer = $('composer');
composer.addEventListener('compositionstart', () => { state.composing = true; refreshSendButton(); });
composer.addEventListener('compositionend', () => { state.composing = false; refreshSendButton(); });
composer.addEventListener('input', () => { state.draftRevision = draftGuard.touch(); refreshSendButton(); });
void shouldSendOnKeydown; // 无任何按键发送路径（规则单一事实源在 composer-logic.js）

function refreshSendButton() {
  const editing = Boolean(state.pendingRouteEdit);
  $('send-btn').textContent = editing ? '重新发送（修订）' : '发送';
  $('send-btn').disabled = !canSend(composer.value, { composing: state.composing });
}
$('send-btn').addEventListener('click', () => void send());

async function send() {
  if (!canSend(composer.value, { composing: state.composing })) return;
  // 路由编辑流（AUD-07）：走真修订端点，原消息 revision+1
  if (state.pendingRouteEdit) {
    const { decisionId } = state.pendingRouteEdit;
    const content = composer.value;
    const submitted = draftGuard.freeze(); // §19：与普通发送同一守卫
    try {
      const res = await fetch(`/api/v1/route-decisions/${decisionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ choice: 'edit', content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.message) absorbMessage(data.message, { update: true });
      state.pendingRouteEdit = null;
      if (draftGuard.mayClear(submitted)) { // 回执期间用户没继续写才清空
        composer.value = '';
        state.draftRevision = draftGuard.touch();
      }
      refreshSendButton();
      composer.focus();
    } catch (err) {
      console.warn('route edit 发送失败，将重试', err);
    }
    return;
  }
  // F13：每次发送独立跟踪（旧回执不清空新提交的幂等键）
  const thisRequestId = state.pendingClientMessageId ?? newClientMessageId();
  const thisDraft = state.pendingDraft ?? composer.value;
  if (!state.pendingClientMessageId) {
    state.pendingClientMessageId = thisRequestId;
    state.pendingDraft = thisDraft;
    state.submittedDraftRevision = draftGuard.freeze(); // §19：共享守卫冻结
  }
  const draft = buildOutgoingDraft(thisDraft, thisRequestId);
  try {
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': draft.client_message_id },
      credentials: 'same-origin', body: JSON.stringify(draft),
    });
    if (res.status === 401) { location.reload(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    absorbMessage(data.message, { update: true });
    // F13：只有仍是同一个请求的 pending 才清除（新提交不受旧回执影响）
    if (state.pendingClientMessageId === thisRequestId) {
      state.pendingClientMessageId = null;
      state.pendingDraft = null;
    }
    // §19：只有用户没继续输入时才清空（共享守卫）
    if (draftGuard.mayClear(state.submittedDraftRevision)) {
      composer.value = '';
      state.draftRevision = draftGuard.touch();
    }
    refreshSendButton();
    composer.focus();
  } catch (err) {
    console.warn('发送失败，复用同一幂等键重试', err);
    refreshSendButton();
  }
}

// —— turn 容器：创建即挂载（AUD-04）——
function ensureTurnState(turnId) {
  let ts = state.turns.get(turnId);
  if (!ts) {
    const element = document.createElement('div');
    element.className = 'turn';
    $('timeline').appendChild(element); // 立即挂载，绝不 detached
    ts = { element, reasoningPanel: null, reasoningBody: null, dirty: false, inflight: false, usageEl: null, lastAttemptId: null };
    state.turns.set(turnId, ts);
  }
  return ts;
}

function absorbMessage(dto, { update = false } = {}) {
  const existing = state.messages.get(dto.id);
  if (existing && !update) return; // ID 去重
  if (existing && dto.revision.revision <= existing.revision.revision) return;
  state.messages.set(dto.id, dto);
  renderMessage(dto, { update: Boolean(existing) });
}

function renderMessage(dto, { update = false } = {}) {
  const ts = dto.turn_id ? ensureTurnState(dto.turn_id) : { element: $('timeline') };
  let bubble = ts.element.querySelector(`[data-message-id="${dto.id}"]`);
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = `bubble ${dto.speaker}`;
    bubble.dataset.messageId = dto.id;
    ts.element.appendChild(bubble);
  }
  bubble.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = dto.revision.content;
  bubble.appendChild(body);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(dto.revision.occurred_at).toLocaleString();
  if (dto.revision.revision > 1) meta.textContent += ` · 修订 ${dto.revision.revision}`;
  bubble.appendChild(meta);
  scrollBottom();
}

// —— reasoning 面板（实时 + 回看 + snapshot）——
function ensureReasoningPanel(turnId) {
  const ts = ensureTurnState(turnId);
  if (ts.reasoningPanel) return ts;
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.textContent = state.reasoningLabel;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  details.appendChild(body);
  ts.element.prepend(details);
  ts.reasoningPanel = details;
  ts.reasoningBody = body;
  return ts;
}

function renderReasoningBlock(block) {
  const ts = ensureReasoningPanel(block.turn_id);
  let el = ts.reasoningBody.querySelector(`[data-block-id="${block.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'reasoning-block';
    el.dataset.blockId = block.id;
    ts.reasoningBody.appendChild(el);
  }
  const badge =
    block.visibility === 'redacted' || block.visibility === 'omitted'
      ? `（${block.visibility === 'redacted' ? '已删隐' : '未返回可读摘要'}）`
      : block.state === 'streaming' ? '…'
      : block.state === 'conflict' ? '（已按完整块更正）'
      : block.state === 'truncated' || block.completeness === 'storage_limited' ? '（超存储上限已截断）'
      : block.state === 'interrupted' ? '（已中断）'
      : block.state === 'partial' ? '（部分接收）'
      : block.state === 'failed' ? '（本轮未完成）'
      : block.visibility === 'no_block' ? '（本轮未返回可读摘要）'
      : '';
  el.textContent = block.text ? block.text + badge : badge || '（等待摘要…）';
  scrollBottom();
}

// AUD-30：按 turn 的 dirty/inflight 刷新状态机——终帧/快照永不因"刷新中"而丢
function scheduleReasoningRefresh(turnId, attemptId) {
  const ts = ensureTurnState(turnId);
  // F16：记录最新 attemptId——新 attempt 的事件到达时更新，pump 闭包使用最新值
  ts.lastAttemptId = attemptId ?? ts.lastAttemptId ?? null;
  ts.dirty = true;
  if (ts.inflight) return;
  ts.inflight = true;
  const pump = async () => {
    try {
      while (ts.dirty) {
        ts.dirty = false;
        const aid = ts.lastAttemptId; // F16：每次循环取最新，不用旧闭包
        const url = aid ? `/api/v1/turns/${turnId}/reasoning?attempt_id=${encodeURIComponent(aid)}` : `/api/v1/turns/${turnId}/reasoning`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          for (const block of data.blocks) renderReasoningBlock(block);
        }
      }
    } finally {
      ts.inflight = false;
    }
  };
  void pump();
}

function setTurnState(turnId, s, extra) {
  const ts = state.turns.get(turnId);
  if (!ts) return;
  let el = ts.element.querySelector('.turn-state');
  if (!el) {
    el = document.createElement('div');
    el.className = 'turn-state';
    ts.element.appendChild(el);
  }
  const labels = {
    running: '生成中…', blocked: '已暂停', route_pending: '等待你对路由的决定',
    completed: '', interrupted: '已停止', failed: '失败',
  };
  el.textContent = labels[s] ?? s;
}

function renderUsage(turnId, payload) {
  const ts = state.turns.get(turnId);
  if (!ts) return;
  const totals = payload?.totals;
  if (!ts.usageEl) {
    ts.usageEl = document.createElement('div');
    ts.usageEl.className = 'usage';
    ts.element.appendChild(ts.usageEl);
  }
  const known = totals && (totals.input_tokens != null || totals.output_tokens != null);
  ts.usageEl.textContent = known
    ? `用量：输入 ${totals.input_tokens ?? '?'} · 输出 ${totals.output_tokens ?? '?'}${totals.unknown_present ? '（部分未知）' : ''}`
    : '用量：未知（SDK 未提供）';
}

// —— SSE（AUD-09：lastAppliedSequence 纪律；重连靠 Last-Event-ID）——
function connectSse() {
  const es = new EventSource(`/api/v1/events?cursor=${state.lastSequence}&conversation_id=${CONVERSATION}`);
  state.sse = es;
  es.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (typeof data.sequence === 'number') {
      if (data.sequence <= state.lastSequence) return; // 旧帧/重放帧一律忽略
      state.lastSequence = data.sequence;
    }
    handleEvent(data);
  };
}
function handleEvent(data) {
  const turnId = data.turn_id ?? null;
  switch (data.kind) {
    case 'message.persisted':
    case 'message.published':
      if (data.message) absorbMessage(data.message, { update: true });
      break;
    case 'turn.started':
      ensureTurnState(turnId);
      break;
    case 'turn.status':
      setTurnState(turnId, data.state, data);
      if (data.state === 'route_pending' || (typeof data.reason === 'string' && data.reason.startsWith('ROUTE_ROOM_PENDING'))) {
        setRoomBadge('路由待决：新消息已保存，模型执行已冻结');
      }
      break;
    case 'turn.completed':
      setTurnState(turnId, 'completed');
      setRoomBadge(null);
      scheduleReasoningRefresh(turnId, data.attempt_id); // F17：完成时主动刷新终态投影
      break;
    case 'turn.interrupted':
      setTurnState(turnId, 'interrupted');
      break;
    case 'reasoning.started':
    case 'reasoning.delta':
    case 'reasoning.completed':
    case 'reasoning.snapshot': // AUD-30：显式处理 snapshot（触发按 turn 刷新，投影以 API 为准）
    case 'reasoning.status_changed':
      scheduleReasoningRefresh(turnId, data.attempt_id);
      break;
    case 'usage.updated':
      refreshUsageLedger(turnId);
      break;
    case 'route.pending':
      state.routePending = { decisionId: data.decision_id, turnId };
      showRouteDialog(data);
      break;
    case 'route.resolved':
      state.routePending = null;
      $('route-dialog').close();
      setRoomBadge(null);
      break;
    default:
      break;
  }
}

async function refreshUsageLedger(turnId) {
  const ts = state.turns.get(turnId);
  if (!ts) return;
  const pull = async () => {
    const res = await fetch(`/api/v1/turns/${turnId}/usage`, { credentials: 'same-origin' });
    return res.ok ? await res.json() : null;
  };
  try {
    let data = await pull();
    if (data && data.totals && data.totals.input_tokens == null && data.totals.output_tokens == null) {
      await new Promise((r) => setTimeout(r, 300)); // 账本落库竞态：补拉一次
      data = await pull();
    }
    if (data) renderUsage(turnId, data);
  } catch { /* 下次事件再刷新 */ }
}

function setRoomBadge(text) {
  const badge = $('runtime-badge');
  if (text) { badge.textContent = text; badge.className = 'badge warn'; }
  else { badge.textContent = '就绪'; badge.className = 'badge ok'; }
}

// —— 路由弹窗（AUD-07：重新编辑走修订流）——
function showRouteDialog(data) {
  const target = data.target_model ?? '未知（平台未给出目标模型）';
  $('route-detail').textContent =
    `本轮模型请求被平台标记为可能切换路由。目标模型：${target}。是否已切换：${data.already_switched ? '是' : '否/未知'}。` +
    `选择"重新编辑"后请在输入框修改并点"重新发送（修订）"——它会更新原消息（revision+1），不会新建消息。`;
  $('route-dialog').showModal();
}
$('route-cancel').onclick = async () => {
  if (!state.routePending) return;
  await fetch(`/api/v1/route-decisions/${state.routePending.decisionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ choice: 'cancel' }),
  });
};
$('route-approve').onclick = async () => {
  if (!state.routePending) return;
  const res = await fetch(`/api/v1/route-decisions/${state.routePending.decisionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ choice: 'approve' }),
  });
  // F18：读取响应正文，如实展示限制
  if (res.ok) {
    const data = await res.json();
    if (data.note) {
      $('route-detail').textContent = `已同意。注意：${data.note}`;
      setTimeout(() => $('route-dialog').close(), 2000);
    }
  }
};
$('route-edit').onclick = () => {
  if (!state.routePending) return;
  // 取票据所属 turn 的原消息内容填回输入框（不是"最近一条 owner 消息"）
  const orig = [...state.messages.values()].reverse().find((m) => m.speaker === 'owner' && m.turn_id === state.routePending?.turnId)
    ?? [...state.messages.values()].reverse().find((m) => m.speaker === 'owner');
  state.pendingRouteEdit = {
    decisionId: state.routePending.decisionId,
    messageId: orig?.id ?? null,
    original: orig?.revision.content ?? '',
  };
  composer.value = state.originalPlaceholderGuard(state.pendingRouteEdit.original);
  state.draftRevision = draftGuard.touch();
  $('route-dialog').close(); // 票据仍 pending，直到修订发送成功
  setRoomBadge('编辑模式：修改后点"重新发送（修订）"');
  refreshSendButton();
  composer.focus();
};
state.originalPlaceholderGuard = (t) => t;

// —— 启动（AUD-34：messages + reasoning 全量回看）——
async function boot() {
  if (state.authorized) return;
  try {
    if (!(await tryResume())) { $('login-panel').hidden = false; return; }
    state.authorized = true;
    $('login-btn').hidden = true;
    $('chat').hidden = false;
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=500`, { credentials: 'same-origin' });
    const data = await res.json();
    const turnIds = new Set();
    for (const m of data.messages ?? []) { absorbMessage(m); if (m.turn_id) turnIds.add(m.turn_id); }
    // 回看思考摘要（AUD-34）：不依赖 SSE 当时在线
    for (const turnId of turnIds) {
      try {
        const r = await fetch(`/api/v1/turns/${turnId}/reasoning`, { credentials: 'same-origin' });
        if (r.ok) {
          const rd = await r.json();
          for (const block of rd.blocks) renderReasoningBlock(block);
        }
        const u = await fetch(`/api/v1/turns/${turnId}/usage`, { credentials: 'same-origin' });
        if (u.ok) renderUsage(turnId, await u.json());
      } catch { /* 单 turn 失败不影响整体 */ }
    }
    const es = state.sse;
    void es;
    connectSse();
    const rt = await fetch(`/api/v1/conversations/${CONVERSATION}/runtime`, { credentials: 'same-origin' });
    if (rt.ok) {
      const runtime = await rt.json();
      state.reasoningLabel = runtime.reasoning_label ?? '思考';
      if (runtime.identity?.state === 'READY' && !runtime.runner?.blocked) setRoomBadge(null);
      else { const badge = $('runtime-badge'); badge.textContent = '模型通道未就绪（可聊天保存，暂不回复）'; badge.className = 'badge warn'; }
    }
    refreshSendButton();
    composer.focus();
  } catch (err) {
    $('runtime-badge').textContent = '连接失败';
    console.error(err);
  }
}

function scrollBottom() {
  const timeline = $('timeline');
  timeline.scrollTop = timeline.scrollHeight;
}
void boot;
boot();
