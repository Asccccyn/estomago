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
  binding_ids_json: string | null; attempts: number;
};

export class SourceBindingService {
  /** 可重试态的总尝试上限（含首次）：有界防无限付费（B08/B16）。 */
  static readonly MAX_ATTEMPTS = 4;
  private readonly deps: { db: Db; config: Config; mariposa: MariposaClient | null; glm: GlmChatAdapter | null; log: (level: 'info' | 'warn', event: string, fields?: Record<string, unknown>) => void };
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
      await this.processJob(job);
      report.processed += 1;
      const st = (this.deps.db.prepare('SELECT status FROM source_bind_jobs WHERE id = ?').get(job.id) as { status: string }).status;
      report.counts[st] = (report.counts[st] ?? 0) + 1;
    }
    this.deps.log('info', 'source_bind_batch', { boundary, collected: report.collected, processed: report.processed, counts: report.counts, skipped: report.skipped });
    return report;
  }

  private setStatus(job: JobRow, status: string, detail: string | null, bindingIds?: string[]): void {
    // 达重试上限的 failed 如实标注停止自动重试（detail 不留"下批重试"的假话）
    const capped = status === 'failed' && job.attempts + 1 >= SourceBindingService.MAX_ATTEMPTS;
    const finalDetail = capped ? `${detail}（已达重试上限 ${SourceBindingService.MAX_ATTEMPTS}，停止自动重试——留人工核对）` : detail;
    this.deps.db.prepare(
      `UPDATE source_bind_jobs SET status = ?, detail = ?, attempts = attempts + 1, memory_version = COALESCE(memory_version, ?),
       binding_ids_json = COALESCE(?, binding_ids_json), updated_at = ? WHERE id = ?`,
    ).run(status, finalDetail, job.memory_version, bindingIds ? JSON.stringify(bindingIds) : null, new Date().toISOString(), job.id);
  }

  private async processJob(job: JobRow): Promise<void> {
    const m = this.deps.mariposa!;
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
    if (version != null) this.deps.db.prepare('UPDATE source_bind_jobs SET memory_version = ? WHERE id = ?').run(version, job.id);

    // ② 候选：该会话内 hold 回合输入序号 ±30 条、有界（BIND-04：有界候选，不全日外发）
    const candidates = this.gatherCandidates(job);
    if (candidates.length === 0) {
      // 无会话线索（跨路径导入等）：无来源合法（BIND-04：自发感受/无对应聊天允许无来源）
      this.setStatus(job, 'no_match', '无会话线索或窗口内无消息——按无来源保留');
      return;
    }

    // ②b P1-3（Codex 审计）：付费判断前查既有绑定——该记忆已有**非本任务**建立的来源绑定时
    //    直接跳过（人工来源不被自动追加；M 侧 OVERLAP 只查成员交集，拦不住不重叠段）。
    //    本任务自己已写的段（binding_ids_json 留存）不算障碍——部分成功后重试补剩余段仍可达。
    const ownBindingIds = new Set<string>(job.binding_ids_json ? (JSON.parse(job.binding_ids_json) as string[]) : []);
    const convReceipt = job.conversation_id ? this.deps.db.prepare(
      'SELECT source_conversation_id FROM source_sync_receipts WHERE origin_message_id IN (SELECT id FROM messages WHERE conversation_id = ?) AND source_conversation_id IS NOT NULL LIMIT 1',
    ).get(job.conversation_id) as { source_conversation_id: string } | undefined : undefined;
    if (convReceipt) {
      try {
        const bl = await m.sourceBindingsOfConversation(convReceipt.source_conversation_id);
        if (bl.ok) {
          const rows = ((bl.result as { bindings?: unknown } | null)?.bindings ?? []) as Array<{ memory_id?: unknown; binding_id?: unknown }>;
          const foreign = rows.filter((b) => b.memory_id === job.memory_id && typeof b.binding_id === 'string' && !ownBindingIds.has(b.binding_id));
          if (foreign.length > 0) {
            this.setStatus(job, 'skipped_existing', `该记忆已有来源绑定（${foreign.length} 条，人工/其他任务建立）——付费判断前跳过，不覆盖不追加`);
            return;
          }
        }
      } catch { /* 绑定查询传输失败不阻断——写入时 M 侧 OVERLAP 仍兜底 */ }
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
      // P1-5（Codex 审计）：判断服务失败（超时/凭据被拒/缺正文）≠ 无匹配——一律 failed 留重试语义，
      // no_match 只在得到**有效否定判断**时记录（旧实现把不可重试的服务故障永久记成无来源）。
      this.setStatus(job, 'failed', `GLM 判断未完成（${answer.reason}）——${answer.retryable ? '下批重试' : '结果未知/配置类，达上限停止'}`);
      return;
    }
    let parsed: { match?: unknown; ranges?: Array<{ start?: unknown; end?: unknown; basis?: unknown }>; reason?: unknown };
    try { parsed = JSON.parse(answer.content); } catch { this.setStatus(job, 'failed', 'GLM 输出非 JSON——下批重试'); return; }
    if (parsed.match !== true || !Array.isArray(parsed.ranges) || parsed.ranges.length === 0) {
      this.setStatus(job, 'no_match', typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '无可靠匹配——合法结果，不重复付费重判');
      return;
    }
    // ④ P1-1（Codex 审计）：逐段解析——每个 range 独立的连续段，段间消息**不进任何成员集合**
    //    （旧实现取全部端点全局 min/max，两个不连续段会把中间无关聊天并入一段提交）。
    //    P1-2：成员修订须仍等于判断时候选修订（消息被编辑→冲突退出，不拿新文本冒充旧判断依据）。
    const idSet = new Set(candidates.map((c) => c.id));
    const candRevision = new Map(candidates.map((c) => [c.id, c.revision]));
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
    // P1-2：记忆版本复核——判断基于 version 快照，写入前仍须同一版本（M 侧无 CAS 接口，E 侧复核如实）
    try {
      const re = await m.memoryGet(job.memory_id);
      const v2 = re.ok ? (re.result as MemShape).version : undefined;
      if (typeof v2 === 'number' && version != null && v2 !== version) {
        this.setStatus(job, 'version_conflict', `记忆在判断后被修改（v${version}→v${v2}）——按冲突语义待重处理`);
        return;
      }
    } catch { /* 复核传输失败不阻断——写入链自有失败面，避免双倍故障 */ }

    // ⑤ P1-1：逐段写入（每段独立绑定调用）；OVERLAP 段跳过不覆盖；中途失败保留已成功段的 binding_id
    //    （重试时既有自写段被 P1-3 前置检查放行、M OVERLAP 幂等跳过，只补剩余段）。
    const okIds: string[] = [];
    let overlapped = 0;
    let hardFail: string | null = null;
    for (const seg of segments) {
      try {
        const r = await m.sourceBindingBind(job.memory_id, { conversation_id: seg.conversation, members: seg.members });
        if (r.ok) {
          const bindingId = (r.result as { binding_id?: unknown } | null)?.binding_id;
          if (typeof bindingId === 'string') okIds.push(bindingId);
          continue;
        }
        if (r.code === 'EVENT_SOURCE_OVERLAP' || r.code === 'SOURCE_ALREADY_BOUND') { overlapped++; continue; }
        if (r.code === 'VERSION_CONFLICT' || r.code === 'EVENT_SOURCE_CHANGED') { hardFail = '记忆/原文版本已变化——按冲突语义待重处理'; break; }
        hardFail = `绑定写入失败（${r.code}）——已成功 ${okIds.length} 段，剩余段下批重试`;
        break;
      } catch {
        hardFail = `绑定写入传输失败（结果未知，不盲重发）——已成功 ${okIds.length} 段，下批核对后重试`;
        break;
      }
    }
    if (okIds.length > 0) {
      this.setStatus(job, 'bound', `自动补绑 ${okIds.length} 段（后台任务建立，非本人绑定）${overlapped > 0 ? `；既有绑定段跳过 ${overlapped} 段` : ''}`, okIds);
      return;
    }
    if (overlapped === segments.length) { this.setStatus(job, 'skipped_existing', '已有人工/既有绑定——跳过不覆盖'); return; }
    this.setStatus(job, 'failed', hardFail ?? '绑定写入失败——下批重试');
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
