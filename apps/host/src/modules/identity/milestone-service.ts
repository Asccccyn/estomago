// modules/identity/milestone-service.ts（P04.8）：identity_milestone_write 用例（与 Mariposa I 分开）。
import type { Db } from '../../db/connection.ts';
import { tx } from '../../db/connection.ts';
import type { IdentityService, MilestoneWriteReceipt } from '../../identity/service.ts';
import { IdentityService as IdentityServiceStatic } from '../../identity/service.ts';
import { sha256Hex } from '../../util/id.ts';
import type { HeartbeatReceipt, ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { recoverHeartbeatAnchorReceipt } from '../heartbeat/actions.ts';

function auditId(operationId: string): string {
  return `aud_${sha256Hex(operationId).slice(0, 24)}`;
}

function anchorHeartbeatReceipt(receipt: MilestoneWriteReceipt): HeartbeatReceipt {
  const { operationId, written } = receipt;
  return { operationId, status: 'committed', source: {
    namespace: 'host:identity', id: written.version.slice(0, written.version.lastIndexOf('-v')), revision: written.version,
  } };
}

export class IdentityMilestoneService {
  private readonly db: Db;
  private readonly identity: IdentityService | null;

  constructor(deps: { db: Db; identity?: IdentityService | null }) {
    this.db = deps.db;
    this.identity = deps.identity ?? null;
  }

  identityMilestoneWrite(args: { operation?: string; confirm_overwrite?: boolean; text?: string; item?: number; change_reason?: string; idempotency_key?: string }, ctx: ToolExecContext): ToolExecResult {
    if (!this.identity) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '身份服务未装配' } };
    // DBG-08（包2 2026-11-16）：operation 必须显式——旧实现缺省=write（整版替换），
    // {"operation":"write"} 单独可过 schema、漏 text 到实现层才拦；缺省/未知 op 直接拒绝。
    if (args.operation !== 'read' && args.operation !== 'write' && args.operation !== 'add' && args.operation !== 'revise' && args.operation !== 'remove') {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: 'operation 必填且必须显式（read/write/add/revise/remove）——write=整版替换，不允许缺省触发' } };
    }
    const op = args.operation;
    if (op === 'read') {
      try {
        const r = this.identity.readMilestone();
        const entries = IdentityServiceStatic.entryLines(r.text);
        // 1.2.3.4. 连续条号（=revise/remove 的 item 口径）；原文物理行号不外显
        return { ok: true, output: { version: r.version, entries: entries.length, text: entries.map((e, i) => `${i + 1}. ${e.line}`).join('\n') } };
      } catch (err) {
        return { ok: false, output: { error_code: 'MILESTONE_READ_FAILED', detail: String((err as Error).message).slice(0, 200) } };
      }
    }
    // 写类操作：change_reason/idempotency_key 必填；text 按 op 分（write/add/revise 必带，remove 不带）
    const needText = op === 'write' || op === 'add' || op === 'revise';
    if (typeof args.change_reason !== 'string' || args.change_reason.length === 0 || typeof args.idempotency_key !== 'string' || args.idempotency_key.length === 0) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: '写操作必须带 change_reason 与 idempotency_key' } };
    }
    if (needText && (typeof args.text !== 'string' || args.text.length === 0)) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: `${op} 必须带 text` } };
    }
    const { idempotency_key: key, change_reason: reason } = args;
    const identity = this.identity;
    const operationId = `milestone:v2:${sha256Hex(JSON.stringify(['jiaming', 'identity_milestone_write', key]))}`;
    const item = op === 'revise' || op === 'remove' ? args.item ?? null : null;
    const entryText = op === 'add' || op === 'revise' ? args.text!.replace(/[\r\n]+/g, ' ').trim() : null;
    const text = op === 'write' ? args.text! : entryText;
    const overwrite = op === 'write' && args.confirm_overwrite === true;
    const fingerprint = sha256Hex(JSON.stringify([op, item, text, overwrite, reason]));
    try {
      const write = (): ToolExecResult | null => tx(this.db, () => {
        // The manifest rename proves the file commit even if the audit
        // transaction was interrupted. Commit that recovery before replacing the marker.
        const last = identity.loadManifest().manifest?.milestone_write_receipt;
        if (last && this.auditReceipt(last)) {
          if (last.heartbeat) recoverHeartbeatAnchorReceipt(this.db, last.heartbeat.runId, last.heartbeat.callId, anchorHeartbeatReceipt(last));
          return null;
        }
        const previous = this.db.prepare('SELECT receipt_json FROM audit_events WHERE id=?').get(auditId(operationId));
        if (typeof previous?.receipt_json === 'string') {
          const receipt = JSON.parse(previous.receipt_json) as MilestoneWriteReceipt;
          if (receipt.fingerprint !== fingerprint) return { ok: false, output: { error_code: 'MILESTONE_IDEMPOTENCY_CONFLICT',
            detail: '这个操作键已用于另一项锚点改动。请先核对原操作，要执行新改动时再使用新键。' } };
          return this.success(receipt, ctx, true);
        }
        const legacy = this.previousLegacyWrite(ctx, key);
        if (legacy) return { ok: false, output: { error_code: 'MILESTONE_LEGACY_RECEIPT_UNVERIFIABLE',
          detail: `旧版已有此键的提交记录${legacy.scope ? `（${legacy.scope}）` : ''}，无法从旧回执核验本次参数。请先用 read 核对，确认是新操作才换键。` } };
        if (op === 'write' && !overwrite) {
          // Compare a multiset: renumbering is harmless, losing a duplicate is still a deletion.
          const content = (line: string) => line.replace(/^\s*\d+[.、）)]\s*/, '');
          const remaining = IdentityServiceStatic.entryLines(args.text!).map(e => content(e.line));
          const missing = IdentityServiceStatic.entryLines(identity.readMilestone().text).filter(e => {
            const at = remaining.indexOf(content(e.line));
            if (at < 0) return true;
            remaining.splice(at, 1);
            return false;
          });
          if (missing.length) return { ok: false, output: { error_code: 'MILESTONE_OVERWRITE_CONFIRMATION_REQUIRED',
            detail: `新版遗漏以下条目：${missing.map(e => e.line).join('\n')}\n保留这些内容，或显式 confirm_overwrite=true。旧窗无此参数时使用已支持的 add/revise/remove；否则保留待写正文并按现有流程换窗。` } };
        }
        const heartbeat = ctx.recordHeartbeatReceipt && ctx.backgroundRunId && ctx.toolCallId
          ? { runId: ctx.backgroundRunId, callId: ctx.toolCallId } : undefined;
        const commit = (written: MilestoneWriteReceipt['written']): MilestoneWriteReceipt =>
          ({ operationId, fingerprint, operation: op, reason: reason.slice(0, 200), written, ...(heartbeat ? { heartbeat } : {}) });
        const written = op === 'write' ? identity.updateMilestone(args.text!, commit) : identity.applyMilestoneEntryOp(op, item, text, commit);
        const receipt = commit(written);
        this.auditReceipt(receipt);
        return this.success(receipt, ctx, false);
      });
      let result: ToolExecResult | null;
      do { result = write(); } while (result === null);
      return result;
    } catch (err) {
      if (identity.loadManifest().manifest?.milestone_write_receipt?.operationId === operationId) {
        return { ok: false, output: { error_code: 'MILESTONE_WRITE_OUTCOME_UNKNOWN',
          detail: '锚点可能已提交。请使用相同参数和原操作键重试以读取原回执。' } };
      }
      return { ok: false, output: { error_code: 'MILESTONE_WRITE_FAILED', detail: String((err as Error).message).slice(0, 200) } };
    }
  }

  private previousLegacyWrite(ctx: ToolExecContext, key: string): {scope: string | null} | undefined {
    const prefix = ctx.turnId ? `milestone:${ctx.turnId}:` : `milestone:noturn:${ctx.requestId}:`;
    const rows = this.db.prepare(`SELECT scope, substr(detail_ref, ?) AS prior_key FROM audit_events
      WHERE who='jiaming' AND what='identity_milestone_write' AND receipt_json IS NULL AND substr(detail_ref,1,?)=?
      ORDER BY rowid DESC`).all(prefix.length + 1, prefix.length, prefix) as Array<{scope: string | null; prior_key: string}>;
    return rows.find(({ prior_key }) => (ctx.turnId ? prior_key.slice(prior_key.indexOf(':') + 1) : prior_key) === key);
  }

  private auditReceipt(receipt: MilestoneWriteReceipt): boolean {
    const { operationId, written, reason, operation } = receipt;
    const inserted = this.db.prepare(`INSERT INTO audit_events(id, who, what, scope, result, detail_ref, created_at, receipt_json)
      VALUES (?, 'jiaming', 'identity_milestone_write', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      auditId(operationId), written.version, `ok:${operation}:${written.byteSize}B:${reason}`,
      operationId, new Date().toISOString(), JSON.stringify(receipt),
    );
    return Number(inserted.changes) === 1;
  }

  private success(receipt: MilestoneWriteReceipt, ctx: ToolExecContext, duplicate: boolean): ToolExecResult {
    const { written, operation } = receipt;
    const heartbeatReceipt: HeartbeatReceipt = { ...anchorHeartbeatReceipt(receipt), ...(duplicate ? { replayed: true } : {}) };
    const result: ToolExecResult = { ok: true, output: { saved: true, operation, version: written.version, file: written.file,
      byte_size: written.byteSize, ...(written.entries !== undefined ? { entries: written.entries } : {}),
      effective: 'next_window', note: '当前窗继续旧版；下一扇新窗自动带新版', ...(duplicate ? { duplicate: true } : {}) },
      ...(ctx.recordHeartbeatReceipt ? { heartbeatReceipt } : {}) };
    if (!duplicate) ctx.recordHeartbeatReceipt?.(heartbeatReceipt);
    ctx.recordCommittedToolReceipt?.(result);
    return result;
  }
}
