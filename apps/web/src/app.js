// estómago 前端 v0.2.2（AUD-04/07/09/17/30/34 修复）：
//  - turn 容器创建即挂载 timeline（绝不写 detached DOM）
//  - 草稿修订守卫：回执只清空"仍等于提交时版本"的草稿
//  - reasoning.snapshot 显式处理；按 turn 维护 dirty/inflight 刷新状态机，终帧不丢
//  - 刷新/换端回看：boot 拉取 messages + 每个 turn 的 reasoning
//  - sequence 纪律：只应用 sequence > lastAppliedSequence 的事件；重连靠 Last-Event-ID
//  - 路由"重新编辑"走真修订端点：原消息 revision+1，不新建 owner 消息
import { canSend, buildOutgoingDraft, newClientMessageId, shouldSendOnKeydown, makeDraftGuard, shouldApplyEstimate } from './composer-logic.js';

const CONVERSATION = 'primary';
const $ = (id) => document.getElementById(id);

const draftGuard = makeDraftGuard(); // §19：普通发送与 route edit 共享同一草稿守卫

const state = {
  authorized: false,
  booting: false,
  authRedirecting: false,
  composing: false,
  sending: false,
  pinnedToBottom: true,
  loadingEarlier: false,
  // F13：冻结正文、附件和完整 body；同 key 重试复用原载荷，回执只清自己的。
  pendingSend: null,
  draftRevision: 0,          // AUD-17：每次用户输入 +1；发送时冻结
  pendingRouteEdit: null,     // { decisionId, messageId, original }
  messages: new Map(),        // message_id -> dto
  lastSequence: 0,            // AUD-09：只应用更新的 sequence
  turns: new Map(),           // turn_id -> {element, reasoningPanel, reasoningBody, dirty, inflight, usageEl}
  routePending: null,
  routeCloseTimer: null,      // F18：2s 关闭计时器（绑定票据，关下一张弹窗前必须核销）
  reasoningLabel: '思考',
  sse: null,
  // EXEC_V1 §05：预估与系统红点（客户端零模型调用；慢响应只应用匹配草稿/模型/附件指纹的回包）
  estimate: { charsPerToken: 2.5, timer: null, inFlight: null, modelSnapshotId: null },
  alertsOpen: false,
  // EXEC_V1 §03.5.3：待发附件队列（上传成功才有 asset_id；失败保留可重试，不产生半条消息）
  attachments: [], // Array<{asset_id, presentation:'image', caption:null, name, status}>
};

const timelineContent = () => $('timeline-content') || $('timeline');
const readyAttachments = () => state.attachments.filter((a) => a.status === 'ready' && a.asset_id);

// —— 认证 ——
function redirectToLogin() {
  if (state.authRedirecting) return;
  state.authRedirecting = true;
  state.authorized = false;
  state.sse?.close();
  state.sse = null;
  $('chat').hidden = true;
  $('retry-connection-btn').hidden = true;
  location.replace('/login');
}

async function tryResume() {
  const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) { redirectToLogin(); return false; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// F-J-48（联合审计 2026-10-06）：历史向上翻页——服务端 before= 反向分页；
// 吸收走同一 absorbMessage（ID 去重/修订吸收），加载后保持视口位置不跳底
async function loadEarlier() {
  const seqs = [...state.messages.values()].map((m) => m.sequence).filter((x) => typeof x === 'number');
  if (seqs.length === 0) return;
  const oldest = Math.min(...seqs);
  const timeline = $('timeline');
  const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=200&before=${oldest}`, { credentials: 'same-origin' });
  if (res.status === 401) { redirectToLogin(); return; }
  if (!res.ok) return;
  const data = await res.json();
  const older = data.messages ?? [];
  const oldHeight = timeline.scrollHeight;
  const oldTop = timeline.scrollTop;
  state.loadingEarlier = true;
  state.pinnedToBottom = false;
  for (const m of older) absorbMessage(m);
  // 服务端历史页按 sequence 排序；旧 turn 需移到当前页之前，不能追加到末尾。
  const content = timelineContent();
  if (content.children) {
    [...content.children].sort((a, b) => Number(a.dataset.sequence ?? Infinity) - Number(b.dataset.sequence ?? Infinity)).forEach((el) => content.appendChild(el));
  }
  timeline.scrollTop = oldTop + timeline.scrollHeight - oldHeight;
  state.loadingEarlier = false;
  if (older.length < 200) { const btn = $('load-earlier-btn'); if (btn) btn.hidden = true; }
}
$('retry-connection-btn').onclick = () => void boot();

// —— composer：Enter 只换行；独立发送键；IME guard；幂等键 ——
const composer = $('composer');
composer.addEventListener('compositionstart', () => { state.composing = true; refreshSendButton(); });
composer.addEventListener('compositionend', () => { state.composing = false; refreshSendButton(); });
composer.addEventListener('input', () => { state.draftRevision = draftGuard.touch(); resizeComposer(); refreshSendButton(); scheduleEstimate(); });
void shouldSendOnKeydown; // 无任何按键发送路径（规则单一事实源在 composer-logic.js）

function refreshSendButton() {
  const editing = Boolean(state.pendingRouteEdit);
  const label = state.sending ? '正在发送' : editing ? '重新发送（修订）' : state.pendingSend ? '重试发送' : '发送';
  $('send-btn').setAttribute('aria-label', label);
  $('send-btn').title = label;
  // 输入硬规则：IME 合成期不得发送；有失败待重试的发送时按钮保持可点（重试入口不能死）
  $('send-btn').disabled = state.composing || state.sending || voiceInput.starting || Boolean(voiceInput.recorder) || !(canSend(composer.value, { composing: false, hasAttachment: !editing && readyAttachments().length > 0 }) || Boolean(state.pendingSend));
}
$('send-btn').addEventListener('click', () => void send());

async function send() {
  // 输入硬规则第一条：IME 合成期（composing=true）不发送——对普通发送/修订/pending 重试统一生效，
  // 候选确认不能变成发送；重试路径不得覆盖该边界
  if (state.composing || state.sending || voiceInput.starting || voiceInput.recorder) return;
  // F13：composer 为空但存在失败待重试的发送 → 按原内容同幂等键重试；composer 有新内容则发新请求（旧失败项作废）
  const retryPending = Boolean(state.pendingSend) && (composer.value === '' || composer.value === state.pendingSend.draft);
  if (!canSend(composer.value, { composing: false, hasAttachment: !state.pendingRouteEdit && readyAttachments().length > 0 }) && !retryPending) return;
  state.sending = true;
  scrollBottom(true);
  refreshSendButton();
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
      if (res.status === 401) { redirectToLogin(); return; }
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
    } catch {
      setRoomBadge('修订发送失败，正文已保留，请重试');
    } finally {
      state.sending = false;
      resizeComposer();
      refreshSendButton();
    }
    return;
  }
  const thisRequestId = retryPending ? state.pendingSend.requestId : newClientMessageId();
  const thisDraft = retryPending ? state.pendingSend.draft : composer.value;
  // F13：pending 携带自己的守卫冻结值——旧回执只允许按"它那次"的修订判断清空，绝不触碰新草稿
  if (!retryPending) {
    const draft = buildOutgoingDraft(thisDraft, thisRequestId);
    const sentEntries = readyAttachments().slice();
    const attachments = sentEntries.map((a) => ({ asset_id: a.asset_id, presentation: a.presentation, ...(a.caption != null ? { caption: a.caption } : {}) }));
    // Let the host derive voice/sticker kind from validated attachments.
    if (attachments.length) delete draft.kind;
    // 同幂等键重试必须复用完整载荷；网络失败后新加的附件不混进旧请求。
    state.pendingSend = { requestId: thisRequestId, draft: thisDraft, frozenRev: draftGuard.freeze(), sentEntries, body: attachments.length ? { ...draft, attachments } : draft };
  }
  const submittedSend = state.pendingSend;
  const body = submittedSend.body ?? buildOutgoingDraft(thisDraft, thisRequestId);
  try {
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': thisRequestId },
      credentials: 'same-origin', body: JSON.stringify(body),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    absorbMessage(data.message, { update: true });
    const settled = state.pendingSend;
    // F13：只有仍是同一个请求的 pending 才清除（新提交不受旧回执影响）
    if (settled && settled.requestId === thisRequestId) state.pendingSend = null;
    // §19/F13：回执只清"仍是自己那次内容"的 composer——用户后来输入的新草稿绝不触碰
    if (settled && settled.requestId === thisRequestId && draftGuard.mayClear(settled.frozenRev) && composer.value === settled.draft) {
      composer.value = '';
      state.draftRevision = draftGuard.touch();
    }
    // 只清本次成功提交的队列项；新加、失败及上传中的条目一律保留。
    const sentEntries = submittedSend.sentEntries ?? [];
    state.attachments = state.attachments.filter((a) => !sentEntries.includes(a));
    for (const a of sentEntries) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    renderAttachQueue();
    refreshSendButton();
    composer.focus();
    void loadRuntimeSettings();
  } catch {
    // F13：失败保留 pending（同幂等键同内容可重试），按钮保持可点
    setRoomBadge('发送失败，文字与附件已保留，点发送重试');
  } finally {
    state.sending = false;
    resizeComposer();
    refreshSendButton();
  }
}

// —— turn 容器：创建即挂载（AUD-04）——
function ensureTurnState(turnId) {
  let ts = state.turns.get(turnId);
  if (!ts) {
    const element = document.createElement('div');
    element.className = 'turn';
    timelineContent().appendChild(element); // 立即挂载，绝不 detached
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
  const ts = dto.turn_id ? ensureTurnState(dto.turn_id) : { element: timelineContent() };
  if (dto.turn_id && typeof dto.sequence === 'number') ts.element.dataset.sequence = String(Math.min(Number(ts.element.dataset.sequence ?? Infinity), dto.sequence));
  let bubble = ts.element.querySelector(`[data-message-id="${dto.id}"]`);
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = `bubble ${dto.speaker}`;
    bubble.dataset.messageId = dto.id;
    if (typeof dto.sequence === 'number') bubble.dataset.sequence = String(dto.sequence);
    ts.element.appendChild(bubble);
  }
  bubble.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = dto.revision.content;
  bubble.appendChild(body);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(dto.revision.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  meta.title = new Date(dto.revision.occurred_at).toLocaleString();
  meta.setAttribute('aria-label', meta.title);
  if (dto.revision.revision > 1) meta.textContent += ` · 修订 ${dto.revision.revision}`;
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.appendChild(meta);
  // EXEC_V1 §05.7：气泡层 token 标注——owner=发送时快照（旧消息无快照不伪造）；
  // assistant=可见文字本地粗估。整轮实际用量只在轮汇总出现一次（renderUsage），不摊进气泡。
  let estimateText = '';
  if (dto.speaker === 'owner' && dto.revision.token_estimate) {
    const te = dto.revision.token_estimate;
    estimateText = `发送时估计：正文约 ${te.message_text_tokens} token` + (te.message_media_tokens === null ? ' · 图片用量待估' : te.message_total_tokens !== null && te.message_total_tokens > te.message_text_tokens ? ` · 合计约 ${te.message_total_tokens}` : '');
  } else if (dto.speaker === 'assistant' && dto.revision.content) {
    estimateText = `正文约 ${Math.ceil([...dto.revision.content].length / state.estimate.charsPerToken)} token（粗估）`;
  }
  if (estimateText) {
    const est = document.createElement('div');
    est.className = 'bubble-estimate';
    const estimate = dto.speaker === 'owner' ? dto.revision.token_estimate?.message_text_tokens : Math.ceil([...dto.revision.content].length / state.estimate.charsPerToken);
    est.textContent = `约 ${fmtNum(estimate)}`;
    est.title = estimateText;
    est.setAttribute('aria-label', estimateText);
    actions.appendChild(est);
  }
  // EXEC_V1 §03.5.3：附件渲染——img/audio 明确元素（不 innerHTML）；重进页面从数据库附件重建，
  // 不依赖此前 Blob URL；取不到如实"附件暂不可用"
  const atts = dto.revision.attachments ?? [];
  if (atts.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-media';
    for (const a of atts) {
      const url = `/api/v1/assets/${encodeURIComponent(a.asset_id)}/content`;
      if (a.presentation === 'voice') {
        const au = document.createElement('audio');
        au.hidden = true;
        au.preload = 'metadata';
        au.src = url;
        const player = document.createElement('button');
        player.type = 'button'; player.className = 'voice-player'; player.setAttribute('aria-label', '播放语音');
        const playIcon = document.createElement('span'); playIcon.className = 'voice-play-icon'; playIcon.textContent = '▶';
        const wave = document.createElement('span'); wave.className = 'voice-wave'; wave.setAttribute('aria-hidden', 'true');
        for (const height of [6, 12, 18, 10, 16, 8, 14, 20, 12, 16, 8, 5]) {
          const bar = document.createElement('span'); bar.style.height = `${height}px`; wave.appendChild(bar);
        }
        const duration = document.createElement('span'); duration.className = 'voice-duration'; duration.textContent = '语音';
        player.appendChild(playIcon); player.appendChild(wave); player.appendChild(duration);
        const updateAudio = () => {
          const playing = !au.paused && !au.ended;
          playIcon.textContent = playing ? 'Ⅱ' : '▶'; player.setAttribute('aria-label', playing ? '暂停语音' : '播放语音');
          const total = Number.isFinite(au.duration) ? au.duration : null;
          duration.textContent = total == null ? '语音' : `${Math.ceil(playing ? au.currentTime : total)}″`;
          if (total) [...wave.children].forEach((bar, i) => { bar.style.background = i / wave.children.length < au.currentTime / total ? '#6c6656' : ''; });
        };
        au.onloadedmetadata = updateAudio; au.ontimeupdate = updateAudio; au.onplay = updateAudio; au.onpause = updateAudio; au.onended = updateAudio;
        player.onclick = async () => {
          if (!au.paused) au.pause();
          else { try { await au.play(); } catch { duration.textContent = '暂不能播放'; } }
        };
        au.onerror = () => { player.disabled = true; duration.textContent = '语音暂不可用'; player.setAttribute('aria-label', '语音附件暂不可用'); };
        wrap.appendChild(au);
        wrap.appendChild(player);
        if (a.derived_text) { const t = document.createElement('div'); t.className = 'voice-transcript'; t.title = '语音转写'; t.textContent = a.derived_text; wrap.appendChild(t); }
      } else {
        const img = document.createElement('img');
        img.alt = a.caption ?? '附件图片';
        img.loading = 'lazy';
        img.src = url;
        img.addEventListener('load', () => scrollBottom());
        img.onerror = () => { img.remove(); const f = document.createElement('div'); f.className = 'unavailable'; f.textContent = '附件暂不可用'; wrap.appendChild(f); };
        wrap.appendChild(img);
      }
    }
    bubble.appendChild(wrap);
  }
  // F-J-08（联合审计 2026-10-06）：用户消息编辑入口——修订链/outbox 由服务端
  // editUserMessage 同事务保证（不无痕重写）；编辑不自动触发重新生成
  // WP3（2026-10-08）：人工历史选集——选择模式下给消息加勾选（只 owner/
  // 已发布 assistant 可选；system/tool 天然不在 messages 面里）
  if (selection.active && (dto.speaker === 'owner' || dto.speaker === 'assistant')) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sel-cb';
    cb.checked = selection.ids.has(dto.id);
    cb.onchange = () => {
      if (cb.checked) selection.ids.add(dto.id);
      else selection.ids.delete(dto.id);
      updateSelectionBar();
    };
    bubble.insertBefore(cb, bubble.firstChild);
  }
  if (dto.speaker === 'owner' || dto.speaker === 'assistant') {
    const copyBtn = messageAction('copy', '复制正文', 'copy-btn');
    copyBtn.onclick = async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(dto.revision.content ?? '');
        copyBtn.title = '已复制';
        copyBtn.setAttribute('aria-label', '已复制');
      } catch { setRoomBadge('复制不可用，请长按消息正文复制'); }
    };
    actions.appendChild(copyBtn);
    const selectBtn = messageAction('select', '选入换窗历史', 'select-message-btn');
    selectBtn.setAttribute('aria-pressed', String(selection.ids.has(dto.id)));
    selectBtn.onclick = () => {
      if (!selection.active) toggleSelection();
      selection.ids.add(dto.id);
      rerenderSelection();
    };
    actions.appendChild(selectBtn);
  }
  if (dto.speaker === 'owner') {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn message-action';
    setActionIcon(editBtn, 'edit', '编辑');
    editBtn.onclick = async () => {
      const next = window.prompt('修改这条消息（整体多行正文，保存后形成新修订）', dto.revision.content);
      if (next === null || next === dto.revision.content) return;
      const res = await fetch(`/api/v1/conversations/${encodeURIComponent(dto.conversation_id ?? CONVERSATION)}/messages/${encodeURIComponent(dto.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${dto.current_revision}"` }, credentials: 'same-origin', body: JSON.stringify({ content: next }),
      });
      if (res.ok) { const data = await res.json(); absorbMessage(data.message, { update: true }); }
      else if (res.status === 428 || res.status === 409) { const e = await res.json().catch(() => ({})); window.alert(`${e?.error?.message ?? '版本已变化'}——请刷新后重新编辑`); }
      else { const e = await res.json().catch(() => ({})); window.alert(`编辑失败：${e?.error?.message ?? res.status}`); }
    };
    actions.appendChild(editBtn);
  }
  bubble.appendChild(actions);
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
  // F-J-07（联合审计 2026-10-06）：主动停止入口——服务端 stop 端点此前 UI 不可达，
  // 只能靠断连。fence 先行（迟到文字丢弃、真实迟到 usage 仍记账）由服务端保证。
  if (s === 'running') {
    if (!ts.stopBtn) {
      const btn = document.createElement('button');
      btn.className = 'stop-btn';
      btn.textContent = '停止';
      btn.onclick = async () => {
        btn.disabled = true;
        try { await fetch(`/api/v1/turns/${encodeURIComponent(turnId)}/stop`, { method: 'POST', credentials: 'same-origin' }); }
        catch { btn.disabled = false; /* R19：失败恢复可重试（此前一次网络失败后按钮永久 disabled） */ }
      };
      ts.stopBtn = btn;
      ts.element.appendChild(btn);
    } else if (ts.stopBtn && ts.stopBtn.disabled) {
      ts.stopBtn.disabled = false; // R19：后续 running 状态事件重置（服务端拒绝/失败后可再停）
    }
  } else if (ts.stopBtn) {
    ts.stopBtn.remove();
    ts.stopBtn = null;
  }
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

// F-J-52（联合审计 2026-10-06）：HTML 转义 helper——面板拼装统一走此函数，
// 动态自由文本（标题/型号/原因等）不得以原始形态进 innerHTML
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// —— SSE（AUD-09：lastAppliedSequence 纪律；重连靠 Last-Event-ID）——
function connectSse() {
  if (state.authRedirecting) return;
  state.sse?.close();
  const es = new EventSource(`/api/v1/events?cursor=${state.lastSequence}&conversation_id=${CONVERSATION}`);
  state.sse = es;
  es.onmessage = (ev) => {
    if (state.sse !== es || state.authRedirecting) return;
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (typeof data.sequence === 'number') {
      if (data.sequence <= state.lastSequence) return; // 旧帧/重放帧一律忽略
      state.lastSequence = data.sequence;
    }
    handleEvent(data);
  };
  // EventSource 不公开 HTTP 状态；只在会话端点明确返回 401 时离开聊天。
  // 网络/服务端故障继续交给原连接重连，重复 error 共用一次检查。
  let sessionCheck = null;
  es.onerror = () => {
    if (state.sse !== es || state.authRedirecting) return;
    if (sessionCheck) return sessionCheck;
    sessionCheck = fetch('/api/v1/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => { if (res.status === 401 && state.sse === es) redirectToLogin(); })
      .catch(() => { /* 网络故障不代表会话失效 */ })
      .finally(() => { sessionCheck = null; });
    return sessionCheck;
  };
}
function handleEvent(data) {
  const turnId = data.turn_id ?? null;
  switch (data.kind) {
    case 'message.persisted':
    case 'message.published':
    case 'message.edited': // R16：编辑修订经 SSE 可见，按 ID/修订吸收（update 不降级已见修订）
      if (data.message) absorbMessage(data.message, { update: true });
      break;
    case 'turn.started':
      ensureTurnState(turnId);
      break;
    case 'turn.status':
      setTurnState(turnId, data.state, data);
      // F17：failed 终态也补拉——无思考块回合的 no_block 行不发 reasoning 事件，只能按终态拉取
      if (data.state === 'failed') scheduleReasoningRefresh(turnId, data.attempt_id);
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
      scheduleReasoningRefresh(turnId, data.attempt_id); // F17：中断终态同样补拉 no_block 投影
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
    case 'route.observed':
      // F10：SDK 观测到的路由事实（fallback 已发生/拒绝未切换）——时间线可见，不依赖弹窗
      setRoomBadge(data.already_switched
        ? `模型已切换：${data.actual_model ?? '未知'}（原 ${data.original_model ?? '未知'}）——本回合已暂停`
        : '模型拒绝且未切换（无 fallback）——本回合按失败处理');
      break;
    case 'system.alert.changed': // EXEC_V1 §05：红点状态以后端快照为准（非 localStorage 单点）
      void refreshAlertSummary();
      break;
    case 'route.resolved':
      state.routePending = null;
      clearTimeout(state.routeCloseTimer); // F18：票据已决，旧计时器作废
      state.routeCloseTimer = null;
      $('route-dialog').close();
      setRoomBadge(null);
      // 跨端修订同步：按 message ID + revision 吸收（旧 revision 不覆盖新 revision）
      if (data.message) absorbMessage(data.message, { update: true });
      break;
    default:
      break;
  }
  // 记录面板：相关事件到达时（面板开着才）轻量刷新——只读查询，不触发生成
  if (RECORD_EVENT_KINDS.has(data.kind)) scheduleRecordsRefresh();
}

// —— 记录面板（ESTOMAGO_OR_SELF_HOLD §11.2）：只读；打开/刷新不调用模型、不写记忆、不换窗 ——
const RECORD_EVENT_KINDS = new Set(['archive.sync', 'context.warning', 'review.sent', 'review.failed', 'window.rotated']);
let recordsTimer = null;
function scheduleRecordsRefresh() {
  if ($('records-panel').hidden) return;
  if (recordsTimer) return;
  recordsTimer = setTimeout(() => { recordsTimer = null; void loadRecords(); }, 400);
}

// 审计 F26：委托绑定——面板内容被 innerHTML 重写后按钮处理器不再丢失
$('records-panel').addEventListener('click', (e) => {
  if (e.target && e.target.id === 'records-older') void loadOlderEvents();
});
$('records-btn').onclick = () => {
  const panel = $('records-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) void loadRecords();
};
$('records-close').onclick = () => { $('records-panel').hidden = true; };

const fmtNum = (v) => (typeof v === 'number' ? v.toLocaleString('zh-Hans') : '未知');
const fmtTime = (iso) => (typeof iso === 'string' ? new Date(iso).toLocaleString('zh-Hans', { hour12: false }) : '—');

// 审计 F26：加载更早=before= 游标严格前移（旧 forward 会原样重发当前页）；已见 eventId 不重复插入
const seenEventIds = new Set();
async function loadOlderEvents() {
  const body = $('records-body');
  const prev = body.dataset.prevCursor;
  if (!prev) return;
  try {
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/context-records/events?limit=30&before=${prev}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const older = await res.json();
    const eventsSection = body.querySelector('.rec-section:last-child');
    const rows = (older.events ?? []).filter((e) => !seenEventIds.has(e.eventId)).map((e) => {
      seenEventIds.add(e.eventId);
      const label = { 'archive.sync': '原文同步', 'context.warning': '上下文提示', 'review.sent': '换窗检查', 'review.failed': '检查失败', 'window.rotated': '已换窗' }[e.kind] ?? e.kind;
      return `<div class="rec-event">${fmtTime(e.occurredAt)}　${esc(label)}</div>`;
    }).join('');
    if (eventsSection && rows) eventsSection.insertAdjacentHTML('afterbegin', rows);
    if (older.prevCursor) body.dataset.prevCursor = older.prevCursor; else delete body.dataset.prevCursor;
  } catch { /* 更早页加载失败不影响面板 */ }
}

async function loadRecords() {
  const body = $('records-body');
  try {
    // F21：请求"最近一页"（最新 30 条），不再永远拿最早的 30 条；更早的按需加载
    const [snapRes, evRes] = await Promise.all([
      fetch(`/api/v1/conversations/${CONVERSATION}/context-records`, { credentials: 'same-origin' }),
      fetch(`/api/v1/conversations/${CONVERSATION}/context-records/events?limit=30&last=1`, { credentials: 'same-origin' }),
    ]);
    if (!snapRes.ok || !evRes.ok) throw new Error(`HTTP ${snapRes.status}/${evRes.status}`);
    const s = await snapRes.json();
    const ev = await evRes.json();
    const rows = [];
    rows.push(`<p class="muted">打开面板只查询，不会触发模型调用、记忆写入或换窗。</p>`);
    rows.push(`<div class="rec-section"><h4>模型与窗口</h4>
      <div>模式：${s.driver === 'openrouter' ? 'OpenRouter' : s.driver === 'deepseek' ? 'DeepSeek 官方直连' : s.driver === 'claude-agent-sdk' ? 'Claude Agent SDK' : s.driver}　型号：${s.exactModel ?? '未配置'}</div>
      <div>当前窗口：${s.epochId ?? '无'}</div></div>`);
    rows.push(`<div class="rec-section"><h4>上下文容量</h4>
      <div>当前输入估计：${fmtNum(s.context.estimatedInput)}（${s.context.estimateQuality}）　上次实际：${fmtNum(s.context.lastActualInput)}</div>
      <div>有效软线 ${fmtNum(s.context.effectiveSoft)}${s.context.hardCapacity == null ? '（模型容量未测量——不画百分比）' : ` / 硬容量 ${fmtNum(s.context.hardCapacity)}`}</div></div>`); // WP5：预警线展示已退役
    rows.push(`<div class="rec-section"><h4>记忆与换窗</h4>
      <div>最近检查：${s.review ? `${s.review.status}${s.review.decision ? `（${s.review.decision === 'no_new_hold' ? '零新增' : `已完成 hold ${s.review.holdCount ?? 0} 条`}）` : ''}${s.review.rangeCount != null ? `　范围 ${s.review.rangeCount} 条` : ''}${s.review.isCurrentWindow ? '' : '（上一窗口的结果，换窗不抹去）'}` : '还没有检查过'}</div>
      <div>书签位置：${s.bookmark ? `已见到第 ${s.bookmark.seenSequence} 条（${fmtTime(s.bookmark.updatedAt)}）` : '本房间还没有成功 hold 书签'}</div>
      <div>未新增 hold 是正常状态，不是漏记。</div></div>`);
    rows.push(`<div class="rec-section"><h4>原文同步</h4>
      <div>状态：${{ saved_pending_sync: '已保存，待同步', synced: '已同步 Mariposa', failed: '有失败项（需处理）', partial: '部分', unknown: '未知' }[s.rawSync.state] ?? s.rawSync.state}${s.rawSync.enabled ? '' : '（归档未启用——原文仍完整保存在本地）'}</div>
      <div>已同步 ${s.rawSync.acked} / 待 ${s.rawSync.pending} / 失败 ${s.rawSync.failed}</div>
      <div>最近记忆写入：${(s.holdEffects ?? []).length === 0 ? '（尚无）' : (s.holdEffects ?? []).map((h) => `${h.state === 'committed' && h.verified ? `已提交 ${h.memoryId ?? ''}` : h.state}${h.bindingDetail === 'not_recorded_locally' ? '（绑定明细本地未留痕，按单号在 Mariposa 核对）' : ''}`).join('；')}</div></div>`);
    const ttlLabel = s.cache.requestedTtl === 'auto' ? '自动缓存（DS：无显式 TTL 参数，命中看观测）' : '1h';
    rows.push(`<div class="rec-section"><h4>缓存与费用</h4>
      <div>缓存策略：${ttlLabel}　保温：未启用${s.cache.estimatedExpiresAt ? `　估计热至 ${fmtTime(s.cache.estimatedExpiresAt)}` : ''}</div>
      <div>上次读缓存：${fmtNum(s.cache.lastRead)}　写缓存：${fmtNum(s.cache.lastWrite)}（观测于 ${fmtTime(s.cache.observedAt)}）</div>
      <div>最近费用：${typeof s.cache.lastCostUsd === 'number' ? `$${s.cache.lastCostUsd}` : '未知'}（按请求报告值；无数据不编数）</div>
      <div>今日费用（${s.usageDay ?? '上海日'}，按用途）：${(s.usageByPurpose ?? []).map((u) => `${esc(String(u.purpose))} ${u.knownCostUsd === null ? '—' : `$${u.knownCostUsd}`}（${u.count} 次${u.unknownCount > 0 ? `，另有 ${u.unknownCount} 次费用未知` : ''}）`).join('　') || '无记录'}</div>
      <div>“配置的策略”与“观测到缓存读取”是两回事；无观测时不显示命中。</div></div>`);
    // F21：最新在最上；按 eventId 去重（SSE 刷新重拉不重复追加）；事件带关键事实（F22）
    seenEventIds.clear();
    const evRows = (ev.events ?? []).slice().reverse().filter((e) => (seenEventIds.has(e.eventId) ? false : seenEventIds.add(e.eventId)))
      .map((e) => {
        const label = { 'archive.sync': '原文同步', 'context.warning': '上下文提示', 'review.sent': '换窗检查', 'review.failed': '检查失败', 'window.rotated': '已换窗' }[e.kind] ?? e.kind;
        const p = e.payload ?? {};
        const detail = e.kind === 'archive.sync' ? `：${p.state ?? ''}${p.messages ? ` ${p.messages} 条` : ''}`
          : e.kind === 'context.warning' ? `：${p.note ?? p.code ?? ''}`
          : e.kind === 'review.sent' ? `：关注 ${p.focus_count ?? '?'} 条`
          : e.kind === 'window.rotated' ? `：${p.reason === 'manual' ? '手动' : p.reason === 'manual-stale-context' ? '手动（身份/上下文已变化）' : p.reason === 'capacity' ? '容量' : String(p.reason)}${p.review_id ? '（检查通过）' : ''}`
          : '';
        return `<div class="rec-event">${fmtTime(e.occurredAt)}　${esc(label)}${esc(detail)}</div>`;
      }).join('');
    body.dataset.prevCursor = ev.prevCursor ?? '';
    const olderBtn = ev.prevCursor ? `<button id="records-older" class="ghost" style="margin-top:6px">加载更早</button>` : '';
    // R17（复审 2026-10-07）：结构 HTML 不再整段转义——动态内容（label/detail）
    // 已逐段 esc；此前 esc(evRows)/esc(olderBtn) 把事件行和按钮转义成文字，
    // records-older 按钮从未真实存在
    rows.push(`<div class="rec-section"><h4>最近事件</h4>${evRows || '<div class="muted">暂无</div>'}${olderBtn}</div>`);
    body.innerHTML = rows.join('');
  } catch (err) {
    body.innerHTML = '<p class="error">记录加载失败（可重试；不影响聊天）</p>';
    console.error(err);
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
  clearTimeout(state.routeCloseTimer); // F18：上一张票据的关闭计时器必须核销，不得关掉新票据的弹窗
  state.routeCloseTimer = null;
  const target = data.target_model ?? '未知（平台未给出目标模型）';
  $('route-detail').textContent =
    `本轮模型请求被平台标记为可能切换路由。目标模型：${target}。是否已切换：${data.already_switched ? '是' : '否/未知'}。` +
    `「同意本次路由」暂不可用（平台级路由动作未验证）；请选择"重新编辑"（更新原消息 revision+1，不新建消息）或"取消"。`;
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
  // F18：无已验证的继续动作——点击前明确告知不支持，不发请求、不消耗票据
  $('route-detail').textContent = '「同意本次路由」暂不可用：平台级路由动作未经验证，宿主不会执行任何切换。请选择"重新编辑"或"取消"。';
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
  composer.value = state.pendingRouteEdit.original;
  state.draftRevision = draftGuard.touch();
  $('route-dialog').close(); // 票据仍 pending，直到修订发送成功
  setRoomBadge('编辑模式：修改后点"重新发送（修订）"');
  refreshSendButton();
  composer.focus();
};

// —— 启动（AUD-34：messages + reasoning 全量回看）——
async function boot() {
  if (state.authorized || state.booting || state.authRedirecting) return;
  state.booting = true;
  $('retry-connection-btn').hidden = true;
  $('runtime-badge').textContent = '连接中…';
  try {
    if (!(await tryResume()) || state.authRedirecting) return;
    // R20（复审 2026-10-07）：初次加载=最新一页（order=latest），"加载更早"向前
    // 游标才成立——此前默认取最早 500 条，before=最早序号 永远翻 0 条
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/messages?limit=500&order=latest`, { credentials: 'same-origin' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.messages)) throw new Error('Invalid messages response');
    if (state.authRedirecting) return;
    const turnIds = new Set();
    for (const m of data.messages) { absorbMessage(m); if (m.turn_id) turnIds.add(m.turn_id); }
    state.authorized = true;
    $('records-btn').hidden = false;
    $('alerts-btn').hidden = false;
    $('chat').hidden = false;
    void refreshAlertSummary();
    // F-J-48：满页说明可能有更早历史——露出"加载更早"入口（不足一页时隐藏由点击后处理）
    if (data.messages.length >= 500 && !$('load-earlier-btn')) {
      const btn = document.createElement('button');
      btn.id = 'load-earlier-btn';
      btn.textContent = '加载更早的消息';
      btn.onclick = () => void loadEarlier();
      $('timeline').before(btn);
    }
    // 回看思考摘要（AUD-34）：不依赖 SSE 当时在线
    for (const turnId of turnIds) {
      try {
        const r = await fetch(`/api/v1/turns/${turnId}/reasoning`, { credentials: 'same-origin' });
        if (r.status === 401) { redirectToLogin(); return; }
        if (r.ok) {
          const rd = await r.json();
          for (const block of rd.blocks) renderReasoningBlock(block);
        }
        const u = await fetch(`/api/v1/turns/${turnId}/usage`, { credentials: 'same-origin' });
        if (u.status === 401) { redirectToLogin(); return; }
        if (u.ok) renderUsage(turnId, await u.json());
      } catch { /* 单 turn 失败不影响整体 */ }
    }
    const rt = await fetch(`/api/v1/conversations/${CONVERSATION}/runtime`, { credentials: 'same-origin' });
    if (rt.status === 401) { redirectToLogin(); return; }
    if (!rt.ok) throw new Error(`HTTP ${rt.status}`);
    if (rt.ok) {
      const runtime = await rt.json();
      state.reasoningLabel = runtime.reasoning_label ?? '思考';
      if (runtime.identity?.state === 'READY' && !runtime.runner?.blocked) setRoomBadge(null);
      else { const badge = $('runtime-badge'); badge.textContent = '模型通道未就绪（可聊天保存，暂不回复）'; badge.className = 'badge warn'; }
    }
    if (state.authRedirecting) return;
    connectSse();
    refreshSendButton();
    composer.focus();
    void loadRuntimeSettings();
  } catch (err) {
    if (state.authRedirecting) return;
    state.authorized = false;
    state.sse?.close();
    state.sse = null;
    $('runtime-badge').textContent = '连接失败';
    $('retry-connection-btn').hidden = false;
    console.error(err);
  } finally {
    state.booting = false;
  }
}

function scrollBottom(force = false) {
  const timeline = $('timeline');
  if (!timeline || state.loadingEarlier) return;
  if (force) state.pinnedToBottom = true;
  if (!state.pinnedToBottom) return;
  timeline.scrollTop = timeline.scrollHeight;
}

function resizeComposer() {
  if (!composer.style || typeof composer.scrollHeight !== 'number') return;
  const viewportHeight = typeof window !== 'undefined' ? (window.visualViewport?.height ?? window.innerHeight ?? 512) : 512;
  const cap = Math.max(42, Math.min(128, viewportHeight * 0.25));
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(cap, Math.max(42, composer.scrollHeight))}px`;
  composer.style.overflowY = composer.scrollHeight > cap ? 'auto' : 'hidden';
}

function installViewportHandling() {
  if (typeof window === 'undefined') return;
  const timeline = $('timeline');
  let previousHeight = timeline?.clientHeight;
  let previousContentHeight = timeline?.scrollHeight;
  const preserveScroll = () => {
    scrollBottom();
    previousHeight = timeline?.clientHeight;
    previousContentHeight = timeline?.scrollHeight;
  };
  timeline?.addEventListener('scroll', () => {
    if (timeline.clientHeight !== previousHeight || timeline.scrollHeight !== previousContentHeight) { preserveScroll(); return; }
    if (!state.loadingEarlier) state.pinnedToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
  }, { passive: true });
  timeline?.addEventListener('wheel', (event) => { if (event.deltaY < 0) state.pinnedToBottom = false; }, { passive: true });
  let touchY = null;
  timeline?.addEventListener('touchstart', (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  timeline?.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY;
    if (touchY != null && y > touchY + 2) state.pinnedToBottom = false;
    touchY = y ?? touchY;
  }, { passive: true });
  const updateViewport = () => {
    const viewport = window.visualViewport;
    // 缩放时保留浏览器的自然行为，避免缩放被错误识别成键盘。
    if (viewport && viewport.scale != null && viewport.scale !== 1) return;
    const height = viewport?.height ?? window.innerHeight;
    document.documentElement?.style?.setProperty?.('--app-height', `${height}px`);
    document.documentElement?.style?.setProperty?.('--app-offset-top', `${viewport?.offsetTop ?? 0}px`);
    const shell = $('app-shell');
    if (shell?.dataset) shell.dataset.keyboard = String(Boolean(viewport && window.innerHeight - viewport.height > 120 && document.activeElement === composer));
    resizeComposer();
    preserveScroll();
  };
  window.addEventListener?.('resize', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', updateViewport, { passive: true });
  composer.addEventListener('focus', updateViewport);
  composer.addEventListener('blur', updateViewport);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(preserveScroll);
    if (timeline) observer.observe(timeline);
    if (timelineContent()) observer.observe(timelineContent());
  }
  updateViewport();
  resizeComposer();
}

// 仅使用本地固定图标路径；消息、模型名称等外部文本不得进入 SVG markup。
function setActionIcon(button, icon, label) {
  const paths = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>',
    select: '<path d="m3 6 2 2 3-3m-5 11 2 2 3-3M12 6h9M12 12h9M12 18h9"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Z"/><path d="m13 6 5 5"/>',
  };
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon] ?? ''}</svg>`;
}
function messageAction(icon, label, className) {
  const button = document.createElement('button');
  button.className = `message-action ${className}`;
  setActionIcon(button, icon, label);
  return button;
}
// —— 2026-10-08 她裁定：聊天窗内置换模型/思考深度（UI 美化她统一后改） ——
const runtimeBar = { el: null, modelInput: null, modelApply: null, effortSel: null, note: null, loaded: false, driver: null };

async function loadRuntimeSettings() {
  try {
    const res = await fetch('/api/v1/runtime-settings', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    runtimeBar.driver = data.driver ?? null;
    ensureRuntimeBar(data);
    const isOpenRouter = runtimeBar.driver === 'openrouter';
    const driverLabel = { openrouter: 'OpenRouter', deepseek: 'DeepSeek 官方直连', 'claude-agent-sdk': 'Claude Agent SDK' }[runtimeBar.driver] ?? '模型通道未知';
    if (runtimeBar.modelInput) runtimeBar.modelInput.disabled = !isOpenRouter;
    if (runtimeBar.modelApply) runtimeBar.modelApply.disabled = !isOpenRouter;
    if (runtimeBar.effortSel) runtimeBar.effortSel.disabled = !isOpenRouter;
    let model = isOpenRouter ? data.or_model?.effective : null;
    // runtime-settings 的 or_model 始终是 OR 配置，不能冒充其他驱动的实际模型。
    if (!isOpenRouter) {
      try {
        const context = await fetch(`/api/v1/conversations/${CONVERSATION}/context-records`, { credentials: 'same-origin' });
        if (context.status === 401) { redirectToLogin(); return; }
        if (context.ok) { const snapshot = await context.json(); if (snapshot.driver === runtimeBar.driver) model = snapshot.exactModel ?? null; }
      } catch { /* 没有实际型号证据时显示未知，不回落 OR 配置 */ }
    }
    const modelLabel = $('model-label');
    if (modelLabel) modelLabel.textContent = isOpenRouter
      ? [model ?? '模型未配置', data.reasoning_effort?.effective ?? data.reasoning_effort?.override].filter(Boolean).join(' · ')
      : `${driverLabel} · ${model ?? '型号未知'}`;
    if (runtimeBar.note) runtimeBar.note.textContent = isOpenRouter
      ? '切模型→下一条消息等你选历史后换窗；切思考→立即生效不换窗'
      : `当前使用${driverLabel}。这里的模型与思考设置仅适用于 OpenRouter。`;
    if (runtimeBar.modelInput) {
      runtimeBar.modelInput.value = isOpenRouter ? data.or_model?.override ?? '' : model ?? '';
      runtimeBar.modelInput.placeholder = model ? `当前：${model}` : '型号未知';
      const dl = document.getElementById('model-options');
      if (dl) {
        dl.innerHTML = '';
        for (const m of isOpenRouter ? data.model_options || [] : []) {
          const opt = document.createElement('option');
          opt.value = m;
          dl.appendChild(opt);
        }
      }
    }
    if (runtimeBar.effortSel) {
      runtimeBar.effortSel.innerHTML = '';
      runtimeBar.effortSel.title = !isOpenRouter ? '由当前模型通道管理，不能通过 OpenRouter 设置修改' : data.effort_options_verified === false ? '模型档位元数据暂不可达——清单未验证，个别档位可能被模型拒绝' : '按当前模型支持的档位生成';
      for (const e of isOpenRouter ? data.effort_options || ['default'] : ['default']) {
        const o = document.createElement('option');
        o.value = e;
        o.textContent = !isOpenRouter ? '思考深度：由当前通道管理' : e === 'default' ? '思考深度：默认' : `思考：${e}`;
        runtimeBar.effortSel.appendChild(o);
      }
      runtimeBar.effortSel.value = isOpenRouter ? data.reasoning_effort?.override ?? 'default' : 'default';
      void data.effort_options_verified;
    }
    runtimeBar.loaded = true;
  } catch { /* 面板未就绪时静默（boot 会重试一次） */ }
}

function ensureRuntimeBar(data) {
  if (runtimeBar.el) return;
  const timeline = document.getElementById('timeline');
  if (!timeline || !document.body) return;
  const bar = document.createElement('div');
  bar.id = 'runtime-settings-bar';
  bar.className = 'runtime-settings-bar';
  const label = document.createElement('span');
  label.textContent = '模型';
  runtimeBar.modelInput = document.createElement('input');
  runtimeBar.modelInput.setAttribute('list', 'model-options');
  runtimeBar.modelInput.className = 'runtime-model-input';
  runtimeBar.modelInput.setAttribute('aria-label', '模型 ID');
  runtimeBar.modelInput.placeholder = data?.or_model?.effective ? `当前：${data.or_model.effective}（清空=回落默认）` : '模型 ID（清空=回落默认）';
  const dl = document.createElement('datalist');
  dl.id = 'model-options';
  runtimeBar.effortSel = document.createElement('select');
  runtimeBar.effortSel.className = 'runtime-effort-select';
  runtimeBar.effortSel.setAttribute('aria-label', '思考深度');
  runtimeBar.note = document.createElement('span');
  runtimeBar.note.className = 'runtime-note';
  runtimeBar.note.textContent = '切模型→下一条消息等你选历史后换窗；切思考→立即生效不换窗';
  const modelBtn = document.createElement('button');
  runtimeBar.modelApply = modelBtn;
  modelBtn.textContent = '换模型';
  modelBtn.className = 'runtime-apply';
  modelBtn.onclick = async () => {
    if (runtimeBar.driver !== 'openrouter') return;
    const v = (runtimeBar.modelInput.value || '').trim();
    if (v && !window.confirm(`切换到 ${v}？运行边界变化——下一条消息会等你选历史后开新窗。`)) return;
    const res = await fetch('/api/v1/runtime-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ or_model: v || null }),
    });
    if (res.ok) { const d = await res.json(); state.estimate.modelSnapshotId = null; state.estimate.inFlight = null; window.alert(`模型已设：${d.or_model.effective ?? '（回落默认）'}`); await loadRuntimeSettings(); scheduleEstimate(); }
    else { const e = await res.json().catch(() => ({})); window.alert(`设置失败：${e?.error?.message ?? res.status}`); }
  };
  runtimeBar.effortSel.onchange = async () => {
    if (runtimeBar.driver !== 'openrouter') return;
    const v = runtimeBar.effortSel.value;
    const res = await fetch('/api/v1/runtime-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ reasoning_effort: v }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); window.alert(`设置失败：${e?.error?.message ?? res.status}`); }
    void loadRuntimeSettings();
  };
  bar.appendChild(label); bar.appendChild(runtimeBar.modelInput); bar.appendChild(dl); bar.appendChild(modelBtn);
  bar.appendChild(runtimeBar.effortSel); bar.appendChild(runtimeBar.note);
  const settingsHost = $('runtime-settings-host');
  if (settingsHost) settingsHost.appendChild(bar);
  else { const host = timeline.parentNode ?? document.body; host.insertBefore(bar, timeline); }
  runtimeBar.el = bar;
}

// —— WP3（2026-10-08 她裁定）：人工历史选集——换窗携带哪些历史由她勾选 ——
// 实现约束：不依赖 innerHTML/querySelector（VM 测试桩无这些能力），
// 全部 createElement/appendChild 组装；无 body 的环境（测试桩）自动跳过。
const selection = { active: false, ids: new Set(), windowId: null, idempotencyKey: null };
const selectionBar = { el: null, toggle: null, info: null, preview: null, confirm: null, empty: null, clear: null };

async function activeWindowId() {
  const rt = await fetch(`/api/v1/conversations/${CONVERSATION}/runtime`, { credentials: 'same-origin' });
  if (!rt.ok) return null;
  const data = await rt.json();
  return (data.active_window && data.active_window.id) || null;
}

// WP-03（2026-10-09，JFA-009/B02）：无活动窗时取 awaiting 选集行的
// source_window_id（csel-src-* 哨兵源是后端认可的 preview/confirm 目标）
async function awaitingSelectionWindowId() {
  const res = await fetch(`/api/v1/conversations/${CONVERSATION}/context-selection`, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data.selection && data.selection.source_window_id) || null;
}

// 选集目标窗：活动窗优先；无活动窗回落 awaiting 选集行——存量历史+
// 无 ACTIVE 窗（CONTEXT_SELECTION_REQUIRED）不再死锁；都没有=真首窗
async function selectionAnchorWindowId() {
  const active = await activeWindowId();
  if (active) return active;
  return awaitingSelectionWindowId();
}

function mkSelBtn(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function ensureSelectionBar() {
  if (selectionBar.el) return selectionBar.el;
  const existing = document.getElementById('selection-bar');
  if (existing) { selectionBar.el = existing; return existing; }
  const bar = document.createElement('div');
  bar.id = 'selection-bar';
  selectionBar.toggle = mkSelBtn('选历史', toggleSelection);
  selectionBar.info = document.createElement('span');
  selectionBar.info.className = 'selection-info';
  selectionBar.preview = mkSelBtn('预览', previewSelection);
  selectionBar.confirm = mkSelBtn('确认换窗', () => confirmSelection(false));
  selectionBar.empty = mkSelBtn('不带历史（明确空选）', () => { if (window.confirm('确认新窗不带任何历史？（明确空选是你本人的显式选择）')) confirmSelection(true); });
  selectionBar.clear = mkSelBtn('清空', () => { selection.ids.clear(); rerenderSelection(); });
  bar.appendChild(selectionBar.toggle);
  bar.appendChild(selectionBar.info);
  bar.appendChild(selectionBar.preview);
  bar.appendChild(selectionBar.confirm);
  bar.appendChild(selectionBar.empty);
  bar.appendChild(selectionBar.clear);
  // 挂载：body 可用则挂 body；否则（无 DOM 宿主）本模块整体保持惰性
  const host = $('selection-host') || $('chat') || document.body || document.getElementById('timeline');
  if (host && typeof host.appendChild === 'function') host.appendChild(bar);
  else return null;
  selectionBar.el = bar;
  updateSelectionBar();
  return bar;
}

function toggleSelection() {
  selection.active = !selection.active;
  selection.ids.clear();
  // B12：幂等键在选集会话内生成一次，confirm 复用（双击/网络重试同键 200 幂等）
  selection.idempotencyKey = selection.active ? `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;
  void selectionAnchorWindowId().then((id) => { selection.windowId = id; updateSelectionBar(); });
  rerenderSelection();
}

function rerenderSelection() {
  if (selectionBar.el || document.body) ensureSelectionBar();
  if (!selectionBar.el) return;
  for (const dto of state.messages.values()) renderMessage(dto, { update: true });
  updateSelectionBar();
}

function updateSelectionBar() {
  if (!selectionBar.el) return;
  const on = selection.active;
  selectionBar.el.hidden = !on;
  selectionBar.toggle.textContent = on ? '退出选择' : '选历史';
  selectionBar.preview.hidden = !on;
  selectionBar.confirm.hidden = !on;
  selectionBar.empty.hidden = !on;
  selectionBar.clear.hidden = !(on && selection.ids.size > 0);
  selectionBar.info.textContent = on
    ? `已选 ${selection.ids.size} 条——勾选要带进下一个窗口的历史；不勾并确认空选=明确不带历史`
    : '换窗前在这里勾选新窗要携带的历史原文';
}

async function selectionItems() {
  const items = [];
  for (const dto of state.messages.values()) {
    if (selection.ids.has(dto.id)) items.push({ message_id: dto.id, revision: dto.revision.revision, content_hash: dto.revision.content_hash });
  }
  return items;
}

async function previewSelection() {
  // JFA-009/B02：无活动窗时回落 awaiting 选集行（哨兵源可 preview）
  selection.windowId = await selectionAnchorWindowId();
  if (!selection.windowId) { window.alert('当前无活动窗口，也没有待确认的历史选集——发送第一条消息产生窗口后再选择'); return; }
  const res = await fetch(`/api/v1/windows/${selection.windowId}/context-selection/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ conversation_id: CONVERSATION, items: await selectionItems() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { window.alert(`核验未通过：${(data && data.error && data.error.code) || res.status}\n${JSON.stringify((data && data.error && data.error.detail) || {}, null, 1).slice(0, 500)}`); return; }
  const p = data.preview || {};
  const gaps = (p.gaps || []).map((g) => `seq ${g.after_seq}→${g.before_seq} 之间略过 ${g.skipped} 条`).join('；');
  window.alert(`已选 ${p.count} 条（粗估 ${p.estimated_tokens} token / 上限 ${p.capacity_bound_tokens}${p.fits ? '' : `，超限 ${p.deficit_tokens}`}）${gaps ? `\n间隙：${gaps}` : ''}\n勾选的正文由服务端按真实修订装配；确认后才真正换窗。`);
}

async function confirmSelection(explicitEmpty) {
  // B12：confirm 时刷新重取目标窗（不沿用 toggle 时的快照——期间可能已换窗）
  selection.windowId = await selectionAnchorWindowId();
  if (!selection.windowId) { window.alert('当前无活动窗口，也没有待确认的历史选集——发送第一条消息产生窗口后再选择'); return; }
  const items = explicitEmpty ? [] : await selectionItems();
  if (!explicitEmpty && items.length === 0) { window.alert('未勾选任何消息：要么勾选，要么点"不带历史（明确空选）"——未提交不等于空选'); return; }
  if (!window.confirm(explicitEmpty ? '确认新窗不带任何历史？' : `确认携带已选 ${items.length} 条历史换窗？当前待回答消息会自动继续。`)) return;
  const res = await fetch(`/api/v1/windows/${selection.windowId}/context-selection/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ conversation_id: CONVERSATION, items, explicit_empty: explicitEmpty, idempotency_key: selection.idempotencyKey || `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { window.alert(`确认失败：${(data && data.error && data.error.code) || res.status}\n${JSON.stringify((data && data.error && data.error.detail) || {}, null, 1).slice(0, 500)}`); return; }
  const sel = (data && data.selection) || {};
  window.alert(sel.rotated ? `已确认并换窗（${sel.resumed || 0} 条待回答消息自动继续）` : '已确认（当前无待回答消息，下次换窗按此选集）');
  selection.active = false;
  selection.ids.clear();
  rerenderSelection();
}
if (typeof document !== 'undefined' && document.body) ensureSelectionBar();



// —— EXEC_V1 §05：系统异常红点 + 单条消息 token 预估（零模型调用；预估失败不禁发送）——
const ALERTS_PANEL_LIMIT = 50;

async function refreshAlertSummary() {
  const badge = $('alerts-badge');
  if (!badge) return;
  try {
    const res = await fetch('/api/v1/system-alerts/summary', { credentials: 'same-origin' });
    if (!res.ok) return;
    const s = await res.json();
    if (s.unread_anomaly_count > 0) { badge.textContent = String(s.unread_anomaly_count); badge.hidden = false; }
    else badge.hidden = true;
    if (state.alertsOpen) void renderAlertsList();
  } catch { /* 离线时红点保持现状；重连由 SSE/刷新再对齐 */ }
}

function fmtAlertItem(it) {
  const sev = { critical: '严重', warning: '警告', info: '提示' }[it.severity] ?? it.severity;
  const life = it.lifecycle === 'open' ? (it.unread ? '未读' : '待处理') : '已解决';
  const sum = it.safe_summary ?? {};
  const title = sum.title ?? sum.detail ?? it.code;
  const extra = [
    sum.action_taken ? `已采取：${sum.action_taken}` : null,
    sum.unknown_count != null ? `未知分量 ${sum.unknown_count}` : null,
    sum.count != null && Number(sum.count) > 1 ? `累计 ${sum.count} 次` : null,
  ].filter(Boolean).join(' · ');
  return `[${sev}] ${title}（${new Date(it.last_occurred_at).toLocaleString()} · ${life}${it.occurrence_count > 1 ? ` · 复发 ${it.occurrence_count} 次` : ''}）${extra ? `\n${extra}` : ''}`;
}

async function renderAlertsList() {
  const body = $('alerts-body');
  const readAllBtn = $('alerts-read-all');
  if (!body) return;
  try {
    const res = await fetch(`/api/v1/system-alerts?lifecycle=all&limit=${ALERTS_PANEL_LIMIT}`, { credentials: 'same-origin' });
    if (!res.ok) { body.innerHTML = '<p class="muted">系统通知暂不可用</p>'; return; }
    const page = await res.json();
    const div = document.createElement('div');
    div.innerHTML = '<p class="muted">已读不等于恢复；未解决的异常继续留在待处理。朋友圈未读、聊天未读、普通闹钟不在这里。</p>';
    for (const it of page.items ?? []) {
      const row = document.createElement('div');
      row.className = `alert-item sev-${it.severity}${it.lifecycle === 'resolved' ? ' resolved' : ''}`;
      row.textContent = fmtAlertItem(it);
      div.appendChild(row);
    }
    if ((page.items ?? []).length === 0) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '当前没有系统异常。'; div.appendChild(p); }
    if (page.has_more) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = `（还有更多，仅显示最近 ${ALERTS_PANEL_LIMIT} 条）`; div.appendChild(p); }
    body.replaceChildren(div);
    if (readAllBtn) readAllBtn.dataset.snapshot = JSON.stringify((page.items ?? []).map((i) => ({ alert_id: i.alert_id, seen_event_sequence: i.last_event_sequence })));
  } catch { body.innerHTML = '<p class="muted">系统通知暂不可用</p>'; }
}

// 空值守卫：测试 VM 的最小 DOM 可能没有这些元素（缺面板不崩聊天主链）
const alertsBtn = $('alerts-btn');
if (alertsBtn) alertsBtn.onclick = () => {
  state.alertsOpen = true;
  const panel = $('alerts-panel');
  if (panel) panel.hidden = false;
  void renderAlertsList();
};
const alertsClose = $('alerts-close');
if (alertsClose) alertsClose.onclick = () => { state.alertsOpen = false; const panel = $('alerts-panel'); if (panel) panel.hidden = true; };
const alertsReadAll = $('alerts-read-all');
if (alertsReadAll) alertsReadAll.onclick = async () => {
  const items = JSON.parse($('alerts-read-all').dataset.snapshot ?? '[]');
  if (!Array.isArray(items) || items.length === 0) return;
  // 只提交当前快照已返回的 ID 与 sequence——快照之后到达的新异常保持未读（§4 已读与恢复）
  const res = await fetch('/api/v1/system-alerts/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ items }),
  });
  if (res.ok) { await renderAlertsList(); await refreshAlertSummary(); }
  else { const e = await res.json().catch(() => ({})); window.alert(`标记已读失败：${e?.error?.message ?? res.status}`); }
};

function scheduleEstimate() {
  clearTimeout(state.estimate.timer);
  state.estimate.timer = setTimeout(() => void refreshEstimate(), 250); // policy-defaults token_estimates.debounce_ms
}

async function refreshEstimate() {
  const content = composer.value;
  const line = $('estimate-line');
  if (!line) return;
  const attachments = readyAttachments().map((a) => ({ asset_id: a.asset_id }));
  const attachmentSignature = JSON.stringify(attachments);
  if (!content.trim() && attachments.length === 0) { line.textContent = ''; const det = $('estimate-detail'); if (det) det.hidden = true; return; }
  const draftRevision = state.draftRevision;
  const flight = Symbol('est');
  state.estimate.inFlight = flight;
  try {
    const res = await fetch('/api/v1/token-estimates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ conversation_id: CONVERSATION, client_draft_revision: draftRevision, content, attachments, include_request_estimate: true }),
    });
    if (!res.ok) { line.textContent = '预计用量暂不可用'; return; } // 预估失败不禁发送（§9 末段）
    const data = await res.json();
    // TOKEN-04：只应用同时匹配 draft_revision/模型快照/附件指纹的响应——过期慢回包丢弃
    // 资产内容不可变：比对本地冻结的 asset IDs，服务端负责计算内容指纹。
    if (state.estimate.inFlight !== flight || attachmentSignature !== JSON.stringify(readyAttachments().map((a) => ({ asset_id: a.asset_id }))) || !shouldApplyEstimate(data, { draftRevision: state.draftRevision, modelSnapshotId: state.estimate.modelSnapshotId ?? data.model_snapshot_id, attachmentFingerprint: attachments.length ? data.attachment_fingerprint : null })) return;
    state.estimate.modelSnapshotId = data.model_snapshot_id;
    if (typeof data.chars_per_token === 'number' && data.chars_per_token > 0) state.estimate.charsPerToken = data.chars_per_token;
    const e = data.estimate ?? {};
    const mediaNote = e.message_media_tokens === null && (e.unknown_components ?? []).length ? ' · 图片用量待估' : '';
    line.textContent = `本条文字约 ${e.message_text_tokens ?? '?'} token${mediaNote}（粗估${e.model ? `，${e.model}` : ''}）`;
    const detail = $('estimate-detail');
    const dbody = $('estimate-detail-body');
    if (!detail || !dbody) return;
    const req = e.request_input_tokens != null
      ? `本次请求输入约 ${e.request_input_tokens} token（含历史、身份、工具与本条）`
      : `本次请求输入暂不可估${e.request_unavailable_reason === 'pending_selection' ? '（等待人工历史选集）' : ''}`;
    dbody.textContent = `${req}
回复输出上限 ${e.output_cap_tokens ?? '未知'}（后续工具续答/重试另计；不等于预计一定生成）
缓存部分占上下文；命中可能降低费用，无法预先保证。`;
    detail.hidden = false;
  } catch { line.textContent = '预计用量暂不可用'; }
}



// —— EXEC_V1 §03.5.3：附件上传队列（失败保留文字与未发附件；重试复用操作键；成功后只清本次草稿）——
const attachBtn = $('attach-btn');
const attachInput = $('attach-input');
const attachQueue = $('attach-queue');

function renderAttachQueue() {
  if (!attachQueue) return;
  attachQueue.replaceChildren();
  for (const a of state.attachments) {
    const item = document.createElement('div');
    item.className = 'attach-item';
    if (a.previewUrl) { const img = document.createElement('img'); img.src = a.previewUrl; img.alt = a.name; item.appendChild(img); }
    const label = document.createElement('span');
    label.textContent = a.status === 'uploading' ? `${a.name}：上传中…`
      : a.status === 'transcribing' ? '语音正在转文字…'
      : a.status === 'uncertain' ? '转写结果未确认，音频已保留'
      : a.status === 'failed' ? `${a.name}：${a.error || '未完成'}（点此重试）`
      : a.presentation === 'voice' ? '语音已就绪，点箭头发送' : a.name;
    item.appendChild(label);
    if (a.status === 'failed') {
      item.style.cursor = 'pointer';
      item.onclick = () => void uploadAttachment(a);
    }
    const rm = document.createElement('button');
    rm.className = 'ghost';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', `移除附件 ${a.name}`);
    rm.onclick = (event) => { event?.stopPropagation?.(); state.attachments = state.attachments.filter((x) => x !== a); if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); state.draftRevision = draftGuard.touch(); renderAttachQueue(); refreshSendButton(); scheduleEstimate(); };
    item.appendChild(rm);
    attachQueue.appendChild(item);
  }
}

async function uploadAttachment(a) {
  if (a.inFlight) return;
  a.inFlight = true;
  a.status = 'uploading';
  a.opKey = a.opKey ?? `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  renderAttachQueue();
  try {
    if (!a.asset_id) {
    const res = await fetch(`/api/v1/assets?purpose=${a.purpose}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': a.opKey },
      body: a.file,
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { a.status = 'failed'; a.error = data?.error?.message ?? res.status; renderAttachQueue(); return; }
    a.asset_id = data.asset_id;
    }
    if (a.presentation === 'voice') {
      a.status = 'transcribing';
      renderAttachQueue();
      const transcription = await fetch(`/api/v1/assets/${encodeURIComponent(a.asset_id)}/transcribe`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': a.transcribeKey ??= newClientMessageId() },
        body: JSON.stringify({ conversation_id: CONVERSATION }),
      });
      if (transcription.status === 401) { redirectToLogin(); return; }
      const result = await transcription.json().catch(() => ({}));
      if (!transcription.ok) {
        const uncertain = ['voice_transcription_unconfirmed', 'siren_outcome_unknown'].includes(result.error?.code);
        a.status = uncertain ? 'uncertain' : 'failed';
        a.error = result.error?.message || '语音转写未完成';
        if (!uncertain) a.transcribeKey = null;
        renderAttachQueue();
        refreshSendButton();
        return;
      }
    }
    a.status = 'ready';
  } catch { a.status = 'failed'; a.error = '网络暂不可用'; }
  finally { a.inFlight = false; }
  renderAttachQueue();
  refreshSendButton();
  scheduleEstimate();
}

if (attachBtn && attachInput) {
  attachBtn.onclick = () => { if ($('attach-menu')) togglePopover('attach-menu', 'attach-btn'); else attachInput.click(); };
  const receiveImages = (input) => {
    if (voiceInput.starting || voiceInput.recorder || state.attachments.some((a) => a.presentation === 'voice')) {
      setRoomBadge('请先发送或移除当前语音，再添加图片');
      input.value = '';
      return;
    }
    for (const f of input.files ?? []) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) {
        setRoomBadge('当前支持 PNG、JPEG、GIF、WebP 图片，请先转换格式');
        continue;
      }
      const presentation = 'image'; // 一期附件按钮=图片/贴纸文件（voice 录音入口属 M3 语音批）
      state.attachments.push({ file: f, name: f.name, presentation, purpose: 'chat_image', status: 'uploading', previewUrl: URL.createObjectURL(f) });
      void uploadAttachment(state.attachments[state.attachments.length - 1]);
    }
    input.value = '';
    state.draftRevision = draftGuard.touch();
    renderAttachQueue();
    refreshSendButton();
    scheduleEstimate();
  };
  attachInput.onchange = () => receiveImages(attachInput);
  const cameraInput = $('camera-input');
  if (cameraInput) cameraInput.onchange = () => receiveImages(cameraInput);
  for (const id of ['choose-image-btn', 'choose-file-btn']) if ($(id)) $(id).onclick = () => { closePopover('attach-menu', 'attach-btn'); attachInput.click(); };
  if ($('choose-camera-btn')) $('choose-camera-btn').onclick = () => { closePopover('attach-menu', 'attach-btn'); (cameraInput || attachInput).click(); };
}

// 新外观的入口全部接现有宿主能力；面板只展示真实查询结果。
function closePopover(panelId, buttonId) {
  const panel = $(panelId);
  if (panel) panel.hidden = true;
  if (buttonId) $(buttonId)?.setAttribute('aria-expanded', 'false');
}
function togglePopover(panelId, buttonId) {
  const panel = $(panelId);
  if (!panel) return false;
  const opening = panel.hidden;
  for (const [other, button] of [['model-panel', 'model-toggle'], ['more-menu', 'more-btn'], ['attach-menu', 'attach-btn'], ['context-panel', 'context-btn']]) if (other !== panelId) closePopover(other, button);
  panel.hidden = !opening;
  $(buttonId)?.setAttribute('aria-expanded', String(opening));
  return opening;
}

async function loadContextSummary() {
  const body = $('context-summary');
  if (!body) return;
  body.textContent = '正在读取上下文…';
  try {
    const res = await fetch(`/api/v1/conversations/${CONVERSATION}/context-records`, { credentials: 'same-origin' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error();
    const data = await res.json();
    const c = data.context ?? {};
    const known = typeof c.hardCapacity === 'number' && c.hardCapacity > 0 && typeof c.estimatedInput === 'number';
    const percent = known ? Math.round(c.estimatedInput / c.hardCapacity * 100) : null;
    body.textContent = `当前输入估计：${fmtNum(c.estimatedInput)} token\n上次实际输入：${fmtNum(c.lastActualInput)} token\n${known ? `上下文约占 ${percent}% · 容量 ${fmtNum(c.hardCapacity)} token` : '模型总容量未知，暂不显示百分比'}\n有效换窗软线：${fmtNum(c.effectiveSoft)} token`;
    const ring = $('context-ring-value');
    if (ring) {
      ring.style.opacity = known ? '1' : '0';
      if (known) ring.style.strokeDashoffset = String(50.265 * (1 - Math.min(1, Math.max(0, percent / 100))));
    }
    $('context-btn')?.setAttribute('aria-label', known ? `查看上下文，估计已用 ${percent}%` : '查看上下文，容量未知');
  } catch { body.textContent = '上下文暂不可用，请重新打开重试。'; }
}

async function loadWorkbench() {
  const body = $('workbench-body');
  if (!body) return;
  body.textContent = '正在读取任务…';
  try {
    const [tasksRes, runsRes] = await Promise.all([
      fetch(`/api/v1/background/tasks?conversation_id=${CONVERSATION}`, { credentials: 'same-origin' }),
      fetch(`/api/v1/background/runs?conversation_id=${CONVERSATION}`, { credentials: 'same-origin' }),
    ]);
    if (tasksRes.status === 401 || runsRes.status === 401) { redirectToLogin(); return; }
    if (!tasksRes.ok || !runsRes.ok) throw new Error();
    const [tasksData, runsData] = await Promise.all([tasksRes.json(), runsRes.json()]);
    body.replaceChildren();
    const kindLabels = { reminder: '提醒', autonomous: '自主任务', cache_keepalive: '缓存保温' };
    for (const [title, entries, isRun] of [['已设任务', tasksData.tasks ?? [], false], ['最近执行', runsData.runs ?? [], true]]) {
      const section = document.createElement('section');
      section.className = 'rec-section';
      const heading = document.createElement('h4'); heading.textContent = title; section.appendChild(heading);
      if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = isRun ? '暂无执行记录。' : '暂无已设任务。'; section.appendChild(empty); }
      for (const item of entries) {
        const row = document.createElement('div'); row.className = 'workbench-item';
        row.textContent = isRun
          ? `${kindLabels[item.kind] ?? item.kind} · ${item.state}${item.result_code ? ` · ${item.result_code}` : ''}\n${fmtTime(item.created_at)}${item.finished_at ? ` → ${fmtTime(item.finished_at)}` : ''}`
          : `${kindLabels[item.kind] ?? item.kind} · ${item.enabled ? '已启用' : '已停用'}\n下次：${fmtTime(item.next_due_at)}`;
        section.appendChild(row);
      }
      body.appendChild(section);
    }
    const refresh = document.createElement('button'); refresh.className = 'ghost'; refresh.textContent = '刷新'; refresh.onclick = () => void loadWorkbench(); body.appendChild(refresh);
  } catch { body.textContent = '任务暂不可用，请重新打开重试。'; }
}

if ($('model-toggle')) $('model-toggle').onclick = () => { if (togglePopover('model-panel', 'model-toggle')) void loadRuntimeSettings(); };
if ($('model-close')) $('model-close').onclick = () => closePopover('model-panel', 'model-toggle');
if ($('more-btn')) $('more-btn').onclick = () => togglePopover('more-menu', 'more-btn');
if ($('context-btn')) $('context-btn').onclick = () => { if (togglePopover('context-panel', 'context-btn')) void loadContextSummary(); };
if ($('context-close')) $('context-close').onclick = () => closePopover('context-panel', 'context-btn');
if ($('history-select-btn')) $('history-select-btn').onclick = () => { closePopover('more-menu', 'more-btn'); toggleSelection(); };
if ($('workbench-btn')) $('workbench-btn').onclick = () => { closePopover('more-menu', 'more-btn'); const panel = $('workbench-panel'); if (panel) panel.hidden = false; void loadWorkbench(); };
if ($('workbench-close')) $('workbench-close').onclick = () => { const panel = $('workbench-panel'); if (panel) panel.hidden = true; };
for (const id of ['records-btn', 'alerts-btn']) $(id)?.addEventListener('click', () => closePopover('more-menu', 'more-btn'));
if (typeof document.addEventListener === 'function') document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const [panel, button] of [['model-panel', 'model-toggle'], ['more-menu', 'more-btn'], ['attach-menu', 'attach-btn'], ['context-panel', 'context-btn']]) closePopover(panel, button);
});

const voiceInput = { recorder: null, stream: null, timer: null, started: 0, cancelled: false, starting: false, generation: 0 };

function showVoiceStatus(message, recording = false) {
  const status = $('voice-status');
  if (!status) return;
  status.hidden = !message;
  status.textContent = message;
  if (recording) {
    const cancel = document.createElement('button');
    cancel.className = 'ghost'; cancel.textContent = '取消录音';
    cancel.onclick = () => stopVoiceRecording(true);
    status.appendChild(cancel);
  }
}

function stopVoiceRecording(cancel = false) {
  voiceInput.generation++;
  voiceInput.cancelled = cancel;
  clearInterval(voiceInput.timer);
  voiceInput.timer = null;
  if (voiceInput.recorder?.state === 'recording') voiceInput.recorder.stop();
  else voiceInput.stream?.getTracks().forEach((track) => track.stop());
}

async function startVoiceRecording() {
  if (voiceInput.starting) return;
  if (voiceInput.recorder) { stopVoiceRecording(false); return; }
  if (state.attachments.length || state.pendingSend) { setRoomBadge('请先发送或移除当前附件，再开始录音'); return; }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showVoiceStatus('此浏览器暂不支持录音，请使用支持麦克风的 Safari 或浏览器。'); return;
  }
  voiceInput.starting = true;
  const generation = ++voiceInput.generation;
  refreshSendButton();
  try {
    const status = await fetch('/api/v1/voice/status', { credentials: 'same-origin' });
    if (status.status === 401) { redirectToLogin(); return; }
    const capability = await status.json().catch(() => ({}));
    if (generation !== voiceInput.generation || state.authRedirecting) return;
    if (!status.ok || !capability.available) { showVoiceStatus('语音服务尚未就绪，暂时可以输入文字。'); return; }
    const format = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!format) { showVoiceStatus('当前浏览器没有可用的录音格式。'); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== voiceInput.generation || state.authRedirecting || state.attachments.length) { stream.getTracks().forEach((track) => track.stop()); return; }
    voiceInput.stream = stream;
    voiceInput.cancelled = false;
    voiceInput.started = Date.now();
    const recorder = new MediaRecorder(stream, { mimeType: format });
    const chunks = [];
    let recordingError = '';
    voiceInput.recorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => {
      recordingError = '录音中断，请重新录制。';
      voiceInput.cancelled = true;
      stopVoiceRecording(true);
      showVoiceStatus(recordingError);
    };
    recorder.onstop = () => {
      clearInterval(voiceInput.timer);
      stream.getTracks().forEach((track) => track.stop());
      voiceInput.stream = null; voiceInput.recorder = null; voiceInput.timer = null;
      $('voice-btn')?.setAttribute('aria-label', '录制语音');
      $('voice-btn')?.setAttribute('aria-pressed', 'false');
      refreshSendButton();
      if (voiceInput.cancelled || state.authRedirecting) { showVoiceStatus(state.authRedirecting ? '' : recordingError); return; }
      const blob = new Blob(chunks, { type: format });
      if (!blob.size) { showVoiceStatus('没有录到音频，请重试。'); return; }
      const entry = { file: blob, name: '语音', presentation: 'voice', purpose: 'chat_voice', status: 'uploading' };
      state.attachments.push(entry);
      state.draftRevision = draftGuard.touch();
      showVoiceStatus('');
      renderAttachQueue();
      void uploadAttachment(entry);
    };
    recorder.start(1000);
    $('voice-btn')?.setAttribute('aria-label', '结束录音');
    $('voice-btn')?.setAttribute('aria-pressed', 'true');
    refreshSendButton();
    const tick = () => {
      const seconds = Math.floor((Date.now() - voiceInput.started) / 1000);
      showVoiceStatus(`录音中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · 再点麦克风结束`, true);
      if (seconds >= 120) stopVoiceRecording(false);
    };
    tick();
    voiceInput.timer = setInterval(tick, 500);
  } catch {
    voiceInput.stream?.getTracks().forEach((track) => track.stop());
    voiceInput.stream = null; voiceInput.recorder = null;
    showVoiceStatus('未能开始录音，请检查麦克风权限后重试。');
  } finally { voiceInput.starting = false; refreshSendButton(); }
}
if ($('voice-btn')) $('voice-btn').onclick = () => void startVoiceRecording();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => stopVoiceRecording(true));
}

installViewportHandling();

void boot;
boot();
