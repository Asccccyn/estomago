// server/routes/voice-stream.ts（P07.2 第七批b）：实时语音入口（NDJSON 流）。
// 自 server/http.ts 逐字搬迁：幂等接纳/取消代际/断线收口/原声取回与 oído 组合逐字保持
// （批次1 修复后的准备阶段取消语义在此正本）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, ClientBodyError } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';
import { sha256Hex } from '../../util/id.ts';
import { toSseDto } from './events.ts';

// ── R4（2026-10-23）：voice ingress——Siren CoreBridge 的同窗电话入口（NDJSON）──────────
// 合同（Siren packages/core-bridge/src/http-core-bridge.ts，逐字段对齐）：
//   POST /v1/chat/stream，content-type application/x-ndjson，body=单 JSON 对象
//   {conversation_id, call_id, turn_id, modality, text, interrupted_turn?{...}}
//   响应逐行 NDJSON：{"type":"delta","text"}* → {"type":"done"}；失败 {"type":"error","message"}
// B2 返修（2026-10-24，RE-02/03 + NDJSON_PLAN）：
//   - 正文=同一生成流真实新增（supervisor 语音抽头，与聊天落库同源、provider 速度）；
//     按句成帧（。！？!?…），取消代际内不再供给——拼接与聊天正本逐字一致、单句不必等整轮结束
//   - 幂等接纳 (call_id, turn_id)：同键同文已完成=重放终态回执（不再开模型/不再订未来事件）；
//     同键异文=409；在途重复=409；缺 call_id/turn_id=422（不再回落固定字面量）
//   - 断开=stop（含排队轮：CANCELLED_BEFORE_DISPATCH 不派发）；接纳行落确定终态
//   - 请求体走 readJson（限额+字节安全，分片 UTF-8 不破）；modality/interrupted_turn 入册
export async function handleVoiceChatStream(req: IncomingMessage, res: ServerResponse, d: RequestDeps): Promise<void> {
  const ndjsonError = (status: number, message: string): void => {
    try { res.writeHead(status, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ type: 'error', message }) + '\n'); } catch { /* 已断 */ }
  };
  const token = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  if (!token || !token.trim()) return ndjsonError(503, 'voice ingress not configured');
  const authz = String(req.headers.authorization ?? '');
  if (authz !== `Bearer ${token}`) return ndjsonError(401, 'unauthorized');
  let input: { conversation_id?: unknown; call_id?: unknown; turn_id?: unknown; modality?: unknown; text?: unknown; interrupted_turn?: unknown; audio_ref?: unknown };
  try {
    input = (await readJson(req, d, 256 * 1024)) as typeof input;
  } catch (err) {
    const status = err instanceof ClientBodyError ? err.status : 400;
    return ndjsonError(status, 'invalid body');
  }
  const idOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
  if (!idOk(input.conversation_id) || !idOk(input.call_id) || !idOk(input.turn_id)) {
    return ndjsonError(422, 'conversation_id, call_id and turn_id are required (1..128 chars)');
  }
  if (typeof input.text !== 'string' || input.text.length === 0) return ndjsonError(422, 'non-empty text required');
  if (input.modality !== undefined && input.modality !== 'voice' && input.modality !== 'voice_call') return ndjsonError(422, 'modality must be voice|voice_call');
  const conversationId: string = input.conversation_id;
  const callId: string = input.call_id;
  const turnKey: string = input.turn_id;
  const conv = d.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as { id: string } | undefined;
  if (!conv) return ndjsonError(404, 'conversation not found');

  // —— RE-03：幂等接纳（同窗提交仍走文字轮同一串行链/窗口工具/轨迹/计量）——
  const nowIso = new Date().toISOString();
  const textSha = sha256Hex(input.text);
  const prior = d.db.prepare('SELECT text_sha256, state FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get(callId, turnKey) as { text_sha256: string; state: string } | undefined;
  if (prior) {
    if (prior.text_sha256 !== textSha) return ndjsonError(409, 'idempotency conflict: same call/turn with different text');
    if (prior.state === 'completed' || prior.state === 'failed' || prior.state === 'cancelled') {
      // 完成重试：返回合同终态回执——不再开模型、不再订阅未来事件、不重播整段旧音频
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' });
      try { res.end(JSON.stringify({ type: 'done', replayed: true, prior_state: prior.state }) + '\n'); } catch { /* 已断 */ }
      return;
    }
    return ndjsonError(409, 'same call/turn already in flight');
  }
  d.db.prepare('INSERT INTO voice_stream_turns(call_id,turn_key,conversation_id,text_sha256,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(callId, turnKey, conversationId, textSha, 'admitted', nowIso, nowIso);
  // 通话登记：未显式 POST /v1/calls 时按首个电话轮自动立册（memory_only 以此为准；挂断由 DELETE /v1/calls 收口）
  if (!d.db.prepare('SELECT 1 FROM voice_calls WHERE call_id=?').get(callId)) {
    d.db.prepare("INSERT OR IGNORE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)").run(callId, conversationId, nowIso);
  }
  if (input.interrupted_turn !== undefined && (typeof input.interrupted_turn !== 'object' || input.interrupted_turn === null)) {
    return ndjsonError(422, 'interrupted_turn must be an object');
  }

  // —— 审计修复（电话准备阶段取消失效）：幂等接纳完成后、第一次音频异步操作之前，
  //    建立本请求的取消处理。响应**非正常关闭**（res.close 且 !writableEnded）=客户端断开；
  //    req.close 不再监听（正常请求体读取结束也可能产生该事件，旧实现把它一律当取消）。
  const prepareAbort = new AbortController();
  let estTurnId: string | null = null; // turnId 可为空：timer/voiceTap/事件订阅在流阶段才建立
  let clientGone = false;
  let streamingCleanup: (() => void) | null = null;
  const closeAdmission = (state: 'completed' | 'failed' | 'cancelled'): void => {
    d.db.prepare("UPDATE voice_stream_turns SET state=?, updated_at=? WHERE call_id=? AND turn_key=? AND state NOT IN ('completed','failed','cancelled')")
      .run(state, new Date().toISOString(), callId, turnKey);
  };
  const onClientGone = (): void => {
    if (clientGone) return;
    clientGone = true;
    prepareAbort.abort(new Error('client disconnected'));
    // 接纳记录非终态收口为 cancelled（同键重试返回原终态）；不新建取消轮，不顺手结束 voice_calls
    closeAdmission('cancelled');
    // 已有 turn 才停止（准备阶段 turnId 可为空）
    if (estTurnId) void d.supervisor.stop(estTurnId);
    // 流阶段资源（timer/voiceTap/事件订阅/响应）存在才释放；准备阶段无可释放
    if (streamingCleanup) streamingCleanup();
  };
  res.on('close', () => { if (!res.writableEnded) onClientGone(); });
  // 安装后立即检查连接是否已经销毁（极快断开的窗口）
  if (res.destroyed && !res.writableEnded) onClientGone();

  // —— 协议②（2026-10-24）：本轮用户原声——Siren 已按 audio_ref=siren:<asset_id> 落资产，
  //    est 取回字节存本地 chat_voice 资产并绑定为该消息附件（oído 快证据/按需深听可用）。
  //    失败不阻断通话（如实降级为纯文字轮）。JV-17（联合审计 2026-10-26，注释纠正）：
  //    600ms 只是 analyze 单段的等待窗——此前串行链还含原声取回/ingest/转写挂载，
  //    总准备耗时大于 600ms；不把本注释读成"全链≤600ms"承诺（总预算裁定待定）。
  //    审计修复：取消不得被降级 catch 吞掉——每个异步操作返回后先复核请求存活再落副作用。
  const audioRef = typeof input.audio_ref === 'string' && /^siren:[A-Za-z0-9_-]{1,128}$/.test(input.audio_ref) ? input.audio_ref.slice('siren:'.length) : null;
  let attachment: { asset_id: string; presentation: 'voice'; caption?: string | null } | null = null;
  let pendingObsAssetId: string | null = null;
  // A06（联合审计 2026-10-27）：深听的可选观察**不再在派发热路径等待**。原声就绪后立即提交
  // 正式消息（派发只带此刻已 ready 的观察——首轮为空），分析由既有持久 worker 单一驱动
  //（接纳即登记 pending+wake，同一 analysis 续查）；迟到结果只持久化/显示，不改已派发历史。
  // 不再保留后台快观察双驱动：等待参数/触发次数不制造重复分析任务。
  if (audioRef && d.media && d.sirenCall) {
    try {
      // R2-05（复审）：原声取回是**必要媒体保存**，不属可选观察
      const audio = await d.sirenCall.fetchVoiceAssetAudio(audioRef, { timeoutMs: 8000, signal: prepareAbort.signal });
      if (audio && !prepareAbort.signal.aborted) {
        const asset = await d.media.saveBuffer({
          bytes: audio.bytes, purpose: 'chat_voice',
          operationId: `siren-call:${callId}:${turnKey}`,
          createdBy: 'siren-bridge', origin: 'import', originService: 'siren', originRef: audioRef,
        });
        // 资产已存即先挂可信转写（同步），取消也能以"原声+转写"保存这句话
        d.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,NULL,?,?) ON CONFLICT(asset_id) DO UPDATE SET derived_text=excluded.derived_text,updated_at=excluded.updated_at")
          .run(asset.id, conversationId, `siren:${callId}:${turnKey}`, asset.content_sha256, input.text, 'siren:call', new Date().toISOString(), new Date().toISOString());
        d.media.validateForSend([{ asset_id: asset.id, presentation: 'voice' }]); // §5.2：附件先全量校验再入事务
        attachment = { asset_id: asset.id, presentation: 'voice' };
        const callMode = (d.db.prepare('SELECT analysis_mode FROM voice_calls WHERE call_id=?').get(callId) as { analysis_mode: string | null } | undefined)?.analysis_mode ?? 'ordinary';
        if (callMode === 'deep_listen' && d.voiceObservations && d.oido?.configured) {
          pendingObsAssetId = asset.id; // 接纳后登记持久观察任务（worker 驱动；ordinary 不登记）
        }
      }
    } catch {
      /* 原声取回/保存失败=纯文字轮（如实降级）；取消在下方统一收口，不被降级吞掉 */
    }
  }

  // 联合审计 A03：已接纳的 final 是已经发生的话语——准备阶段挂断只停止回复（零模型派发），
  // 不丢这句话：正式消息+归档 outbox 照常落库，turn 同事务落 failed 终态（不入队、启动恢复
  // 不再派发）；不登记观察、不触发回忆检索。同键重试仍返回 cancelled 终态回执。
  if (prepareAbort.signal.aborted) {
    const cancelled = d.messages.submitUserMessageWithTurn({
      conversationId,
      content: attachment ? '' : input.text,
      clientMessageId: `voice:${callId}:${turnKey}`,
      occurredAt: new Date().toISOString(),
      ...(attachment ? { attachments: [attachment] } : {}),
      cancelledBeforeDispatch: 'CANCELLED_BEFORE_DISPATCH',
    });
    d.db.prepare('UPDATE voice_stream_turns SET est_turn_id=?, updated_at=? WHERE call_id=? AND turn_key=?')
      .run(cancelled.turnId, new Date().toISOString(), callId, turnKey);
    const vmsg = d.messages.getMessage(cancelled.message.id);
    if (vmsg && !cancelled.duplicate) d.events.publish('message.persisted', { conversationId, turnId: cancelled.turnId, entityRef: vmsg.id, entityRevision: vmsg.sequence, payload: { message: vmsg } });
    return;
  }

  const sub = d.messages.submitUserMessageWithTurn({
    conversationId: conversationId,
    content: attachment ? '' : input.text,
    clientMessageId: `voice:${callId}:${turnKey}`,
    occurredAt: new Date().toISOString(),
    ...(attachment ? { attachments: [attachment] } : {}),
  });
  // JV-08（联合审计 2026-10-26）：语音接纳行统一发布普通消息入口的既有合同
  // （message.persisted/turn.started，防重判据与 conversations.ts 相同：kind+turn_id）
  // ——SDK driver 不触发 dispatch 补发时，用户语音消息不再"落库但页面刷新才可见"。
  {
    const vmsg = d.messages.getMessage(sub.message.id);
    if (vmsg && (d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('message.persisted', sub.turnId) as { n: number }).n === 0) {
      d.events.publish('message.persisted', { conversationId, turnId: sub.turnId, entityRef: vmsg.id, entityRevision: vmsg.sequence, payload: { message: vmsg } });
    }
    if ((d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('turn.started', sub.turnId) as { n: number }).n === 0) {
      d.events.publish('turn.started', { conversationId, turnId: sub.turnId, attemptId: sub.attemptId, payload: {} });
    }
  }
  estTurnId = sub.turnId; // 审计修复：turnId 接线到统一取消处理（此后断开→stop 该 turn）
  // A06：接纳即登记持久观察任务（worker 单一驱动，不带视图注入派发）；ordinary 不登记。
  if (pendingObsAssetId && attachment && d.voiceObservations && pendingObsAssetId === attachment.asset_id) {
    d.voiceObservations.recordCallTurnObservation(sub.message.id, 1, attachment.asset_id, null);
  }
  d.db.prepare("UPDATE voice_stream_turns SET est_turn_id=?, state='running', updated_at=? WHERE call_id=? AND turn_key=?")
    .run(sub.turnId, new Date().toISOString(), callId, turnKey);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' });
  const send = (obj: Record<string, unknown>): boolean => { try { return res.write(JSON.stringify(obj) + '\n'); } catch { return false; } };

  // —— RE-02：同一生成流的语音正文通道 ——
  // 行首学舌标记剥离与聊天发布层同规则；句级成帧（含无换行短句：完整句尾即发）；
  // 末尾残余在终态前冲刷。拼接==聊天正本（正常内容逐字一致）。
  let pending = '';
  let atLineStart = true;
  const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…']);
  const stripMarker = (t: string): string => t.replace(/^(\[seq ?\d+\]|\[\d+\])\s*/, '');
  const emitSentences = (flush: boolean): void => {
    for (;;) {
      const chars = [...pending];
      let cut = -1;
      for (let i = 0; i < chars.length; i++) {
        if (SENTENCE_END.has(chars[i]!)) cut = i + 1;
      }
      if (cut <= 0) break;
      let chunk = chars.slice(0, cut).join('');
      pending = chars.slice(cut).join('');
      if (atLineStart) chunk = stripMarker(chunk);
      atLineStart = chunk.endsWith('\n');
      if (chunk.length > 0) send({ type: 'delta', text: chunk });
    }
    if (flush && pending.length > 0) {
      let chunk = pending;
      pending = '';
      if (atLineStart) chunk = stripMarker(chunk);
      atLineStart = chunk.endsWith('\n');
      if (chunk.length > 0) send({ type: 'delta', text: chunk });
    }
  };
  const detachTap = d.supervisor.registerVoiceTap(sub.turnId, (tail) => {
    // 行边界维护：换行符原样保留（拼接与正本逐字一致）；行首标记按聊天发布层同规则剥离
    const lines = tail.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) { pending += '\n'; atLineStart = true; }
      const piece = lines[i]!;
      pending += atLineStart ? stripMarker(piece) : piece;
      if (piece.length > 0) atLineStart = false;
    }
    emitSentences(false);
  });

  const subEvents = d.events.subscribe(conversationId);
  let closed = false;
  // 审计修复：admissionClose 与 closeAdmission 同语义（统一收口）；cleanup 同步给准备阶段取消处理
  const admissionClose = closeAdmission;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pump);
    detachTap();
    d.events.unsubscribe(subEvents);
    try { res.end(); } catch { /* 已断 */ }
  };
  streamingCleanup = () => cleanup();
  // 审计修复：req.on('close') 删除——正常请求体读取结束也可能产生该事件，不得一律当取消；
  // 客户端断开由统一 res.close 处理（onClientGone：区分 writableEnded；已生成原文保留）
  const pump = setInterval(() => {
    if (closed) return;
    for (const queued of subEvents.queue.splice(0)) {
      const row = toSseDto(queued.eventRow);
      if (row.turn_id !== sub.turnId) continue;
      if (row.kind === 'turn.completed') {
        emitSentences(true);
        send({ type: 'done' });
        admissionClose('completed');
        d.callReplyLinks?.wake(); // A04：本轮助手回复的持久媒体关联（Siren 音频可能刚最终化；worker 幂等）
        cleanup();
        return;
      } else if (row.kind === 'turn.interrupted') {
        emitSentences(true);
        send({ type: 'done', interrupted: true }); // 打断=已生成原文保留；作为完成流收口
        admissionClose('completed');
        d.callReplyLinks?.wake();
        cleanup();
        return;
      } else if (row.kind === 'turn.status') {
        const state = row['state'] as string | undefined;
        const reason = row['reason'] as string | undefined;
        // RR-12（复审）：blocked 等确定拒绝终态也如实收口 NDJSON——客户端不等
        // Siren 60s 超时；completed/interrupted 口径不变。
        if (state === 'failed' || state === 'blocked') {
          send({ type: 'error', message: reason ?? (state === 'blocked' ? '模型能力暂不可用（blocked）' : 'turn failed') });
          admissionClose(state === 'blocked' ? 'failed' : 'failed');
          cleanup();
          return;
        }
      }
    }
  }, 25);
  d.supervisor.enqueue(sub.turnId);
}
