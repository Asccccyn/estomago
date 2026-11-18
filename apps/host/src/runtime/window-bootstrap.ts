import { coverageRanges } from '../memory-surfacing/window-coverage.ts';
import type { CoverageRange } from '../capabilities/contracts.ts';
import { sha256Hex } from '../util/id.ts';
import { speakerLabelsFromConfig } from '../identity/speaker-labels.ts';
// 窗口开窗资料（Mariposa bootstrap B 段）分页装配机——R3（2026-11-07）纯搬迁自
// supervisor.ts：与聊天主链零共享状态，独立缓存与分页协议（SNAPSHOT_STALE 整包重建、
// 瞬时全局失败一次、完整成功才进缓存）。行为逐字保留。
// 开窗"运行中事项"片段（宿主用户 2026-11-07 裁定：开窗定格、随开窗包冻结、预算 3 条、
// 近期引用热度排序）：与 B 段同生命周期缓存（同 transferPending/delete），独立取数，
// 失败冻结为空（每窗一次告警，不阻塞开窗）。
import { bootstrapCall, completeBootstrapPages, BootstrapPagingError, globalBootstrapFailure, retryableBootstrapFailure, type BootstrapGap } from '../integrations/mariposa/bootstrap-pages.ts';
import { renderEpisodeFragment, EPISODE_FRAGMENT_BUDGET, type FragmentEpisode } from './episode-fragment.ts';
import type { SupervisorDeps } from './supervisor.ts';

// R10（复审 2026-10-07）：bootstrap 受控截止时间——准备阶段不无限挂起
export const BOOTSTRAP_DEADLINE_MS = 8000;

export type EpisodeListPort = {
  /** 返回形状=MariposaCallResult（{ok:true,result}）；result 内含 episodes/has_more */
  list(args: { scopeId: string; states?: string[]; limit?: number }, signal?: AbortSignal): Promise<{ ok: boolean; result?: { episodes?: FragmentEpisode[]; has_more?: boolean }; code?: string }>;
};

export type BootstrapMachineDeps = Pick<SupervisorDeps, 'bootstrap' | 'events' | 'alerts' | 'config' | 'wishstar'> & {
  episodes?: EpisodeListPort | null;
};

export class WindowBootstrapMachine {
  private byWindow = new Map<string, { text: string; ranges: CoverageRange[]; complete: boolean }>();
  private episodeFragmentByWindow = new Map<string, string>();

  private readonly d: BootstrapMachineDeps;

  constructor(d: BootstrapMachineDeps) {
    this.d = d;
  }

  /** pending:<conversationId> 键的开窗资料随窗口落地转移（换窗/建窗后调用） */
  transferPending(pendingKey: string, windowId: string): void {
    const pending = this.byWindow.get(pendingKey);
    if (pending !== undefined) {
      this.byWindow.set(windowId, pending);
      this.byWindow.delete(pendingKey);
    }
    const pendingFragment = this.episodeFragmentByWindow.get(pendingKey);
    if (pendingFragment !== undefined) {
      this.episodeFragmentByWindow.set(windowId, pendingFragment);
      this.episodeFragmentByWindow.delete(pendingKey);
    }
  }

  take(key: string): string | undefined {
    const value = this.byWindow.get(key);
    return value?.complete ? value.text : undefined;
  }

  coverageFor(key: string, messages: readonly { role: string; content: unknown }[]): { window_coverage: CoverageRange[]; window_coverage_block: string } | null {
    const opening = this.byWindow.get(key);
    if (!opening?.ranges.length) return null;
    for (const message of messages) {
      if (message.role !== 'system') continue;
      const texts = typeof message.content === 'string' ? [message.content] :
        Array.isArray(message.content) ? message.content.filter(block => block?.type === 'text').map(block => block.text) : [];
      for (const text of texts) {
        if (typeof text === 'string' && (text === opening.text || text.startsWith(opening.text + '\n'))) {
          return { window_coverage: opening.ranges, window_coverage_block: sha256Hex(text) };
        }
      }
    }
    return null;
  }

  /** 本窗冻结的"运行中事项"片段；null=该窗无片段（未接线/失败冻结/无未了结——内部空串归一为 null） */
  episodeFragmentFor(key: string): string | null {
    const v = this.episodeFragmentByWindow.get(key);
    return v && v.length > 0 ? v : null;
  }

  delete(key: string): void {
    this.byWindow.delete(key);
    this.episodeFragmentByWindow.delete(key);
  }

  async windowBootstrap(windowId: string, signal?: AbortSignal, scopeId?: string): Promise<string | null> {
    if (signal?.aborted) return null;
    // episode 片段取数纳入与 B 同一准备生命周期（Codex 审计 P1）：共用父取消
    // 与 BOOTSTRAP_DEADLINE_MS 截止——父取消/截止后不取、不冻结（下轮重拉）。
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS)]) : AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS);
    const t = this.take(windowId);
    if (t !== undefined) {
      if (this.episodeFragmentByWindow.has(windowId) || !scopeId) return t;
      // B 已有缓存但片段尚未冻结——独立补取后返回缓存（每窗一次）
      await this.freezeEpisodeFragment(windowId, scopeId, lifetime);
      return t;
    }
    if (!this.d.bootstrap) return await this.fetchBootText(windowId, signal); // 未接线：如实无 B（也不取片段）
    const text = await this.fetchBootText(windowId, signal);
    if (lifetime.aborted) return text; // 父取消/截止：片段不冻结，下轮重拉
    if (scopeId) await this.freezeEpisodeFragment(windowId, scopeId, lifetime); // 结论路径统一冻结（含部分交付/不可用）
    return text;
  }

  /** 宿主用户 2026-11-07 裁定：开窗时取"运行中事项"前 3 条（M 侧近期引用热度排序），
   *  渲染为独立片段随窗冻结；失败/无未了结冻结为空（每窗一次告警，不阻塞开窗）。 */
  private async freezeEpisodeFragment(windowId: string, scopeId: string, lifetime: AbortSignal): Promise<void> {
    if (this.episodeFragmentByWindow.has(windowId)) return;
    const port = this.d.episodes;
    if (!port) {
      this.episodeFragmentByWindow.set(windowId, '');
      return;
    }
    try {
      // Codex 审计 P0 修复：消费真实客户端合同 {ok:true,result}（此前误读 data，
      // 成功响应被当空冻结——生产片段从未生效）
      const res = await port.list({ scopeId, states: ['OPEN', 'QUIESCENT'], limit: EPISODE_FRAGMENT_BUDGET }, lifetime);
      if (lifetime.aborted) return; // 迟到成功：不冻结，下轮重取（复审 R1）
      if (!res?.ok) throw new Error('EPISODE_LIST_UNAVAILABLE');
      const episodes = (res.result?.episodes ?? []) as FragmentEpisode[];
      const fragment = renderEpisodeFragment(episodes, res.result?.has_more === true);
      this.episodeFragmentByWindow.set(windowId, fragment ?? '');
    } catch {
      // 生命周期判定不看异常形态（AbortError/TimeoutError/非 Error reason 一律同判）：
      // 取消/截止引发的失败不冻结、不告警——下轮重取（复审 R1）
      if (lifetime.aborted) return;
      this.d.events.publish('context.warning', { conversationId: scopeId, entityRef: windowId, scope: 'private', payload: { source: 'episode-fragment', code: 'EPISODE_FRAGMENT_UNAVAILABLE', note: '运行中事项片段未取得——本窗不带该段（不阻塞开窗）' } });
      this.episodeFragmentByWindow.set(windowId, '');
    }
  }

  private async fetchBootText(windowId: string, signal?: AbortSignal): Promise<string | null> {
    const d = this.d;
    const mc = d.bootstrap ?? null; // P04.5/P18(S18)：窄端口；夹具一律显式注入（回退已删）
    if (!mc) return null; // 未接线：如实无 B
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS)]) : AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS);
    const startedAt = performance.now();
    const moodBudgetMs = (): number => Math.max(0, Math.floor(BOOTSTRAP_DEADLINE_MS - (performance.now() - startedAt) - 1700));
    const dedupeKey = `bootstrap:${windowId}`;
    const UNAVAILABLE_TEXT = 'Mariposa开窗资料未取得，I、计划及记忆资料状态未知；不表示记忆不存在';
    const report = (gaps: BootstrapGap[], code = 'BOOTSTRAP_UNAVAILABLE'): void => {
      const unavailable = gaps.length === 0;
      const critical = unavailable || gaps.some(gap => gap.section === 'i');
      const note = unavailable
        ? UNAVAILABLE_TEXT
        : gaps.some(gap => gap.section === 'i')
          ? 'I 当前的话未全载；其他已复核资料已保留，本次资料不完整'
          : '部分开窗资料未全载；失败的心情全文未注入，其他已复核资料已保留';
      d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'bootstrap', code: unavailable ? code : (gaps[0]?.code ?? 'unknown'), section: unavailable ? 'bootstrap' : gaps[0]?.section, note } });
      d.alerts?.observe({ code: 'BOOTSTRAP_INCOMPLETE', severity: critical ? 'critical' : 'warning', scopeKind: 'integration', scopeId: 'mariposa', dedupeKey, observationId: null,
        safeSummary: { title: '开窗资料不完整', detail: note, reason: gaps.map(gap => gap.code).join(',') || code, count: gaps.length, window_id: windowId, retryable: gaps.some(gap => gap.retryable) } });
    };
    // SNAPSHOT_STALE invalidates every dependent field. Rebuild once from a new
    // first page, never splice a replacement snapshot into an existing attempt.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const first = await bootstrapCall(s => mc.bootstrapGet(s), { signal: lifetime });
        if (first.plans != null && (typeof first.plans !== 'object' || Array.isArray(first.plans)
          || (first.plans as { items?: unknown }).items !== undefined && (!Array.isArray((first.plans as { items?: unknown[] }).items) || ((first.plans as { items?: unknown[] }).items ?? []).some(item => !item || typeof item !== 'object' || Array.isArray(item))))) {
          throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', 'bootstrap');
        }
        const snapId = typeof first.snapshot_id === 'string' && first.snapshot_id ? first.snapshot_id : null;
        const gaps: BootstrapGap[] = [];
        // —— I（current words）：畸形值=critical 局部缺口（不启续取）；续取失败整段丢弃 ——
        let iText: string | null = null;
        let iNote = '';
        const iRaw = (first as Record<string, unknown>).i as unknown;
        if (iRaw != null) {
          const bad = (v: unknown): boolean => v === null || typeof v !== 'object' || Array.isArray(v) || typeof (v as { content?: unknown }).content !== 'string';
          if (bad(iRaw)) {
            gaps.push({ section: 'i', code: 'BOOTSTRAP_SHAPE_INVALID', retryable: false });
            iText = null;
          } else {
            const iSec = iRaw as { content: string; truncated?: unknown; total_chars?: unknown; next_cursor?: Record<string, unknown> | null };
            iText = iSec.content;
            const iLoaded = Array.from(iText).length;
            const iTotal = typeof iSec.total_chars === 'number' ? iSec.total_chars : null;
            if (iSec.truncated === true && iSec.next_cursor == null) {
              gaps.push({ section: 'i', code: 'BOOTSTRAP_CURSOR_MISSING', retryable: false });
              iNote = '（超窗未全载：续取未完成）';
            } else if (iSec.next_cursor != null) {
              if (!snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISSING', 'i');
              const seenOffsets = new Set<number>();
              let iCur: Record<string, unknown> | null = iSec.next_cursor ?? null;
              let loaded = iLoaded;
              let guard = 0;
              while (iCur != null && guard < 64) {
                guard++;
                const offset = (iCur as { i_offset?: unknown }).i_offset;
                if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset !== loaded || seenOffsets.has(offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                seenOffsets.add(offset);
                try {
                  const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, iCur!, 'i', sg), { signal: lifetime, section: 'i' });
                  if (typeof page.offset !== 'number' || page.offset !== loaded) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                  if (page.snapshot_id !== snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISMATCH', 'i');
                  if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', 'i');
                  if (page.section !== 'i') throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', 'i');
                  if (typeof page.content !== 'string' || page.content.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', 'i');
                  if (typeof page.total_chars !== 'number' || !Number.isSafeInteger(page.total_chars) || page.total_chars < 0 || (iTotal != null && page.total_chars !== iTotal)) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', 'i');
                  if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', 'i');
                  const cpLen = Array.from(page.content).length;
                  const endOffset = loaded + cpLen;
                  if (endOffset > page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', 'i');
                  const upcoming = page.next_cursor as Record<string, unknown> | null;
                  if (upcoming != null) {
                    const noff = (upcoming as { i_offset?: unknown }).i_offset;
                    if (typeof noff !== 'number' || noff !== endOffset) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                    if (seenOffsets.has(noff)) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_REPEATED', 'i');
                  } else if (endOffset !== page.total_chars) {
                    throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', 'i');
                  }
                  // 全部校验通过才拼接——坏页的尾巴不得进入已载前缀
                  iText += page.content;
                  loaded = endOffset;
                  iCur = upcoming;
                } catch (err) {
                  if (!(err instanceof BootstrapPagingError)) throw err;
                  if (globalBootstrapFailure(err)) throw err;
                  gaps.push({ section: 'i', code: err.code, retryable: retryableBootstrapFailure(err) });
                  iNote = `（超窗未全载：续取未完成，已载 ${Array.from(iText ?? '').length}字）`;
                  break;
                }
              }
            }
          }
        }
        // —— 事件/我们的话（每桶独立局部缺口；全局失败上抛整包重建）——
        const dayItems = ((((first as Record<string, unknown>).memory_days as Record<string, unknown> | undefined)?.items ?? []) as Array<Record<string, unknown>>).map(item => ({ ...item }));
        const readTextSection = async (item: Record<string, unknown>, field: 'event_text' | 'our_words'): Promise<void> => {
          const memId = item.memory_id;
          const curKey = `${field}_next`; const truncKey = `${field}_truncated`; const totalKey = field === 'event_text' ? 'event_text_total_chars' : 'our_words_total_items';
          let cur = item[curKey] as Record<string, unknown> | undefined | null;
          if (item[truncKey] === true && cur == null) {
            gaps.push({ section: field, ...(typeof memId === 'string' ? { memoryId: memId } : {}), code: 'BOOTSTRAP_CURSOR_MISSING', retryable: false });
            item.__bootNote = `[${field === 'event_text' ? '事件正文' : '我们的话'}分节未全载（续取游标缺失）]`;
            delete item[truncKey];
            return;
          }
          if (cur == null) return;
          if (!snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISSING', field);
          try {
            if (field === 'event_text') {
              let text = typeof item.event_text === 'string' ? item.event_text : '';
              let loaded = Array.from(text).length;
              const total0 = item.event_text_total_chars;
              let total = typeof total0 === 'number' && Number.isSafeInteger(total0) ? total0 : null;
              const seen = new Set<number>();
              let guard = 0;
              while (cur != null && guard < 64) {
                guard++;
                if (cur.memory_id !== memId || cur.field !== field || typeof cur.offset !== 'number' || cur.offset !== loaded || seen.has(cur.offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                seen.add(cur.offset);
                const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, cur as Record<string, unknown>, 'memory_item', sg), { signal: lifetime, section: field });
                if (page.snapshot_id !== snapId || page.section !== 'memory_item' || page.memory_id !== memId || page.field !== field) throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', field);
                if (field === 'event_text' && (typeof page.offset !== 'number' || page.offset !== loaded)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', field);
                if (typeof page.content !== 'string' || page.content.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', field);
                if (typeof page.total_chars !== 'number' || !Number.isSafeInteger(page.total_chars) || (total != null && page.total_chars !== total)) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', field);
                const cpLenE = Array.from(page.content).length;
                const endE = loaded + cpLenE;
                if (endE > page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                const upcoming = page.next_cursor as Record<string, unknown> | null;
                if (upcoming != null) {
                  if (upcoming.memory_id !== memId || upcoming.field !== field || upcoming.offset !== endE) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                  if (seen.has(upcoming.offset as number)) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_REPEATED', field);
                } else if (endE !== page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
                // 全部校验通过才拼接
                total = page.total_chars;
                text += page.content;
                loaded = endE;
                cur = upcoming;
              }
              if (total != null && loaded !== total) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
              item.event_text = text;
              delete item[curKey]; delete item[truncKey];
            } else {
              const groups = Array.isArray(item.our_words) ? (item.our_words as Array<{ speaker?: string; texts?: unknown[] }>) : [];
              let flat: Array<{ speaker?: string; text: string }> = [];
              const wordRanges = coverageRanges(item.our_words_coverage);
              for (const g of groups) {
                if (!g || typeof g !== 'object') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                if (g.texts !== undefined && !Array.isArray(g.texts)) throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                for (const wt of g.texts ?? []) {
                  if (typeof wt !== 'string') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                  flat.push({ speaker: g.speaker, text: wt });
                }
              }
              const total0 = item.our_words_total_items;
              let total = typeof total0 === 'number' && Number.isSafeInteger(total0) ? total0 : null;
              const seenIdx = new Set<number>();
              let itemOffset = flat.length;
              const cursor0 = cur as { item_offset?: unknown; char_offset?: unknown };
              if (cursor0.item_offset !== itemOffset || cursor0.char_offset !== 0) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
              let guard = 0;
              while (cur != null && guard < 64) {
                guard++;
                const co = cur as { item_offset?: unknown; char_offset?: unknown };
                if (typeof co.item_offset !== 'number' || co.item_offset !== itemOffset || typeof co.char_offset !== 'number' || seenIdx.has(co.item_offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                seenIdx.add(co.item_offset);
                const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, cur as Record<string, unknown>, 'memory_item', sg), { signal: lifetime, section: field });
                if (page.snapshot_id !== snapId || page.section !== 'memory_item' || page.memory_id !== memId || page.field !== field) throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', field);
                if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', field);
                wordRanges.push(...coverageRanges(page.coverage_ranges));
                if (!Array.isArray(page.items) || page.items.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', field);
                for (const g of page.items as Array<{ speaker?: string; texts?: unknown[] }>) {
                  for (const wt of g?.texts ?? []) {
                    if (typeof wt !== 'string') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                    flat.push({ speaker: g.speaker, text: wt });
                  }
                }
                itemOffset += page.items.length;
                if (typeof page.total_items === 'number' && Number.isSafeInteger(page.total_items)) {
                  if (total != null && page.total_items !== total) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                  total = page.total_items;
                }
                if (total != null && itemOffset > total) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', field);
                const upcoming = page.next_cursor as Record<string, unknown> | null;
                if (upcoming != null) {
                  const u = upcoming as { item_offset?: unknown; char_offset?: unknown };
                  if (u.item_offset !== itemOffset || u.char_offset !== 0) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                } else if (total != null && itemOffset !== total) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
                cur = upcoming;
              }
              // 重组为分组形状（渲染层沿用分组）
              const regrouped: Array<{ speaker?: string; texts: string[] }> = [];
              for (const w of flat) {
                const lastG = regrouped[regrouped.length - 1];
                if (lastG && lastG.speaker === w.speaker) lastG.texts.push(w.text);
                else regrouped.push({ speaker: w.speaker, texts: [w.text] });
              }
              item.our_words = regrouped;
              item.our_words_coverage = wordRanges;
              delete item[curKey]; delete item[truncKey];
            }
          } catch (err) {
            if (!(err instanceof BootstrapPagingError)) throw err;
            if (globalBootstrapFailure(err)) throw err;
            gaps.push({ section: field, ...(typeof memId === 'string' ? { memoryId: memId } : {}), code: err.code, retryable: retryableBootstrapFailure(err) });
            // 续取失败：保留已载前缀+如实披露游标（不静默当全文）；初值本就缺段则只留披露行
            const nextKey = field === 'event_text' ? 'event_text_next' : 'our_words_next';
            item.__bootNote = `[${field === 'event_text' ? '事件正文' : '我们的话'}分节未全载（${nextKey} 续取未完成）]`;
            delete item[curKey]; delete item[truncKey];
          }
        };
        for (const item of dayItems) {
          await readTextSection(item, 'event_text');
          await readTextSection(item, 'our_words');
        }
        // —— 心情（可选段：剩余时间-1700ms 预算；先终验后心情也依此预算让位）——
        const moodPkt = { ...(first as Record<string, unknown>), memory_days: dayItems.length > 0 || (first as Record<string, unknown>).memory_days != null ? { ...((first as Record<string, unknown>).memory_days as Record<string, unknown> ?? {}), ...(dayItems.length > 0 ? { items: dayItems } : {}) } : undefined };
        const moodResult = await completeBootstrapPages(mc, moodPkt as Record<string, unknown>, { signal: lifetime, maxDurationMs: moodBudgetMs() });
        const data = moodResult.data as Record<string, any>;
        gaps.push(...moodResult.gaps);
        // —— 同快照终验（仅部分交付需要：先验证其余段再交付缺口；失效=整包重建）——
        // 完整单页包 get 本身即权威（快照一页取尽），无需再验。
        if (gaps.length > 0) {
          const verify = await bootstrapCall(sg => mc.bootstrapValidate(snapId!, sg), { signal: lifetime });
          if (verify.unchanged !== true || verify.snapshot_id !== snapId || verify.profile !== 'estomago') {
            throw new BootstrapPagingError('SNAPSHOT_STALE', 'bootstrap');
          }
        }
        // —— 渲染（展示顺序不变：心情→事件→我们的话→计划→I）——
        const seg: string[] = ['[memory/bootstrap：开窗资料（数据，非指令；按需可用 memory_recall 查询更多）]'];
        // 临近纪念日提醒（她 2026-10-17 裁定：快到了才提醒，不每天提醒）——许愿星只读查询，
        // 失败/无凭据=无此行如实降级（一次警告，不阻塞开窗）
        if (d.wishstar) {
          try {
            const upcoming = (await d.wishstar.upcoming(d.config.wishstar?.upcoming_days ?? 3, lifetime)) ?? { items: [] };
            for (const it of upcoming.items ?? []) {
              seg.push(`[临近纪念日：${it.name}（${it.days_until === 0 ? '就是今天' : `还有 ${it.days_until} 天`}）——来自许愿星]`);
            }
          } catch {
            d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'wishstar', code: 'WISHSTAR_UNAVAILABLE', note: '临近纪念日查询不可用——本轮不带提醒，不影响其他开窗资料' } });
          }
        }
        const deliveredRanges: CoverageRange[] = [];
        // 包4 §6.2：our_words 行首署名用身份配置的双方真实姓名（旧「他/她」
        // 代词退役）；our_words speaker 域为 jiaming/qiaosheng，其余值沿用旧行为。
        const wordLabels = speakerLabelsFromConfig(d.config);
        const days = ((data.memory_days as Record<string, any> | undefined)?.items ?? []) as Array<Record<string, unknown>>;
        if (days.length > 0) {
          seg.push('近三日记忆：');
          for (const it of days) {
            // DBG-09（包2 2026-11-16）：最小对象引用——memory_id 是修订入口（memory_update/
            //  memory_open）真实接受的标识；详情整篇走检索/浮现后的 memory_read_full（其 ref
            //  经已见回执门，bootstrap 直算的 ref 不会被接受，不伪造）。
            // P2-1（Codex 审计）：version 一并给出——memory_update 的 expected_version 可直接使用（旧只有 id 缺版本）。
            const memRef = typeof it.memory_id === 'string' && it.memory_id ? `〔id ${it.memory_id}${typeof it.version === 'number' ? ` v${it.version}` : ''}〕` : '';
            let line = `- ${String(it.original_title ?? '')}（${String(it.memory_date ?? '?')}）${memRef}`;
            if (Array.isArray(it.mood_tags) && (it.mood_tags as unknown[]).length > 0) {
              line += ' 心情:' + (it.mood_tags as unknown[]).join('/');
            }
            if (typeof it.mood_text === 'string' && it.mood_text.length > 0) {
              line += `（心情文字：${it.mood_text}）`;
            }
            seg.push(line);
            if (typeof it.event_text === 'string' && it.event_text.length > 0) {
              seg.push(`  事件：${it.event_text}`);
              if (typeof it.memory_id === 'string' && Number.isSafeInteger(it.version)) {
                deliveredRanges.push({ resource_ref: `memory:${it.memory_id}`, content_version: String(it.version),
                  start_char: 0, end_char: Array.from(it.event_text).length });
              }
            }
            deliveredRanges.push(...coverageRanges(it.our_words_coverage));
            const words0 = it.our_words as unknown;
            for (const g of Array.isArray(words0) ? (words0 as Array<{ speaker?: string; texts?: unknown[] }>) : []) {
              for (const wt of g?.texts ?? []) if (typeof wt === 'string') seg.push(`  ${g?.speaker === 'jiaming' ? wordLabels.assistant : g?.speaker === 'qiaosheng' ? wordLabels.owner : '她'}：${wt}`);
            }
            if (typeof it.__bootNote === 'string') seg.push(`  ${it.__bootNote}`);
          }
        }
        const plansSec = data.plans as Record<string, any> | undefined;
        let plans = ((plansSec?.items ?? []) as Array<Record<string, unknown>>);
        // DBG-10（包2 2026-11-16）：计划对账——旧实现见 next_cursor 非空就打"还有更多"，
        // 从不对比 total 也不续取，打出过"已载 2/2"自相矛盾文案。先沿既有续页能力取尽
        // （有界：≤5 页/≤100 条），再按 total/cursor 对账如实披露。
        // P1-6（Codex 审计）：M 真实包形——首页 items/next_cursor 在 plans 节内；续页
        // bootstrapNext 返回**顶层** items/next_cursor；末页 cursor 形如 {plans_offset:null}
        // （字段全 null=取尽，旧实现把任意非空对象当有效 cursor，且只读 page.plans 拿到空数组
        // 即"看似取尽"——实测 51 条计划丢第 51 条且无提示）。
        const cursorOf = (sec: Record<string, any> | null | undefined): Record<string, unknown> | null => {
          const nc = sec?.next_cursor;
          if (nc == null || typeof nc !== 'object') return null;
          return Object.values(nc as Record<string, unknown>).some((v) => v != null) ? (nc as Record<string, unknown>) : null;
        };
        let plansCursor = cursorOf(plansSec);
        let plansPages = 0;
        while (plansCursor != null && plansPages < 5 && plans.length < 100 && snapId) {
          try {
            const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, plansCursor as Record<string, unknown>, 'plans', sg), { signal: lifetime, section: 'plans' });
            const pageSec = (page.plans ?? page) as Record<string, any>;
            plans = plans.concat(((pageSec.items ?? []) as Array<Record<string, unknown>>));
            plansCursor = cursorOf(pageSec);
            plansPages += 1;
          } catch {
            plansCursor = null; // 续页失败：按已载如实披露，不阻塞开窗
            seg.push(`[计划还有更多未载入（已载 ${plans.length} 条；续页读取失败可能不全）——按需可用 plans_read 查询]`);
            break;
          }
        }
        if (plans.length > 0) {
          seg.push('计划：');
          for (const pl of plans) {
            const detail = typeof pl.detail === 'string' && pl.detail.length > 0 ? `（${pl.detail}）` : '';
            // DBG-09：plan_id/version 供 plans_read/plans_write(complete/cancel/update) 直接使用
            const planRef = typeof pl.plan_id === 'string' && pl.plan_id ? `〔${pl.plan_id}${typeof pl.version === 'number' ? ` v${pl.version}` : ''}〕` : '';
            seg.push(`- ${String(pl.title ?? '')}${detail}${planRef}`);
          }
        }
        const plansTotal = typeof plansSec?.total === 'number' ? plansSec.total : null;
        if (plansCursor != null) {
          // 仍未取尽（达有界上限）：如实披露已载数与续读入口
          seg.push(`[计划还有更多未载入（已载 ${plans.length}${plansTotal != null ? '/' + plansTotal : ''} 条；续页有界未取尽）——按需可用 plans_read 查询]`);
        } else if (plansTotal != null && plansTotal > plans.length) {
          // cursor 已尽但 total 对不上（M 计数与实收不一致）：如实披露，不冒充完整
          seg.push(`[计划总数对不上：已收 ${plans.length} 条，M 报告共 ${plansTotal} 条——可用 plans_read 核对]`);
        }
        if (typeof iText === 'string' && iText.length > 0) seg.push(`I（当前的话）：${iText}${iNote}〔条目与修订可用 memory_i_read 读取〕`);
        else if (gaps.some(gap => gap.section === 'i')) seg.push('[I 当前的话未全载；其余已复核资料保留]');
        const moodGaps = gaps.filter(gap => gap.section === 'mood_text');
        if (moodGaps.length > 0) seg.push('[部分开窗资料未全载：心情文字未全载（该条心情全文未注入）；其他已复核资料已保留]');
        if (seg.length === 1) {
          // 空包（无任何资料段）：如实无 B——不注入占位文本、不告警、不缓存
          if (gaps.length > 0) report(gaps);
          return null;
        }
        const text = seg.join('\n');
        this.byWindow.set(windowId, { text, ranges: deliveredRanges, complete: gaps.length === 0 });
        if (gaps.length > 0) {
          report(gaps);
          return text; // 部分交付：如实披露；已入缓存但 complete=false（6895224：coverageFor 按实际交付计账），take 不放行，下次重建
        }
        d.alerts?.resolve(dedupeKey, { summary: {} });
        return text;
      } catch (err) {
        if (err instanceof BootstrapPagingError && err.code === 'BOOTSTRAP_CANCELLED') return null; // 父 Stop：静默，无告警无缓存
        if (err instanceof BootstrapPagingError && err.code === 'BOOTSTRAP_DEADLINE_EXCEEDED') {
          report([], 'BOOTSTRAP_DEADLINE_EXCEEDED');
          return UNAVAILABLE_TEXT;
        }
        if (!(err instanceof BootstrapPagingError)) throw err;
        if (attempt < 1 && (err.code === 'SNAPSHOT_STALE' || retryableBootstrapFailure(err))) continue; // 整包重建一次（仅快照失效/瞬时；授权拒绝重建无意义）
        report([], err.code);
        return UNAVAILABLE_TEXT;
      }
    }
    return null;
  }
}
