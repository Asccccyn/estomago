// server/routes/voice-stream.ts（P07.2 第七批b）：实时语音入口（NDJSON 流）。
// 自 server/http.ts 逐字搬迁：幂等接纳/取消代际/断线收口/原声取回与 oído 组合逐字保持
// （批次1 修复后的准备阶段取消语义在此正本）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, ClientBodyError } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';
import { sha256Hex } from '../../util/id.ts';
import { toSseDto } from './events.ts';

/** 语音快速观察（原声+转写→oído 快速通道；自 http.ts 逐字随迁——stream 与 transcribe 共用语义在此声明）。 */
async function quickVoiceObservation(d: RequestDeps, a: { assetId: string; bytes: Uint8Array; sha256: string; mime: string; transcript: string; signal?: AbortSignal }): Promise<string | null> {
  // 审计修复：signal 贯穿（oído 适配器已有 lifetime 合并机制，复用）；ingest 返回真实 receipt 先保留，再检查取消，禁止继续 analyze
  const receipt = await d.oido!.ingestVoice({ assetId: a.assetId, bytes: Buffer.from(a.bytes), sha256: a.sha256, mime: a.mime, transcript: { text: a.transcript, source: 'siren:call' }, timeoutMs: 6000, signal: a.signal });
  d.db.prepare('INSERT INTO oido_ingest_receipts(est_asset_id,content_sha256,oido_audio_id,deduplicated,ingested_at) VALUES (?,?,?,?,?) ON CONFLICT(est_asset_id) DO UPDATE SET oido_audio_id=excluded.oido_audio_id,deduplicated=excluded.deduplicated,ingested_at=excluded.ingested_at')
    .run(a.assetId, a.sha256, receipt.audioId, receipt.deduplicated ? 1 : 0, new Date().toISOString());
  if (a.signal?.aborted) throw Object.assign(new Error('CANCELLED_AFTER_INGEST'), { name: 'AbortError' });
  const result = await d.oido!.analyze({ assetId: a.assetId, waitMs: 600, idempotencyKey: `es-call-${a.assetId}`, timeoutMs: 4000, signal: a.signal }).catch((err: unknown) => { if (a.signal?.aborted) throw err; return null; });
  if (!result || (result.state !== 'ready' && result.state !== 'partial')) return null;
  const observations = (result as { observations?: Array<Record<string, unknown>> }).observations;
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const first = observations[0]!;
  const kind = String(first['kind'] ?? '观察');
  const value = first['value'] == null ? String(first['reason'] ?? '不可用') : `${first['value']}${first['unit'] ? ' ' + first['unit'] : ''}`;
  const text = `${kind}：${value}`.slice(0, 120);
  return text;
}

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
  //    失败不阻断通话（如实降级为纯文字轮）；快证据有界等待（≤600ms，未就绪不拖电话）。
  //    审计修复：取消不得被降级 catch 吞掉——每个异步操作返回后先复核请求存活再落副作用。
  const audioRef = typeof input.audio_ref === 'string' && /^siren:[A-Za-z0-9_-]{1,128}$/.test(input.audio_ref) ? input.audio_ref.slice('siren:'.length) : null;
  let attachment: { asset_id: string; presentation: 'voice' } | null = null;
  let transcriptText: string | null = null;
  if (audioRef && d.media && d.sirenCall) {
    try {
      const audio = await d.sirenCall.fetchVoiceAssetAudio(audioRef, { timeoutMs: 8000, signal: prepareAbort.signal });
      if (prepareAbort.signal.aborted) return; // 取消：接纳已收口，无后续副作用
      if (audio) {
        const asset = await d.media.saveBuffer({
          bytes: audio.bytes, purpose: 'chat_voice',
          operationId: `siren-call:${callId}:${turnKey}`,
          createdBy: 'siren-bridge', origin: 'import', originService: 'siren', originRef: audioRef,
        });
        if (prepareAbort.signal.aborted) return; // 资产已存（副作用如实保留）；不继续
        transcriptText = input.text;
        d.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,NULL,?,?) ON CONFLICT(asset_id) DO UPDATE SET derived_text=excluded.derived_text,updated_at=excluded.updated_at")
          .run(asset.id, conversationId, `siren:${callId}:${turnKey}`, asset.content_sha256, transcriptText, 'siren:call', new Date().toISOString(), new Date().toISOString());
        // 快证据（A14 语义：宿主消费，非模型工具轮）：有界等待；未就绪=不带，不回写不拖电话。
        // 审计修复：signal 贯穿 ingest/analyze；ingest 已返回真实 receipt 时先保留 receipt 再检查取消，
        // 禁止继续 analyze；取消不得被"快证据失败忽略"吞掉。
        if (d.oido?.configured) {
          try {
            const obs = await quickVoiceObservation(d, { assetId: asset.id, bytes: audio.bytes, sha256: asset.content_sha256, mime: audio.mime, transcript: input.text, signal: prepareAbort.signal });
            if (prepareAbort.signal.aborted) return; // receipt 已持久化；不提交正式消息
            if (obs) {
              const marked = `\n[声音观察（oído 快证据，非转写）：${obs}]`;
              d.db.prepare('UPDATE voice_transcripts SET derived_text=? WHERE asset_id=?').run(transcriptText + marked, asset.id);
              transcriptText = transcriptText + marked;
            }
          } catch (err) {
            if (prepareAbort.signal.aborted) return; // 取消不得被吞
            /* 快证据失败=不带（如实缺省） */
          }
        }
        d.media.validateForSend([{ asset_id: asset.id, presentation: 'voice' }]); // §5.2：附件先全量校验再入事务
        if (prepareAbort.signal.aborted) return; // 提交正式消息前再检查一次（操作期间存活的请求状态复核）
        attachment = { asset_id: asset.id, presentation: 'voice' };
      }
    } catch (err) {
      if (prepareAbort.signal.aborted) return; // 取消不得被"音频失败降级纯文字"吞掉
      /* 原声取回失败=纯文字轮（如实降级） */
    }
  }
  // 提交正式消息前最后复核（操作期间会变化的请求存活状态，非重复校验静态参数）
  if (prepareAbort.signal.aborted) return;

  const sub = d.messages.submitUserMessageWithTurn({
    conversationId: conversationId,
    content: attachment ? '' : input.text,
    clientMessageId: `voice:${callId}:${turnKey}`,
    occurredAt: new Date().toISOString(),
    ...(attachment ? { attachments: [attachment] } : {}),
  });
  estTurnId = sub.turnId; // 审计修复：turnId 接线到统一取消处理（此后断开→stop 该 turn）
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
        cleanup();
        return;
      } else if (row.kind === 'turn.interrupted') {
        emitSentences(true);
        send({ type: 'done', interrupted: true }); // 打断=已生成原文保留；作为完成流收口
        admissionClose('completed');
        cleanup();
        return;
      } else if (row.kind === 'turn.status') {
        const state = row['state'] as string | undefined;
        const reason = row['reason'] as string | undefined;
        if (state === 'failed') {
          send({ type: 'error', message: reason ?? 'turn failed' });
          admissionClose('failed');
          cleanup();
          return;
        }
      }
    }
  }, 25);
  d.supervisor.enqueue(sub.turnId);
}
