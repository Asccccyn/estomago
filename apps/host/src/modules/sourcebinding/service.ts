// 包2 批C（BIND-01..08，2026-11-16）：午夜来源绑定——为已提交记忆补可靠来源的后台任务。
// 落点（先行报告口径）：M 无任何调度设施，E 维护 tick 是两仓唯一现成调度点——任务与
// 处理状态唯一正本=E 的 source_bind_jobs 表；绑定写入只调 M 既有 source.binding.bind
// 领域服务（经 E mariposa client）。分批依据=E 侧 tool_side_effects 的 committed hold
// 事实（settle 时刻=提交侧时刻）；M 原生/导入路径的来源本轮无枚举能力，如实按
// "E 发起路径"范围报告，不宣称全量新增（BIND-01）。
// 日界固定 Asia/Shanghai 每日 00:00（BIND-02）：处理该时刻之前已成功提交且未处理的
// 新记忆；单条失败不阻塞其余；不唤醒char、不触发浮现、不写聊天气泡（BIND-06）。
import type { Db } from '../../db/connection.ts';
import type { Config } from '../../config/schema.ts';
import type { MariposaClient } from '../../integrations/mariposa/client.ts';
import type { GlmChatAdapter } from '../../integrations/glm/chat.ts';
import { genId } from '../../util/id.ts';

export type SourceBindBatchReport = {
  boundary: string; // 本批截止点（Asia/Shanghai 00:00 ISO）
  scope: 'est_tool_holds'; // 如实范围：E 工具发起的 hold（M 原生/导入待枚举能力）
  collected: number; inserted: number; processed: number;
  counts: Record<string, number>; // 各终态计数
  skipped: string[]; // 未处理原因（凭据缺失/未启用等）
};

type JobRow = {
  id: string; memory_id: string; memory_version: number | null; conversation_id: string | null;
  turn_id: string | null; batch_boundary: string; status: string; detail: string | null;
  binding_ids_json: string | null; pending_segments_json: string | null; attempts: number;
};

export class SourceBindingService {
  /** 可重试态的总尝试上限（含首次）：有界防无限付费（B08/B16）。 */
  static readonly MAX_ATTEMPTS = 4;
  private readonly deps: { db: Db; config: Config; mariposa: MariposaClient | null; glm: GlmChatAdapter | null; log: (level: 'info' | 'warn', event: string, fields?: Record<string, unknown>) => void; events?: { publish(kind: string, opts: { conversationId: string; turnId: string | null; scope: 'private'; payload: Record<string, unknown> }): unknown } | null };
  constructor(deps: SourceBindingService['deps']) { this.deps = deps; }

  get enabled(): boolean {
    return this.deps.config.source_binding.enabled && (this.deps.glm?.configured ?? false);
  }

  /** Asia/Shanghai 的上一个 00:00 边界（ISO，含 +08:00）——本批处理该点之前的提交。 */
  static lastBoundary(now = new Date()): string {
    const shanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const y = shanghai.getFullYear(), m = shanghai.getMonth(), d = shanghai.getDate();
    // 上海当日 00:00 对应的 UTC 时刻 = Date.UTC(y,m,d) - 8h
    const boundaryUtc = new Date(Date.UTC(y, m, d) - 8 * 3600_000);
    return boundaryUtc.toISOString();
  }

  /** 是否到了应跑下一批的时间（存在未收集的已提交 hold 或可重试任务，且过了上边界）。
   *  P1-4（Codex 审计 2026-11-16）：资格口径与领取查询一致——failed/source_unavailable
   *  在重试上限内同样触发 due，否则单独留存的失败任务永不重试（只有新 hold 才捎带）。 */
  dueNow(now = new Date()): boolean {
    if (!this.enabled) return false;
    const boundary = SourceBindingService.lastBoundary(now);
    const open = this.deps.db.prepare(
      `SELECT 1 FROM source_bind_jobs WHERE status IN ('pending','failed','source_unavailable') AND batch_boundary <= ? AND attempts < ? LIMIT 1`,
    ).get(boundary, SourceBindingService.MAX_ATTEMPTS);
    if (open) return true;
    // 返修 P1-4（Codex 复审）：凭据/余额阻塞的任务跨过日界即该跑（充值后自动恢复）；
    // 当日（batch_boundary=本日）不再触发——熔断不反复发起判断。
    const revive = this.deps.db.prepare(
      `SELECT 1 FROM source_bind_jobs WHERE status = 'credential_blocked' AND batch_boundary < ? LIMIT 1`,
    ).get(boundary);
    if (revive) return true;
    const uncollected = this.uncollectedHolds(boundary, 1);
    return uncollected.length > 0;
  }

  /** 截止点前已提交、且尚无任务行的 hold 事实（E 范围）。
   *  P1-9（Codex 审计）：B01 半开区间——提交时刻恰为边界点 00:00:00.000 的归下一批（旧 `<=` 会提前收走）。 */
  private uncollectedHolds(boundary: string, limit: number): Array<{ memory_id: string; conversation_id: string | null; turn_id: string | null; committed_at: string }> {
    return this.deps.db.prepare(
      `SELECT e.memory_id AS memory_id, t.conversation_id AS conversation_id, e.turn_id AS turn_id, e.updated_at AS committed_at
       FROM tool_side_effects e LEFT JOIN turns t ON t.id = e.turn_id
       WHERE e.kind = 'hold' AND e.state = 'committed' AND e.verified = 1 AND e.memory_id IS NOT NULL
         AND e.updated_at < ? AND e.memory_id NOT IN (SELECT memory_id FROM source_bind_jobs)
       ORDER BY e.updated_at ASC LIMIT ?`,
    ).all(boundary, limit) as Array<{ memory_id: string; conversation_id: string | null; turn_id: string | null; committed_at: string }>;
  }

  /** 收集+处理一批（幂等：任务行 UNIQUE(memory_id)，重复调用只处理 pending）。 */
  async runBatch(now = new Date()): Promise<SourceBindBatchReport> {
    const boundary = SourceBindingService.lastBoundary(now);
    const cfg = this.deps.config.source_binding;
    const report: SourceBindBatchReport = { boundary, scope: 'est_tool_holds', collected: 0, inserted: 0, processed: 0, counts: {}, skipped: [] };
    if (!this.deps.config.source_binding.enabled) { report.skipped.push('task_disabled'); return report; }
    if (!this.deps.glm || !this.deps.glm.configured) { report.skipped.push('glm_not_configured'); return report; }
    if (!this.deps.mariposa) { report.skipped.push('mariposa_unavailable'); return report; }

    // 返修 P1-4：凭据/余额阻塞的任务跨过上海日界自动复活（充值/换 key 后无需人工介入）；
    // 当日新阻塞的行 batch_boundary=本日不会被复活。attempts 不因凭据故障递增（见 processJob）。
    this.deps.db.prepare(
      `UPDATE source_bind_jobs SET status = 'pending', updated_at = ? WHERE status = 'credential_blocked' AND batch_boundary < ?`,
    ).run(new Date().toISOString(), boundary);
    // 三轮复审④：旧版（无熔断语义时）已因余额故障耗尽四次的任务同样转入熔断态
    //（batch_boundary=当前 → 次日复活；充值后自动恢复，不改其他失败任务的停止条件）。
    this.deps.db.prepare(
      `UPDATE source_bind_jobs SET status = 'credential_blocked', batch_boundary = ?, attempts = 0, updated_at = ? WHERE status = 'failed' AND attempts >= ? AND detail LIKE '%余额不足%'`,
    ).run(boundary, new Date().toISOString(), SourceBindingService.MAX_ATTEMPTS);

    // 收集（批次范围固定：只收本调用前已提交的行；批内新写入不入本批）
    const facts = this.uncollectedHolds(boundary, cfg.max_batch);
    report.collected = facts.length;
    const insert = this.deps.db.prepare(
      `INSERT OR IGNORE INTO source_bind_jobs(id, memory_id, memory_version, conversation_id, turn_id, batch_boundary, status, attempts, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'pending', 0, ?, ?)`,
    );
    for (const f of facts) {
      const t = new Date().toISOString();
      insert.run(genId('sbj'), f.memory_id, f.conversation_id, f.turn_id, boundary, t, t);
    }
    if (facts.length > 0) {
      const placeholders = facts.map(() => '?').join(',');
      report.inserted = (this.deps.db.prepare(
        `SELECT COUNT(*) n FROM source_bind_jobs WHERE batch_boundary = ? AND memory_id IN (${placeholders})`,
      ).get(boundary, ...facts.map((f) => f.memory_id)) as { n: number }).n;
    }

    // 处理 pending + 可重试态（本批有界；单条失败不阻塞）。BIND-03/B03"局部失败留待处理、
    // 恢复接续"：failed（写入/判断可重试类）与 source_unavailable（原文未同步，落 M 后可收口）
    // 在后续批次自动重取，attempts 有界防无限付费（B08/B16：无匹配不重复猜测、不虚构 exactly-once）。
    // version_conflict 不自动重试（版本冲突重判结果不变，按冲突语义待重处理入口）。
    const jobs = this.deps.db.prepare(
      `SELECT * FROM source_bind_jobs WHERE status IN ('pending','failed','source_unavailable') AND batch_boundary <= ? AND attempts < ? ORDER BY created_at ASC LIMIT ?`,
    ).all(boundary, SourceBindingService.MAX_ATTEMPTS, cfg.max_batch) as JobRow[];
    for (const job of jobs) {
      try {
        await this.processJob(job, boundary);
      } catch (err) {
        // 三轮复审③：单条处理异常（如畸形回包在解析前抛错）不得中止整批——
        // B03"单条失败不阻塞"此前只有注释没有 catch；异常按 failed 收口留重试。
        this.setStatus(job, 'failed', `处理异常（${String((err as Error).message ?? err).slice(0, 120)}）——下批重试`);
      }
      report.processed += 1;
      const st = (this.deps.db.prepare('SELECT status FROM source_bind_jobs WHERE id = ?').get(job.id) as { status: string }).status;
      report.counts[st] = (report.counts[st] ?? 0) + 1;
    }
    this.deps.log('info', 'source_bind_batch', { boundary, collected: report.collected, processed: report.processed, counts: report.counts, skipped: report.skipped });
    return report;
  }

  /** 凭据/余额类故障提醒。幂等键=**上海业务日**（三轮复审④：UTC 日期在 16:00 后翻日，
   *  同一上海日会重复提醒）；出口两条：①host_notices 宿主通知（下次正常请求投递给模型）
   *  ②system.notice 事件（SSE 流/活动记录——她本人可直接查，不依赖模型转述）。 */
  private notifyCredentialIssue(reason: string): void {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    try {
      this.deps.db.prepare(
        'INSERT INTO host_notices(id, conversation_id, kind, payload_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING',
      ).run(genId('ntc'), 'primary', 'source_bind_credential', JSON.stringify({ text: `[系统通知] 午夜来源绑定的判断服务遇到凭据/余额问题，本日批次暂停重试：${reason.slice(0, 120)}。充值或更换 key 后下一批次自动恢复，无需重启。` }), `bind-credential-alert:${day}`, new Date().toISOString());
    } catch { /* 通知失败不影响任务状态 */ }
    try {
      this.deps.events?.publish('system.notice', { conversationId: 'primary', turnId: null, scope: 'private', payload: { source: 'source_bind', text: `[系统通知] BIND 判断服务凭据/余额问题：${reason.slice(0, 120)}`, day } });
    } catch { /* 事件出口失败不影响任务状态 */ }
    this.deps.log('warn', 'source_bind_credential_alert', { day, reason: reason.slice(0, 120) });
  }

  private setStatus(job: JobRow, status: string, detail: string | null, bindingIds?: string[], opts: { noAttempt?: boolean } = {}): void {
    // 达重试上限的 failed 如实标注停止自动重试（detail 不留"下批重试"的假话）。
    // noAttempt（返修 P1-4）：凭据/余额类故障不消耗重试额度——充值后跨日界即恢复。
    const capped = !opts.noAttempt && status === 'failed' && job.attempts + 1 >= SourceBindingService.MAX_ATTEMPTS;
    const finalDetail = capped ? `${detail}（已达重试上限 ${SourceBindingService.MAX_ATTEMPTS}，停止自动重试——留人工核对）` : detail;
    this.deps.db.prepare(
      `UPDATE source_bind_jobs SET status = ?, detail = ?, attempts = attempts ${opts.noAttempt ? '' : '+ 1'}, memory_version = COALESCE(memory_version, ?),
       binding_ids_json = COALESCE(?, binding_ids_json), updated_at = ? WHERE id = ?`,
    ).run(status, finalDetail, job.memory_version, bindingIds ? JSON.stringify(bindingIds) : null, new Date().toISOString(), job.id);
  }

  private async processJob(job: JobRow, batchBoundary: string): Promise<void> {
    const m = this.deps.mariposa!;
    // 返修 P1-1：部分成功过的任务存有 pending_segments_json——恢复时**只补缺段**，
    // 不重新付费判断（原判定已留存；ownIds 保护已写段不被误判为人工来源）。
    const pendingSegments = job.pending_segments_json
      ? (JSON.parse(job.pending_segments_json) as Array<{ members: Array<{ source_message_id: string; content_hash: string }>; conversation: string }>) : null;
    if (pendingSegments && pendingSegments.length > 0) {
      return this.resumePendingSegments(job, pendingSegments);
    }
    // ① 记忆当前版本与正文（判断依据；版本落行——内容后变按冲突语义另处理）
    type MemShape = { text?: unknown; original_title?: unknown; version?: unknown };
    let mem: MemShape | null = null;
    try {
      const r = await m.memoryGet(job.memory_id);
      if (r.ok) mem = r.result as MemShape;
      else if (r.code === 'NOT_FOUND' || r.code === 'MEMORY_NOT_FOUND') { this.setStatus(job, 'failed', '记忆不存在（可能已删除）'); return; }
      else { this.setStatus(job, 'failed', `记忆读取失败（${r.code}）——下批重试`); return; }
    } catch {
      this.setStatus(job, 'failed', '记忆读取传输失败——下批重试'); return;
    }
    const version = typeof mem?.version === 'number' ? mem.version : null;
    if (version != null) { this.deps.db.prepare('UPDATE source_bind_jobs SET memory_version = ? WHERE id = ?').run(version, job.id); job.memory_version = version; }

    // ② 候选：该会话内 hold 回合输入序号 ±30 条、有界（BIND-04：有界候选，不全日外发）
    const candidates = this.gatherCandidates(job);
    if (candidates.length === 0) {
      // 无会话线索（跨路径导入等）：无来源合法（BIND-04：自发感受/无对应聊天允许无来源）
      this.setStatus(job, 'no_match', '无会话线索或窗口内无消息——按无来源保留');
      return;
    }

    // ②b P1-3（Codex 审计）+ 返修 P1-2（按**记忆**核对——会话方向查询看不到跨会话的
    //    人工绑定）。该记忆已有**非本任务**建立的来源绑定时直接跳过（人工来源不被自动
    //    追加；M 侧 OVERLAP 只查成员交集，拦不住不重叠段）。本任务自己已写的段
    //    （binding_ids_json 留存）不算障碍——部分成功后补剩余段仍可达。
    //    查询传输/上游失败（返修 P1-2）：付费前停止，不靠 M OVERLAP 兜底盲写。
    const foreign = await this.foreignBindingsOf(job);
    if (foreign === 'unavailable') {
      this.setStatus(job, 'failed', '既有绑定查询失败（传输/上游）——付费判断前停止，下批重试');
      return;
    }
    if (foreign.length > 0) {
      this.setStatus(job, 'skipped_existing', `该记忆已有来源绑定（${foreign.length} 条，人工/其他任务建立）——付费判断前跳过，不覆盖不追加`);
      return;
    }

    // ③ GLM 判断（只在候选真实引用中选范围/给短依据，或无可靠匹配）
    const cand = candidates.map((c) => ({ id: c.id, speaker: c.speaker === 'owner' ? '宿主用户' : 'char', at: c.occurred_at, text: c.content.slice(0, 200) }));
    const prompt =
`任务：判断下面这条记忆的来源是否出现在候选聊天原文里。只允许引用候选中真实存在的消息 id；不要生成原话、不要把同主题但无关的段落当来源。
记忆标题：${String(mem?.original_title ?? '')}
记忆正文：${String(mem?.text ?? '')}
候选消息（id/说话人/时间/正文节选）：
${cand.map((c) => `- [${c.id}] ${c.speaker}（${c.at}）：${c.text}`).join('\n')}
输出 JSON：找到可靠来源时 {"match":true,"ranges":[{"start":"<消息id>","end":"<消息id>","basis":"<一句话可核验依据>"}],"confidence":"high|low"}（ranges 支持多段不连续）；没有可靠匹配时 {"match":false,"reason":"<短原因>"}。整段无关谈话不要包入；短引语命中不等于整件事来源。`;
    const answer = await this.deps.glm!.chat([{ role: 'user', content: prompt }], { responseJson: true, temperature: 0 });
    if (!answer.ok) {
      // P1-5（Codex 审计）：判断服务失败（超时/凭据被拒/缺正文）≠ 无匹配——no_match 只在
      // 得到**有效否定判断**时记录（旧实现把不可重试的服务故障永久记成无来源）。
      // 返修 P1-4：凭据/余额类（401/402/403）→ credential_blocked 熔断——当日不再发起
      // 判断、不消耗重试额度，跨上海日界自动复活（充值/换 key 后恢复）；其他失败照常有界重试。
      if (/^凭据被拒|^余额不足/.test(answer.reason)) {
        this.setStatus(job, 'credential_blocked', `${answer.reason}——当日熔断，跨日自动恢复（充值/换 key 后无需人工介入）`, undefined, { noAttempt: true });
        // 三轮复审④：熔断行的 batch_boundary 推进到**本批边界**——当日后续 tick 不再对该任务
        // 发起判断（旧实现复活后每 tick 一次 402 请求）；次日 boundary 前移即恢复资格。
        this.deps.db.prepare('UPDATE source_bind_jobs SET batch_boundary = ? WHERE id = ?').run(batchBoundary, job.id);
        this.notifyCredentialIssue(answer.reason);
        return;
      }
      this.setStatus(job, 'failed', `GLM 判断未完成（${answer.reason}）——${answer.retryable ? '下批重试' : '结果未知/配置类，达上限停止'}`);
      return;
    }
    let parsed: { match?: unknown; ranges?: Array<{ start?: unknown; end?: unknown; basis?: unknown }>; reason?: unknown };
    try { parsed = JSON.parse(answer.content); } catch { this.setStatus(job, 'failed', 'GLM 输出非 JSON——下批重试'); return; }
    // 返修 P1-3：区分有效否定（match:false 终结 no_match）/ 有效肯定 / 无效回包
    //（match 字段无效或 match=true 而无范围=判断故障，按有界恢复处理，不得永久记 no_match）。
    if (parsed.match === false) {
      this.setStatus(job, 'no_match', typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '无可靠匹配——合法结果，不重复付费重判');
      return;
    }
    if (parsed.match !== true || !Array.isArray(parsed.ranges) || parsed.ranges.length === 0) {
      this.setStatus(job, 'failed', `判断回包无效（match=${JSON.stringify(parsed.match)?.slice(0, 40)}，范围${Array.isArray(parsed.ranges) ? ` ${parsed.ranges.length} 段` : '缺失'}）——按判断故障重试`);
      return;
    }
    // ④ P1-1（Codex 审计）：逐段解析——每个 range 独立的连续段，段间消息**不进任何成员集合**
    //    （旧实现取全部端点全局 min/max，两个不连续段会把中间无关聊天并入一段提交）。
    //    P1-2：成员修订须仍等于判断时候选修订（消息被编辑→冲突退出，不拿新文本冒充旧判断依据）。
    //    三轮复审③：段形状先行校验（数组含 null/端点非字符串=无效回包 failed，不再抛错中止整批）。
    const idSet = new Set(candidates.map((c) => c.id));
    const candRevision = new Map(candidates.map((c) => [c.id, c.revision]));
    for (const rg of parsed.ranges) {
      if (rg === null || typeof rg !== 'object' || typeof rg.start !== 'string' || typeof rg.end !== 'string') {
        this.setStatus(job, 'failed', '判断回包段无效（段为空或端点不是消息 id）——按判断故障重试');
        return;
      }
    }
    type Segment = { members: Array<{ source_message_id: string; content_hash: string }>; conversation: string };
    const segments: Segment[] = [];
    const seenSm = new Set<string>();
    let globalConversation: string | null = null;
    for (const rg of parsed.ranges) {
      const endpoints: Array<{ id: string; sequence: number }> = [];
      for (const mid of [rg.start, rg.end]) {
        if (typeof mid !== 'string' || !idSet.has(mid)) { this.setStatus(job, 'failed', 'GLM 引用了不存在的消息 id——拒绝写入'); return; }
        const row = this.deps.db.prepare('SELECT id, sequence FROM messages WHERE id = ?').get(mid) as { id: string; sequence: number };
        endpoints.push(row);
      }
      const [startRow, endRow] = endpoints;
      if (startRow.sequence > endRow.sequence) { this.setStatus(job, 'failed', 'GLM 段边界倒置——拒绝写入'); return; }
      const span = this.deps.db.prepare(
        `SELECT id, current_revision AS revision, sequence FROM messages WHERE conversation_id = ?
         AND sequence BETWEEN ? AND ? AND speaker IN ('owner','assistant') ORDER BY sequence ASC`,
      ).all(job.conversation_id, startRow.sequence, endRow.sequence) as Array<{ id: string; revision: number; sequence: number }>;
      const segMembers: Segment['members'] = [];
      for (const s of span) {
        // P1-2：判断基于候选当时的修订快照；写入时修订已变=按冲突退出（M 无版本 CAS，E 侧复核）
        if (s.revision !== candRevision.get(s.id)) { this.setStatus(job, 'version_conflict', `范围消息（${s.id}）在判断后被编辑——不按旧判断写入新文本，按冲突语义待重处理`); return; }
        // 收据按 span 消息的当前修订精确匹配（与手动绑定 receiptOf 同口径）——多修订混旧 sm 已实证（SOURCE_RANGE_NOT_PATH）。
        const receipt = this.deps.db.prepare(
          'SELECT source_message_id, source_conversation_id, content_hash FROM source_sync_receipts WHERE origin_message_id = ? AND revision = ? AND source_message_id IS NOT NULL',
        ).get(s.id, s.revision) as { source_message_id: string; source_conversation_id: string; content_hash: string } | undefined;
        if (!receipt) { this.setStatus(job, 'source_unavailable', `范围含未同步消息（${s.id}）——原文落 M 后下批重试`); return; }
        // 绑定会话=M 侧真实会话（收据 source_conversation_id，与手动绑定同口径——传 E 会话 id 会被 M NOT_FOUND 拒）。
        if (globalConversation === null) globalConversation = receipt.source_conversation_id;
        else if (receipt.source_conversation_id !== globalConversation) { this.setStatus(job, 'failed', '范围成员收据跨 M 会话——不一致，不写入'); return; }
        if (seenSm.has(receipt.source_message_id)) { this.setStatus(job, 'failed', 'GLM 各段成员重复——拒绝写入'); return; }
        seenSm.add(receipt.source_message_id);
        segMembers.push({ source_message_id: receipt.source_message_id, content_hash: receipt.content_hash });
      }
      if (segMembers.length > 0) segments.push({ members: segMembers, conversation: globalConversation! });
    }
    if (segments.length === 0) { this.setStatus(job, 'no_match', '判断段内无合格成员——按无来源保留'); return; }
    // P1-2 + 返修 P1-2：写入前复核——失败即停（不写入），不再"不阻断"盲写；
    // 版本变了按冲突退出；同时按记忆再核一次人工来源（提交时保护判断所依赖的绑定状态——
    // 判断期间本人新建的非重叠来源不得被自动追加）。
    let v2: unknown;
    try {
      const re = await m.memoryGet(job.memory_id);
      if (!re.ok) { this.setStatus(job, 'failed', `写前版本复核失败（${r_code(re)}）——保留待核，不写入`); return; }
      v2 = (re.result as MemShape).version;
    } catch {
      this.setStatus(job, 'failed', '写前版本复核传输失败——保留待核，不写入');
      return;
    }
    if (typeof v2 === 'number' && version != null && v2 !== version) {
      this.setStatus(job, 'version_conflict', `记忆在判断后被修改（v${version}→v${v2}）——按冲突语义待重处理`);
      return;
    }
    const foreignLate = await this.foreignBindingsOf(job);
    if (foreignLate === 'unavailable') { this.setStatus(job, 'failed', '写前来源状态复核失败（传输/上游）——不写入'); return; }
    if (foreignLate.length > 0) {
      // 判断期间出现的任何新来源（含非重叠）都停止追加（二轮指令：非重叠也不得追加）；
      // 复核与 M 提交之间的最后窗口由 M 侧 expected_memory_version/expected_binding_ids
      // 原子核对闭合（三轮②）。
      this.setStatus(job, 'skipped_existing', `判断期间出现新的来源绑定（${foreignLate.length} 条）——停止追加，不覆盖`);
      return;
    }

    await this.writeSegments(job, segments);
  }

  /** 段写入共用（首轮与补段路径同语义）。返修 P1-1：部分成功=任务未完成——已成功段
   *  binding_id 留存、剩余段存 pending_segments_json（恢复时只补缺段不重判）；
   *  全部段收口才记 bound 并清空 pending；OVERLAP 段=该段已完成（不覆盖）。 */
  private async writeSegments(job: JobRow, segments: Array<{ members: Array<{ source_message_id: string; content_hash: string }>; conversation: string }>): Promise<void> {
    const m = this.deps.mariposa!;
    const prevIds: string[] = job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : [];
    const okIds: string[] = [...prevIds];
    let overlapped = 0;
    let hardFail: string | null = null;
    let failedAt = -1;
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx]!;
      try {
        const ownIds: string[] = job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : [];
        const r = await m.sourceBindingBind(job.memory_id, { conversation_id: seg.conversation, members: seg.members }, {
          expectedMemoryVersion: job.memory_version,
          expectedBindingIds: ownIds,
        });
        if (r.ok) {
          const bindingId = (r.result as { binding_id?: unknown } | null)?.binding_id;
          if (typeof bindingId === 'string') okIds.push(bindingId);
          continue;
        }
        if (r.code === 'EVENT_SOURCE_OVERLAP' || r.code === 'SOURCE_ALREADY_BOUND') { overlapped++; continue; }
        if (r.code === 'VERSION_CONFLICT' || r.code === 'EVENT_SOURCE_CHANGED' || r.code === 'EVENT_SOURCE_STATE_CHANGED') { hardFail = `记忆/来源状态在判断后已变化（${r.code}）——前段已成功 ${okIds.length - prevIds.length} 段留存，按冲突语义待重处理`; failedAt = idx; break; }
        hardFail = `绑定写入失败（${r.code}）——前段已成功留存，剩余段下批补写`;
        failedAt = idx;
        break;
      } catch {
        hardFail = `绑定写入传输失败（结果未知，不盲重发）——前段已成功留存，剩余段下批核对后补写`;
        failedAt = idx;
        break;
      }
    }
    if (failedAt < 0) {
      this.deps.db.prepare('UPDATE source_bind_jobs SET pending_segments_json = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), job.id);
      if (okIds.length === prevIds.length && overlapped === segments.length) {
        // 本轮零新成功且全部段都是既有绑定：任务没有建立任何新绑定——如实 skipped_existing
        this.setStatus(job, 'skipped_existing', '已有人工/既有绑定——跳过不覆盖');
        return;
      }
      this.setStatus(job, 'bound', `自动补绑 ${okIds.length} 段（后台任务建立，非本人绑定）${overlapped > 0 ? `；既有绑定段跳过 ${overlapped} 段` : ''}`, okIds);
      return;
    }
    // 部分成功/中途失败：任务未完成——剩余段（失败段起）持久化。冲突类（版本/来源状态
    // 变化）终态 version_conflict 不再自动重试；传输/上游类 failed 保留恢复资格。
    const remaining = segments.slice(failedAt);
    this.deps.db.prepare('UPDATE source_bind_jobs SET pending_segments_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(remaining), new Date().toISOString(), job.id);
    const hf = hardFail ?? '绑定写入失败';
    this.setStatus(job, hf.startsWith('记忆/来源状态') ? 'version_conflict' : 'failed', `${hf}（已成功 ${okIds.length} 段留存，剩余 ${remaining.length} 段记录在案）`, okIds);
  }

  /** 补段路径（返修 P1-1）：不重新付费判断，按原判定补写剩余段；
   *  写前仍做版本复核与人工来源复核（同主路径语义）。 */
  private async resumePendingSegments(job: JobRow, pendingIn: Array<{ members: Array<{ source_message_id: string; content_hash: string }>; conversation: string }>): Promise<void> {
    const m = this.deps.mariposa!;
    const foreign = await this.foreignBindingsOf(job);
    if (foreign === 'unavailable') { this.setStatus(job, 'failed', '补段前既有绑定查询失败（传输/上游）——下批重试'); return; }
    // 三轮复审①：与待补段有成员交集的"他源"绑定=回执丢失的自写段（M 已提交 E 未记账）——
    // 认领为已完成并从待补清单移除（binding_id 一并记账）；与全部段无交集才是人工障碍。
    let pending = pendingIn;
    const claimed: string[] = [];
    if (foreign.length > 0) {
      const blockers = foreign.filter((b) => !pending.some((seg) => SourceBindingService.bindingTouches(b, new Set(seg.members.map((mm) => mm.source_message_id)))));
      if (blockers.length > 0) { this.setStatus(job, 'skipped_existing', `补段前发现人工/他源绑定（${blockers.length} 条，与本任务范围无关）——停止补写，不覆盖`); return; }
      const prevIds: string[] = job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : [];
      const touched = foreign.filter((b) => pending.some((seg) => SourceBindingService.bindingTouches(b, new Set(seg.members.map((mm) => mm.source_message_id)))));
      pending = pending.filter((seg) => !touched.some((b) => SourceBindingService.bindingTouches(b, new Set(seg.members.map((mm) => mm.source_message_id)))));
      for (const b of touched) { if (!prevIds.includes(b.binding_id)) { prevIds.push(b.binding_id); claimed.push(b.binding_id); } }
      if (claimed.length > 0) {
        this.deps.db.prepare('UPDATE source_bind_jobs SET binding_ids_json = ?, pending_segments_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(prevIds), JSON.stringify(pending), new Date().toISOString(), job.id);
        job.binding_ids_json = JSON.stringify(prevIds);
        job.pending_segments_json = pending.length > 0 ? JSON.stringify(pending) : null;
      }
    }
    if (pending.length === 0) {
      this.deps.db.prepare('UPDATE source_bind_jobs SET pending_segments_json = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), job.id);
      this.setStatus(job, 'bound', `自动补绑收口（含回执丢失段认领 ${claimed.length} 条；后台任务建立，非本人绑定）`, job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : []);
      return;
    }
    let v2: unknown;
    try {
      const re = await m.memoryGet(job.memory_id);
      if (!re.ok) { this.setStatus(job, 'failed', `补段前版本复核失败（${r_code(re)}）——保留待核`); return; }
      v2 = (re.result as { version?: unknown }).version;
    } catch { this.setStatus(job, 'failed', '补段前版本复核传输失败——保留待核'); return; }
    if (typeof v2 === 'number' && job.memory_version != null && v2 !== job.memory_version) {
      this.setStatus(job, 'version_conflict', `记忆已修改（判断时 v${job.memory_version}→现 v${v2}）——剩余段按冲突语义待重处理`);
      return;
    }
    await this.writeSegments(job, pending);
  }

  /** 按记忆核对既有绑定（返修 P1-2：跨会话人工来源可见）。
   *  三轮复审②：查询**任何**非 ok（含 404——of_memory 对任意记忆恒返回列表，出现 404 即异常）
   *  一律 unavailable 付费前停止，不再按 4xx 放行盲写。行带 start/end sm 供成员交集判定。 */
  private async foreignBindingsOf(job: JobRow): Promise<Array<{ binding_id: string; start_message_id?: string; end_message_id?: string }> | 'unavailable'> {
    const m = this.deps.mariposa!;
    const ownBindingIds = new Set<string>(job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : []);
    try {
      const bl = await m.sourceBindingsOfMemory(job.memory_id);
      if (!bl.ok) return 'unavailable';
      const rows = ((bl.result as { bindings?: unknown } | null)?.bindings ?? []) as Array<{ memory_id?: unknown; binding_id?: unknown; start_message_id?: unknown; end_message_id?: unknown }>;
      return rows
        .filter((b) => b.memory_id === job.memory_id && typeof b.binding_id === 'string' && !ownBindingIds.has(b.binding_id))
        .map((b) => ({ binding_id: b.binding_id as string, start_message_id: typeof b.start_message_id === 'string' ? b.start_message_id : undefined, end_message_id: typeof b.end_message_id === 'string' ? b.end_message_id : undefined }));
    } catch {
      return 'unavailable';
    }
  }

  /** 三轮复审①：他源绑定与待写段的**成员交集**判定——回执丢失的自写段（M 已提交、E 未记账）
   *  其绑定端点落在该段成员集内：视为该段已完成（幂等收口），不是障碍；与所有段都无交集的
   *  他源绑定才是真正的人工来源（跳过不追加）。 */
  private static bindingTouches(bind: { start_message_id?: string; end_message_id?: string }, segmentSm: Set<string>): boolean {
    return (bind.start_message_id != null && segmentSm.has(bind.start_message_id)) || (bind.end_message_id != null && segmentSm.has(bind.end_message_id));
  }

  /** 候选窗口：hold 回合输入序号 ±30、同会话、双方消息，有界 max_candidates（revision=判断时快照，P1-2 钉住）。 */
  private gatherCandidates(job: JobRow): Array<{ id: string; speaker: string; occurred_at: string; content: string; sequence: number; revision: number }> {
    if (!job.conversation_id) return [];
    const cfg = this.deps.config.source_binding;
    let anchorSeq: number | null = null;
    if (job.turn_id) {
      const t = this.deps.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(job.turn_id) as { input_message_id: string | null } | undefined;
      if (t?.input_message_id) {
        const anchor = this.deps.db.prepare('SELECT sequence FROM messages WHERE id = ?').get(t.input_message_id) as { sequence: number } | undefined;
        anchorSeq = anchor?.sequence ?? null;
      }
    }
    if (anchorSeq == null) {
      // 无回合输入线索：取会话最近一条（边界情况——如实给最近窗口）
      const last = this.deps.db.prepare('SELECT MAX(sequence) n FROM messages WHERE conversation_id = ?').get(job.conversation_id) as { n: number | null };
      anchorSeq = last.n ?? 0;
    }
    return this.deps.db.prepare(
      `SELECT m.id AS id, m.speaker AS speaker, r.occurred_at AS occurred_at, r.content AS content, m.sequence AS sequence, m.current_revision AS revision
       FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.speaker IN ('owner','assistant') AND m.sequence BETWEEN ? AND ?
       ORDER BY m.sequence ASC LIMIT ?`,
    ).all(job.conversation_id, Math.max(1, anchorSeq - 30), anchorSeq + 30, cfg.max_candidates) as Array<{ id: string; speaker: string; occurred_at: string; content: string; sequence: number; revision: number }>;
  }
}

/** M 调用结果错误码的有界展示（复核失败 detail 用）。 */
function r_code(r: { code?: string; httpStatus?: number }): string {
  return String(r.code ?? r.httpStatus ?? 'unknown').slice(0, 40);
}
