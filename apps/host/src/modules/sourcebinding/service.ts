import type { Db } from "../../db/connection.ts"
import type { Config } from "../../config/schema.ts"
import type { MariposaClient } from "../../integrations/mariposa/client.ts"
import type { GlmChatAdapter } from "../../integrations/glm/chat.ts"
import { genId } from "../../util/id.ts"

export type SourceBindBatchReport = {
  boundary: string // 本批截止点（Asia/Shanghai 00:00 ISO）
  scope: "est_tool_holds" // 如实范围：午夜任务处理 E 已提交的 hold；日历手动重算也可处理 M 原生桶
  collected: number
  inserted: number
  processed: number
  counts: Record<string, number> // 各终态计数
  skipped: string[] // 未处理原因（凭据缺失/未启用等）
}

type Status = "pending" | "judging" | "bound" | "no_match" | "source_unavailable" | "failed" | "version_conflict" | "skipped_existing" | "credential_blocked"
type Job = {
  revision: number
  id: string
  memory_id: string
  memory_version: number | null
  conversation_id: string | null
  turn_id: string | null
  status: Status
  detail: string | null
  attempts: number
  binding_ids_json: string | null
  pending_segments_json: string | null
  operation_id: string | null
}
type Member = { source_message_id: string; content_hash: string }
type Segment = { conversation_id: string; members: Member[] }
type Candidate = {
  id: string
  room: string
  sequence: number
  speaker: string
  at: string
  text: string
  revision?: number
  providerId?: string
  parentId?: string | null
  member?: Member
}
type Options = {
  db: Db
  config: Config
  mariposa: MariposaClient | null
  glm: GlmChatAdapter | null
  log: (
    level: "info" | "warn",
    event: string,
    fields?: Record<string, unknown>,
  ) => void
  events?: {
    publish(
      kind: string,
      opts: {
        conversationId: string
        turnId: string | null
        scope: "private"
        payload: Record<string, unknown>
      },
    ): unknown
  } | null
}
class BindError extends Error {
  readonly status: Status
  constructor(message: string, status: Status = "failed") {
    super(message)
    this.status = status
  }
}
export class SourceBindingService {
  private readonly db: Db
  private readonly stopping = new AbortController()
  private readonly running = new Map<string, Promise<void>>()
  private readonly deps: Options
  constructor(deps: Options) {
    this.db = deps.db
    this.deps = deps
  }
  get enabled(): boolean {
    return (
      this.deps.config.source_binding.enabled && !!this.deps.glm?.configured
    )
  }
  static lastBoundary(now = new Date()): string {
    const shifted = new Date(now.getTime() + 8 * 3600_000)
    return new Date(
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
      ) -
        8 * 3600_000,
    ).toISOString()
  }
  private uncollected(boundary: string, limit: number) {
    return this.db
      .prepare(`SELECT e.memory_id,t.conversation_id,e.turn_id FROM tool_side_effects e
      LEFT JOIN turns t ON t.id=e.turn_id WHERE e.kind='hold' AND e.state='committed' AND e.verified=1
      AND e.memory_id IS NOT NULL AND e.updated_at < ? AND NOT EXISTS
      (SELECT 1 FROM source_bind_jobs j WHERE j.memory_id=e.memory_id) ORDER BY e.updated_at LIMIT ?`)
      .all(boundary, limit) as {
      memory_id: string
      conversation_id: string | null
      turn_id: string | null
    }[]
  }
  dueNow(now = new Date()): boolean {
    if (!this.enabled || this.stopping.signal.aborted) return false
    const boundary = SourceBindingService.lastBoundary(now)
    return (
      !!this.db
        .prepare(
          "SELECT 1 FROM source_bind_jobs WHERE status IN ('pending','judging') AND batch_boundary<=? LIMIT 1",
        )
        .get(boundary) || this.uncollected(boundary, 1).length > 0
    )
  }
  async runBatch(now = new Date()): Promise<SourceBindBatchReport> {
    const boundary = SourceBindingService.lastBoundary(now)
    const report: SourceBindBatchReport = {
      boundary,
      scope: "est_tool_holds",
      collected: 0,
      inserted: 0,
      processed: 0,
      counts: {},
      skipped: [],
    }
    const cfg = this.deps.config.source_binding
    if (
      !cfg.enabled ||
      !this.deps.glm?.configured ||
      !this.deps.mariposa ||
      this.stopping.signal.aborted
    ) {
      report.skipped.push(
        !cfg.enabled
          ? "task_disabled"
          : !this.deps.glm?.configured
            ? "glm_not_configured"
            : "service_unavailable",
      )
      return report
    }
    const facts = this.uncollected(boundary, cfg.max_batch)
    report.collected = facts.length
    for (const f of facts)
      report.inserted += this.enqueue(
        f.memory_id,
        f.conversation_id,
        f.turn_id,
        boundary,
      )
    const rows = this.db
      .prepare(
        "SELECT memory_id FROM source_bind_jobs WHERE status IN ('pending','judging') AND batch_boundary<=? ORDER BY created_at,id LIMIT ?",
      )
      .all(boundary, cfg.max_batch)
    for (const row of rows) {
      if (this.stopping.signal.aborted) break
      const id = String(row.memory_id)
      const job = this.job(id)!
      if (this.running.has(id) || !["judging", "pending"].includes(job.status))
        continue
      await this.run(job, false)
      const status = this.job(id)!.status
      report.processed++
      report.counts[status] = (report.counts[status] ?? 0) + 1
    }
    this.deps.log("info", "source_bind_batch", {
      boundary,
      processed: report.processed,
      counts: report.counts,
    })
    return report
  }
  private enqueue(
    mid: string,
    room: string | null,
    turn: string | null,
    boundary: string,
  ) {
    const now = new Date().toISOString()
    return Number(
      this.db
        .prepare(`INSERT OR IGNORE INTO source_bind_jobs
      (id,memory_id,conversation_id,turn_id,batch_boundary,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)`)
        .run(genId("sbj"), mid, room, turn, boundary, now, now).changes,
    )
  }
  job(mid: string): Job | undefined {
    return this.db
      .prepare("SELECT * FROM source_bind_jobs WHERE memory_id=?")
      .get(mid) as Job | undefined
  }
  async stop() {
    this.stopping.abort()
    await Promise.allSettled(this.running.values())
  }
  async recalculate(mid: string, previous: number | null) {
    if (this.stopping.signal.aborted) throw new Error("宿主正在停止")
    let job = this.job(mid)
    const revision = job?.revision ?? null
    if (!job) {
      const hold = this.db
        .prepare(`SELECT t.conversation_id,e.turn_id FROM tool_side_effects e JOIN turns t ON t.id=e.turn_id
        WHERE e.memory_id=? AND e.kind='hold' AND e.state='committed' AND e.verified=1 LIMIT 1`)
        .get(mid)
      this.enqueue(
        mid,
        hold ? String(hold.conversation_id) : null,
        hold ? String(hold.turn_id) : null,
        SourceBindingService.lastBoundary(),
      )
      job = this.job(mid)!
    }
    const current = this.running.get(mid)
    if (current) await current
    else if (revision === previous) await this.run(job, true)
    const result = this.job(mid)!
    return {
      status: result.status,
      detail: result.detail,
      revision: result.revision,
    }
  }
  private run(job: Job, manual: boolean) {
    this.db
      .prepare("UPDATE source_bind_jobs SET revision=revision+1 WHERE id=?")
      .run(job.id)
    const work = this.process(job, manual)
      .catch((err) => {
        // An interrupted commit has a durable request. Startup can safely replay its
        // domain operation; ordinary failures always wait for the owner's action.
        if (
          this.stopping.signal.aborted &&
          this.job(job.memory_id)?.pending_segments_json
        )
          return
        const error =
          err instanceof BindError
            ? err
            : new BindError(
                "处理失败：" +
                  String(err instanceof Error ? err.message : err).slice(
                    0,
                    160,
                  ),
              )
        this.finish(job, error.status, error.message)
      })
      .finally(() => {
        this.running.delete(job.memory_id)
      })
    this.running.set(job.memory_id, work)
    return work
  }
  private finish(job: Job, status: Status, detail: string, ids?: string[]) {
    this.db
      .prepare(`UPDATE source_bind_jobs SET status=?,detail=?,binding_ids_json=COALESCE(?,binding_ids_json),
      pending_segments_json=CASE WHEN ? THEN NULL ELSE pending_segments_json END,updated_at=? WHERE id=?`)
      .run(
        status,
        detail,
        ids === undefined ? null : JSON.stringify(ids),
        Number(["bound", "no_match", "skipped_existing"].includes(status)),
        new Date().toISOString(),
        job.id,
      )
  }
  private async process(job: Job, manual: boolean) {
    if (!this.enabled)
      throw new BindError("来源判断未启用或缺少 DS 凭据，请检查来源绑定配置。")
    if (!this.deps.mariposa)
      throw new BindError("Mariposa 未配置，无法读取记忆桶。")
    const signal = this.stopping.signal
    const m = this.deps.mariposa.withSignal(
      AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    )
    if (!manual && job.operation_id && job.pending_segments_json) {
      await this.commit(job, m, JSON.parse(job.pending_segments_json))
      return
    }
    if (!manual && job.status === "judging")
      throw new BindError(
        "宿主在 DS 返回结果前停止，无法确认上次判断结果。请手动重算。",
      )
    const mem = await m.memoryGet(job.memory_id)
    if (!mem.ok)
      throw new BindError(
        `读取记忆桶失败（${mem.code}，HTTP ${mem.httpStatus}）`,
      )
    const version = mem.result.version
    if (typeof version !== "number")
      throw new BindError("记忆桶缺少正文版本，无法核对判断依据。")
    const state = await m.sourceBindingsOfMemory(
      job.memory_id,
      job.operation_id ?? undefined,
    )
    if (!state.ok)
      throw new BindError(
        `读取现有来源失败（${state.code}，HTTP ${state.httpStatus}）`,
      )
    if (!Array.isArray(state.result.bindings))
      throw new BindError("Mariposa 未返回来源清单。")
    const active = state.result.bindings.map(
      (b: { binding_id: string }) => b.binding_id,
    )
    const receipt = state.result.receipt as { binding_ids: string[] } | null
    if (
      receipt &&
      receipt.binding_ids.length &&
      receipt.binding_ids.every((id) => active.includes(id))
    ) {
      this.finish(job, "bound", "已核实上次写入回执。", receipt.binding_ids)
      return
    }
    // Only a legacy partial write can have confirmed segments before a new decision.
    const prior: string[] = JSON.parse(job.binding_ids_json ?? "[]")
    if (
      active.length &&
      (!manual ||
        !job.pending_segments_json ||
        active.some((id) => !prior.includes(id)))
    ) {
      this.finish(
        job,
        "skipped_existing",
        "该桶已有有效来源，保留当前绑定。",
        prior.filter((id) => active.includes(id)),
      )
      return
    }
    job.memory_version = version
    job.operation_id = genId("sbo")
    job.binding_ids_json = JSON.stringify(active)
    this.db
      .prepare(`UPDATE source_bind_jobs SET operation_id=?,memory_version=?,binding_ids_json=?,
      pending_segments_json=NULL,status='pending',detail=NULL,updated_at=? WHERE id=?`)
      .run(
        job.operation_id,
        version,
        job.binding_ids_json,
        new Date().toISOString(),
        job.id,
      )
    const candidates = await this.candidates(job, m, mem.result)
    if (!candidates.length) {
      this.finish(job, "no_match", "在可核对的聊天范围内没有找到原文。")
      return
    }
    const prompt = `判断记忆的可靠原文。只选择下面实际出现的消息 ID；不同会话或不连续段须分开，复述不能冒充当时的事件。无可靠匹配返回 {"match":false,"reason":"原因"}，匹配返回 {"match":true,"ranges":[{"start":"消息ID","end":"消息ID","basis":"依据"}]}。
记忆标题：${String(mem.result.original_title ?? "")}
记忆正文：${String(mem.result.text ?? "")}
候选消息：
${candidates.map((c) => `[${c.id}] ${c.room} ${c.speaker} ${c.at} ${c.text.slice(0, 200)}`).join("\n")}`
    signal.throwIfAborted()
    this.db
      .prepare(
        "UPDATE source_bind_jobs SET status='judging',attempts=attempts+1,detail=?,updated_at=? WHERE id=?",
      )
      .run("DS 判断已派发，等待响应。", new Date().toISOString(), job.id)
    const answer = await this.deps.glm!.chat(
      [{ role: "user", content: prompt }],
      { responseJson: true, temperature: 0, signal },
    )
    if (!answer.ok) {
      if (/^凭据被拒|^余额不足/.test(answer.reason)) {
        this.notifyCredentialIssue(answer.reason)
        throw new BindError(answer.reason, "credential_blocked")
      }
      throw new BindError("DS 判断失败：" + answer.reason)
    }
    let decision
    try {
      decision = JSON.parse(answer.content)
    } catch {
      throw new BindError("DS 响应不是有效 JSON。")
    }
    if (decision?.match === false) {
      this.finish(
        job,
        "no_match",
        typeof decision.reason === "string"
          ? decision.reason.slice(0, 200)
          : "DS 未找到可靠原文。",
      )
      return
    }
    if (
      decision?.match !== true ||
      !Array.isArray(decision.ranges) ||
      !decision.ranges.length
    )
      throw new BindError("DS 未返回有效的匹配结论或原文范围。")
    const segments: Segment[] = []
    const seen = new Set<string>()
    for (const range of decision.ranges) {
      const start = candidates.find((c) => c.id === range?.start)
      const end = candidates.find((c) => c.id === range?.end)
      if (
        !start ||
        !end ||
        start.room !== end.room ||
        start.sequence > end.sequence
      )
        throw new BindError("DS 给出的原文端点不存在、跨会话或顺序倒置。")
      let selected: Candidate[]
      if (start.member) {
        // Imported conversations may branch. Only the observed parent path is evidence.
        const parents = new Map(
          candidates
            .filter((c) => c.room === start.room)
            .map((c) => [c.providerId, c]),
        )
        selected = [end]
        while (selected[0]!.id !== start.id) {
          const parent = parents.get(selected[0]!.parentId ?? "")
          if (!parent || selected.includes(parent))
            throw new BindError("所选原文不在同一条已读取的消息路径上。")
          selected.unshift(parent)
        }
      } else {
        selected = candidates.filter(
          (c) =>
            c.room === start.room &&
            c.sequence >= start.sequence &&
            c.sequence <= end.sequence,
        )
      }
      const members: Member[] = []
      let conversation: string | null = null
      for (const c of selected) {
        let member = c.member,
          room = c.room
        if (!member) {
          const r = this.db
            .prepare(`SELECT m.current_revision,r.source_message_id,r.source_conversation_id,r.content_hash
            FROM messages m LEFT JOIN source_sync_receipts r ON r.origin_message_id=m.id AND r.revision=m.current_revision WHERE m.id=?`)
            .get(c.id)
          if (!r || r.current_revision !== c.revision)
            throw new BindError(
              "候选消息在判断期间被修改。",
              "version_conflict",
            )
          if (
            !r.source_message_id ||
            !r.source_conversation_id ||
            !r.content_hash
          )
            throw new BindError(
              `消息 ${c.id} 的第 ${c.revision} 版缺少原文同步回执。请待归档完成后重算。`,
              "source_unavailable",
            )
          room = String(r.source_conversation_id)
          member = {
            source_message_id: String(r.source_message_id),
            content_hash: String(r.content_hash),
          }
        }
        if (conversation !== null && conversation !== room)
          throw new BindError("所选段的来源收据跨会话。")
        if (seen.has(member.source_message_id))
          throw new BindError("DS 返回了重叠的原文段。")
        conversation = room
        seen.add(member.source_message_id)
        members.push(member)
      }
      segments.push({ conversation_id: conversation!, members })
    }
    // Persist the full intent before the only cross-service write.
    this.db
      .prepare(
        "UPDATE source_bind_jobs SET pending_segments_json=?,status='pending',detail=?,updated_at=? WHERE id=?",
      )
      .run(
        JSON.stringify(segments),
        "判断已保存，等待原文绑定回执。",
        new Date().toISOString(),
        job.id,
      )
    await this.commit(job, m, segments)
  }

  private async commit(job: Job, m: MariposaClient, segments: Segment[]) {
    const previous: string[] = JSON.parse(job.binding_ids_json ?? "[]")
    let result
    try {
      result = await m.sourceBindingDecision(
        job.memory_id,
        job.memory_version!,
        previous,
        segments,
        job.operation_id!,
      )
    } catch {
      throw new BindError(
        "提交原文绑定时连接中断，提交结果未知。下次手动操作会先核对原回执。",
      )
    }
    if (!result.ok) {
      const changes: Record<string, string> = {
        VERSION_CONFLICT: "记忆正文已升版",
        EVENT_SOURCE_CHANGED: "原文消息已被编辑",
        EVENT_SOURCE_STATE_CHANGED: "判断期间来源被新增或撤销",
        EVENT_SOURCE_OVERLAP: "所选原文与已有来源重叠",
        SOURCE_HASH_MISMATCH: "原文内容与判断时的版本不一致",
      }
      const failures: Record<string, string> = {
        SOURCE_RANGE_NOT_PATH: "原文端点不在同一条对话路径上",
        EVENT_SOURCE_INCOMPLETE: "所选消息未覆盖完整原文段",
        NOT_FOUND: "记忆桶或所选原文已不存在",
        FORBIDDEN: "Mariposa 拒绝了当前凭据的绑定权限",
        SCHEMA_VIOLATION: "Mariposa 拒绝了绑定请求的参数格式",
        HTTP_503: "Mariposa 暂时不可用，写入结果待核对",
      }
      const reason = changes[result.code] ?? failures[result.code] ?? "Mariposa 拒绝提交原文绑定"
      throw new BindError(`${reason}（${result.code}，HTTP ${result.httpStatus}）。`,
        changes[result.code] ? "version_conflict" : "failed")
    }
    const ids = result.result.binding_ids
    if (
      result.result.operation_id !== job.operation_id ||
      result.result.memory_id !== job.memory_id ||
      !Array.isArray(ids) ||
      ids.length !== segments.length ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new BindError("Mariposa 回执与本次操作或段数不符，请核对后重算。")
    this.finish(job, "bound", `后台任务已确认 ${ids.length} 段原文。`, [
      ...new Set([...previous, ...ids]),
    ])
  }
  private async candidates(
    job: Job,
    m: MariposaClient,
    mem: Record<string, unknown>,
  ): Promise<Candidate[]> {
    const limit = this.deps.config.source_binding.max_candidates
    if (job.conversation_id) {
      const anchor = this.db
        .prepare(`SELECT COALESCE((SELECT m.sequence FROM turns t JOIN messages m ON m.id=t.input_message_id WHERE t.id=?),
        (SELECT MAX(sequence) FROM messages WHERE conversation_id=?),0) AS seq`)
        .get(job.turn_id, job.conversation_id)!
      return this.db
        .prepare(`SELECT m.id,m.conversation_id AS room,m.sequence,m.speaker,r.occurred_at AS at,r.content AS text,
        m.current_revision AS revision FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
        WHERE m.conversation_id=? AND m.speaker IN ('owner','assistant') AND m.sequence BETWEEN ? AND ? ORDER BY m.sequence LIMIT ?`)
        .all(
          job.conversation_id,
          Number(anchor.seq) - 30,
          Number(anchor.seq) + 30,
          limit,
        ) as Omit<Candidate, "member">[]
    }
    // Native/imported buckets have no E turn anchor. Search the actual event day in M.
    if (typeof mem.memory_date !== "string")
      throw new BindError(
        "该桶缺少发生日期和 E 回合线索，无法定位候选原文。",
        "source_unavailable",
      )
    const r = await m.sourceSearch({
      date_from: mem.memory_date,
      date_to: mem.memory_date,
      limit,
    })
    if (!r.ok)
      throw new BindError(`检索候选原文失败（${r.code}，HTTP ${r.httpStatus}）`)
    if (!Array.isArray(r.result.hits))
      throw new BindError("Mariposa 未返回候选消息。")
    return r.result.hits
      .map((h) => {
        if (
          typeof h.message_id !== "string" ||
          typeof h.conversation_id !== "string" ||
          typeof h.sequence !== "number" ||
          typeof h.content_hash !== "string"
        )
          throw new BindError(
            "候选原文缺少消息标识或版本指纹。",
            "source_unavailable",
          )
        return {
          id: h.message_id,
          room: h.conversation_id,
          sequence: h.sequence,
          providerId: h.provider_message_id,
          parentId: h.parent_provider_message_id,
          speaker: h.speaker_display ?? h.normalized_sender,
          at: h.created_at ?? h.occurred_date,
          text: h.text ?? h.excerpt ?? "",
          member: {
            source_message_id: h.message_id,
            content_hash: h.content_hash,
          },
        }
      })
      .sort((a, b) => a.room.localeCompare(b.room) || a.sequence - b.sequence)
  }
  private notifyCredentialIssue(reason: string) {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(new Date())
    const text = `来源绑定判断服务发生凭据或余额错误：${reason}。处理后可在日历里点击「DS 重算」。`
    const result = this.db
      .prepare(`INSERT INTO host_notices(id,conversation_id,kind,payload_json,dedupe_key,created_at)
      VALUES(?,'primary','source_bind_credential',?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(
        genId("ntc"),
        JSON.stringify({ text }),
        "bind-credential-alert:" + day,
        new Date().toISOString(),
      )
    if (result.changes)
      this.deps.events?.publish("system.notice", {
        conversationId: "primary",
        turnId: null,
        scope: "private",
        payload: { source: "source_bind", text, day },
      })
  }
}
