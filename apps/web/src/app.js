// estómago 前端（v0 骨架）：SSE 时间线 + 思考折叠区 + 路由弹窗 + composer 硬规则。
// 与宿主的边界：输入侧与输出侧是两套状态机——用户回车永远是换行（见 composer-logic.js），
// char输出的分句只是发布策略；两者绝不复用。
import {
  canSend,
  buildOutgoingDraft,
  newClientMessageId,
  shouldSendOnKeydown,
} from './composer-logic.js';

const CONVERSATION = 'primary';
const $ = (id) => document.getElementById(id);

const state = {
  authorized: false,
  composing: false,
  pendingClientMessageId: null, // 发送中未获回执的幂等键；重试必须复用
  pendingDraft: null,
  messages: new Map(), // message_id -> dto（以 ID 去重，不用时间戳）
  lastSequence: 0,
  turns: new Map(), // turn_id -> {reasoning blocks by id, state, usage}
  routePending: null,
  reasoningLabel: '思考',
  sse: null,
};

// —— 认证（首版单拥有者设备配对：粘贴一次 token → HttpOnly 会话 cookie）——
async function tryResume() {
  const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=500`, { credentials: 'same-origin' });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

$('login-btn').hidden = false;
$('login-btn').onclick = () => {
  $('login-panel').hidden = !$('login-panel').hidden;
};
$('token-submit').onclick = async () => {
  const token = $('token-input').value.trim();
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token }),
  });
  if (res.ok) {
    $('login-panel').hidden = true;
    $('login-error').hidden = true;
    boot();
  } else {
    $('login-error').textContent = 'token 不正确或服务器拒绝';
    $('login-error').hidden = false;
  }
};

// —— composer：Enter 只换行（textarea 原生），独立发送键 + IME guard + 幂等键 ——
const composer = $('composer');
composer.addEventListener('compositionstart', () => {
  state.composing = true;
  refreshSendButton();
});
composer.addEventListener('compositionend', () => {
  state.composing = false;
  refreshSendButton();
});
composer.addEventListener('input', refreshSendButton);
// 不注册任何 keydown 发送路径：shouldSendOnKeydown() 恒为 false（规则单一事实源）
composer.addEventListener('keydown', (e) => {
  if (!shouldSendOnKeydown() && (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey))) {
    // 组合键+Enter 也不发送：默认交给 textarea（Shift+Enter 换行等），其余组合不拦截不冒充快捷键
  }
});
$('send-btn').addEventListener('click', () => void send());

function refreshSendButton() {
  $('send-btn').disabled = !canSend(composer.value, { composing: state.composing });
}

async function send() {
  if (!canSend(composer.value, { composing: state.composing })) return;
  if (!state.pendingClientMessageId) {
    state.pendingClientMessageId = newClientMessageId();
    state.pendingDraft = composer.value;
  }
  const draft = buildOutgoingDraft(state.pendingDraft, state.pendingClientMessageId);
  try {
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': draft.client_message_id },
      credentials: 'same-origin',
      body: JSON.stringify(draft),
    });
    if (res.status === 401) { location.reload(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    absorbMessage(data.message);
    state.pendingClientMessageId = null;
    state.pendingDraft = null;
    composer.value = '';
    refreshSendButton();
    composer.focus();
  } catch (err) {
    // 网络失败：保留同一幂等键供重试；不清空 composer
    console.warn('发送失败，将复用同一幂等键重试', err);
    refreshSendButton();
  }
}

// —— 时间线渲染 ——
function absorbMessage(dto) {
  if (state.messages.has(dto.id)) return; // 以 message_id 去重
  state.messages.set(dto.id, dto);
  renderMessage(dto);
}

function renderMessage(dto) {
  const turnGroup = ensureTurnGroup(dto.turn_id);
  const bubble = document.createElement('div');
  bubble.className = `bubble ${dto.speaker}`;
  bubble.dataset.messageId = dto.id;
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = dto.revision.content; // textContent + CSS pre-wrap：多行原样、天然防注入
  bubble.appendChild(body);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(dto.revision.occurred_at).toLocaleString();
  if (dto.revision.revision > 1) meta.textContent += ` · 修订 ${dto.revision.revision}`;
  bubble.appendChild(meta);
  turnGroup.appendChild(bubble);
  scrollBottom();
}

function ensureTurnGroup(turnId) {
  const timeline = $('timeline');
  if (turnId && state.turns.has(turnId)) {
    return state.turns.get(turnId).element;
  }
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  timeline.appendChild(wrap);
  return wrap;
}

function ensureTurnState(turnId) {
  if (!state.turns.has(turnId)) {
    const element = document.createElement('div');
    element.className = 'turn';
    state.turns.set(turnId, { element, reasoningPanel: null, blocks: new Map(), usageEl: null });
  }
  return state.turns.get(turnId);
}

// —— 思考折叠区（默认折叠；只读已收内容；展开不调用模型）——
function ensureReasoningPanel(turnId) {
  const ts = ensureTurnState(turnId);
  if (ts.reasoningPanel) return ts.reasoningPanel;
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.textContent = state.reasoningLabel; // 默认名"思考"，可配置
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  details.appendChild(body);
  ts.element.prepend(details);
  ts.reasoningPanel = details;
  return details;
}

function renderReasoningBlock(block) {
  const details = ensureReasoningPanel(block.turn_id);
  const body = details.querySelector('.reasoning-body');
  let el = body.querySelector(`[data-block-id="${block.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'reasoning-block';
    el.dataset.blockId = block.id;
    body.appendChild(el);
  }
  const badge =
    block.visibility === 'redacted' || block.visibility === 'omitted'
      ? `（${block.visibility === 'redacted' ? '已删隐' : '未返回可读摘要'}）`
      : block.state === 'streaming'
        ? '…'
        : block.state === 'conflict'
          ? '（已按完整块更正）'
          : block.visibility === 'no_block'
            ? '（本轮未返回可读摘要）'
            : '';
  el.textContent = block.text ? block.text + badge : badge || '（等待摘要…）';
  scrollBottom();
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
    running: '生成中…',
    blocked: '已暂停（未就绪）',
    route_pending: '等待你对路由的决定',
    completed: '',
    interrupted: '已停止',
    failed: '失败',
  };
  let text = labels[s] ?? s;
  if (s === 'blocked' && extra?.reason) text = `已暂停：${shortReason(extra.reason)}`;
  el.textContent = text;
}

function shortReason(reason) {
  if (reason.startsWith('runtime_not_ready')) return '运行时未就绪（SDK/认证未配置）';
  if (reason.startsWith('identity_not_ready')) return '身份未批准（IDENTITY_BLOCKED）';
  if (reason.startsWith('no_active_window')) return '无活动窗口（身份未通过）';
  return reason.length > 60 ? reason.slice(0, 60) + '…' : reason;
}

function renderUsage(turnId, payload) {
  const ts = state.turns.get(turnId);
  if (!ts || !payload?.usage) return;
  const u = payload.usage;
  const known = u.input_tokens != null || u.output_tokens != null;
  const text = known
    ? `用量（${payload.scope}）：输入 ${u.input_tokens ?? '?'} · 输出 ${u.output_tokens ?? '?'}`
    : '用量：未知（SDK 未提供）';
  if (!ts.usageEl) {
    ts.usageEl = document.createElement('div');
    ts.usageEl.className = 'usage';
    ts.element.appendChild(ts.usageEl);
  }
  ts.usageEl.textContent = text;
}

// —— SSE ——
function connectSse() {
  const es = new EventSource(`/api/v1/events?cursor=${state.lastSequence}`);
  state.sse = es;
  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof data.sequence === 'number' && data.sequence > state.lastSequence) state.lastSequence = data.sequence;
    handleEvent(data);
  };
  es.onerror = () => {
    // EventSource 自动重连；重连用 Last-Event-ID（= 持久 sequence）
  };
}

function handleEvent(data) {
  const turnId = data.turn_id ?? null;
  switch (data.kind) {
    case 'message.persisted':
    case 'message.published':
      if (data.message) absorbMessage(data.message);
      break;
    case 'turn.started':
      ensureTurnState(turnId);
      break;
    case 'turn.status':
      setTurnState(turnId, data.state, data);
      break;
    case 'turn.completed':
      setTurnState(turnId, 'completed');
      break;
    case 'turn.interrupted':
      setTurnState(turnId, 'interrupted');
      break;
    case 'reasoning.started':
    case 'reasoning.completed':
    case 'reasoning.status_changed': {
      // 推送里只有 delta；完整投影按需拉取（GET /turns/{id}/reasoning）
      refreshReasoning(turnId, data.attempt_id);
      break;
    }
    case 'reasoning.delta':
      refreshReasoning(turnId, data.attempt_id);
      break;
    case 'usage.updated':
      renderUsage(turnId, data.payload ?? data);
      break;
    case 'route.pending':
      state.routePending = { decisionId: data.decision_id, turnId };
      showRouteDialog(data);
      break;
    case 'route.resolved':
      state.routePending = null;
      $('route-dialog').close();
      break;
    default:
      break;
  }
}

let reasoningRefreshing = false;
async function refreshReasoning(turnId, attemptId) {
  if (!turnId || reasoningRefreshing) return;
  reasoningRefreshing = true;
  try {
    const url = attemptId ? `/api/v1/turns/${turnId}/reasoning?attempt_id=${encodeURIComponent(attemptId)}` : `/api/v1/turns/${turnId}/reasoning`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      for (const block of data.blocks) renderReasoningBlock(block);
    }
  } finally {
    setTimeout(() => (reasoningRefreshing = false), 60);
  }
}

// —— 路由弹窗：重新编辑 / 同意 / 取消；关页面≠同意（票据在服务端，重启仍在）——
function showRouteDialog(data) {
  const target = data.target_model ?? '未知（平台未给出目标模型）';
  $('route-detail').textContent =
    `本轮模型请求被平台标记为可能切换路由。目标模型：${target}。是否已切换：${data.already_switched ? '是' : '否/未知'}。` +
    `你可以重新编辑后重发（生成新修订），或同意本次路由（生成新一次尝试），或取消。`;
  $('route-dialog').showModal();
}

$('route-cancel').onclick = async () => {
  if (!state.routePending) return;
  await fetch(`/api/v1/route-decisions/${state.routePending.decisionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ choice: 'cancel' }),
  });
};
$('route-approve').onclick = async () => {
  if (!state.routePending) return;
  await fetch(`/api/v1/route-decisions/${state.routePending.decisionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ choice: 'approve' }),
  });
};
$('route-edit').onclick = () => {
  $('route-dialog').close(); // 票据仍 pending；用户编辑后从 composer 重发将生成新修订/新尝试
  composer.focus();
};

// —— 启动 ——
async function boot() {
  if (state.authorized) return;
  try {
    if (!(await tryResume())) {
      $('login-panel').hidden = false;
      return;
    }
    state.authorized = true;
    $('login-btn').hidden = true;
    $('chat').hidden = false;
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=500`, { credentials: 'same-origin' });
    const data = await res.json();
    for (const m of data.messages ?? []) absorbMessage(m);
    connectSse();
    const rt = await fetch(`/api/v1/conversations/${CONVERSATION}/runtime`, { credentials: 'same-origin' });
    if (rt.ok) {
      const runtime = await rt.json();
      state.reasoningLabel = runtime.reasoning_label ?? '思考';
      const badge = $('runtime-badge');
      if (runtime.identity?.state === 'READY' && !runtime.runner?.blocked) {
        badge.textContent = '就绪';
        badge.className = 'badge ok';
      } else {
        badge.textContent = '模型通道未就绪（可聊天保存，暂不回复）';
        badge.className = 'badge warn';
      }
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

void boot();
