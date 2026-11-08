// 窗口开窗资料（Mariposa bootstrap B 段）分页装配机——R3（2026-11-07）纯搬迁自
// supervisor.ts：与聊天主链零共享状态，独立缓存与分页协议（SNAPSHOT_STALE 整包重建、
// 瞬时全局失败一次、完整成功才进缓存）。行为逐字保留。
import { bootstrapCall, completeBootstrapPages, BootstrapPagingError, globalBootstrapFailure, retryableBootstrapFailure, type BootstrapGap } from '../integrations/mariposa/bootstrap-pages.ts';
import type { SupervisorDeps } from './supervisor.ts';

// R10（复审 2026-10-07）：bootstrap 受控截止时间——准备阶段不无限挂起
export const BOOTSTRAP_DEADLINE_MS = 8000;

export type BootstrapMachineDeps = Pick<SupervisorDeps, 'bootstrap' | 'events' | 'alerts' | 'config' | 'wishstar'>;

export class WindowBootstrapMachine {
  private byWindow = new Map<string, string>();

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
  }

  take(key: string): string | undefined {
    return this.byWindow.get(key);
  }

  delete(key: string): void {
    this.byWindow.delete(key);
  }

  async windowBootstrap(windowId: string, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    let t = this.byWindow.get(windowId);
    if (t !== undefined) return t;
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
        const days = ((data.memory_days as Record<string, any> | undefined)?.items ?? []) as Array<Record<string, unknown>>;
        if (days.length > 0) {
          seg.push('近三日记忆：');
          for (const it of days) {
            let line = `- ${String(it.original_title ?? '')}（${String(it.memory_date ?? '?')}）`;
            if (Array.isArray(it.mood_tags) && (it.mood_tags as unknown[]).length > 0) {
              line += ' 心情:' + (it.mood_tags as unknown[]).join('/');
            }
            if (typeof it.mood_text === 'string' && it.mood_text.length > 0) {
              line += `（心情文字：${it.mood_text}）`;
            }
            seg.push(line);
            if (typeof it.event_text === 'string' && it.event_text.length > 0) seg.push(`  事件：${it.event_text}`);
            const words0 = it.our_words as unknown;
            for (const g of Array.isArray(words0) ? (words0 as Array<{ speaker?: string; texts?: unknown[] }>) : []) {
              for (const wt of g?.texts ?? []) if (typeof wt === 'string') seg.push(`  ${g?.speaker === 'jiaming' ? '他' : '她'}：${wt}`);
            }
            if (typeof it.__bootNote === 'string') seg.push(`  ${it.__bootNote}`);
          }
        }
        const plansSec = data.plans as Record<string, any> | undefined;
        const plans = ((plansSec?.items ?? []) as Array<Record<string, unknown>>);
        if (plans.length > 0) {
          seg.push('计划：');
          for (const pl of plans) {
            const detail = typeof pl.detail === 'string' && pl.detail.length > 0 ? `（${pl.detail}）` : '';
            seg.push(`- ${String(pl.title ?? '')}${detail}`);
          }
        }
        if (plansSec?.next_cursor != null) {
          const total = typeof plansSec.total === 'number' ? plansSec.total : null;
          seg.push(`[计划还有更多未载入（plans 续页未取；已载 ${plans.length}${total != null ? '/' + total : ''} 条）——按需可用 plans_read 查询]`);
        }
        if (typeof iText === 'string' && iText.length > 0) seg.push(`I（当前的话）：${iText}${iNote}`);
        else if (gaps.some(gap => gap.section === 'i')) seg.push('[I 当前的话未全载；其余已复核资料保留]');
        const moodGaps = gaps.filter(gap => gap.section === 'mood_text');
        if (moodGaps.length > 0) seg.push('[部分开窗资料未全载：心情文字未全载（该条心情全文未注入）；其他已复核资料已保留]');
        if (seg.length === 1) {
          // 空包（无任何资料段）：如实无 B——不注入占位文本、不告警、不缓存
          if (gaps.length > 0) report(gaps);
          return null;
        }
        const text = seg.join('\n');
        if (gaps.length > 0) {
          report(gaps);
          return text; // 部分交付：如实披露，不进缓存（下次重试）
        }
        this.byWindow.set(windowId, text);
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
